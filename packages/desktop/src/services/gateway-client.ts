import { createHash } from 'node:crypto';
import tls from 'node:tls';
import { ALPN } from '@localtunnel/protocol';

/**
 * Client for a gateway's admin API.
 *
 * The API rides its own ALPN on port 443, and the gateway is authenticated by the
 * certificate fingerprint captured over SSH during installation — so this never
 * needs the gateway to have a domain name, and a hostile server on the same IP
 * cannot impersonate it.
 */

export interface GatewayConnection {
  host: string;
  port: number;
  adminToken: string;
  fingerprint: string;
}

export interface AdminResponse<T> {
  status: number;
  body: T;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

export async function adminFetch<T = unknown>(
  connection: GatewayConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // Checked before anything is dialled: the path is written into a raw request
  // line, so a CR or LF in it would be a second request smuggled in behind the
  // Authorization header this connection carries.
  if (!isSafeRequestTarget(path)) {
    throw new GatewayError('That request path is not valid.', 0);
  }
  const response = await rawRequest(connection, method, path, body);
  if (response.status === 401) {
    throw new GatewayError(
      'The gateway rejected this admin token. Re-add the gateway to refresh it.',
      401,
    );
  }
  if (response.status >= 400) {
    const detail =
      typeof response.body === 'object' && response.body && 'error' in response.body
        ? String((response.body as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new GatewayError(detail, response.status);
  }
  return response.body as T;
}

/**
 * Is this a request target we are willing to write into a raw request line?
 *
 * The admin request is assembled by hand, so anything outside the printable
 * ASCII a URL may contain — a CR or LF above all — would not be a path but a
 * second request, smuggled in behind the Authorization header this connection
 * already carries. Ids and hostnames reaching here come from a gateway's own
 * responses and from the renderer, neither of which is a place to be trusting.
 */
export function isSafeRequestTarget(path: string): boolean {
  return path.startsWith('/') && path.length <= 2048 && /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%[\]]+$/.test(path);
}

/**
 * One live, authenticated connection per gateway, reused across requests.
 *
 * Every admin call used to cost a fresh TCP connect plus a TLS handshake — two
 * extra round trips to the VPS before a byte of the request moved, on a path the
 * UI polls. The connection is kept open with keep-alive instead, requests are
 * serialised on it, and it is dropped the moment anything looks wrong.
 */
interface PooledConnection {
  socket: tls.TLSSocket;
  /** Resolves when the socket is ready to carry a request. */
  ready: Promise<void>;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  onData: ((chunk: Buffer) => void) | null;
  onClose: (() => void) | null;
}

const POOL = new Map<string, PooledConnection>();
/** Comfortably inside the gateway's own 65s keep-alive window. */
const IDLE_TIMEOUT_MS = 45_000;

function poolKey(connection: GatewayConnection): string {
  return `${connection.host}:${connection.port}:${connection.fingerprint}`;
}

function discard(key: string, conn: PooledConnection): void {
  if (POOL.get(key) === conn) POOL.delete(key);
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.onData = null;
  conn.onClose = null;
  conn.socket.removeAllListeners('data');
  conn.socket.on('error', () => {});
  conn.socket.destroy();
}

function openConnection(connection: GatewayConnection, key: string): PooledConnection {
  const expected = connection.fingerprint.replace(/[^a-f0-9]/gi, '').toUpperCase();
  const socket = tls.connect({
    host: connection.host,
    port: connection.port,
    ALPNProtocols: [ALPN.admin],
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  });
  socket.setNoDelay(true);

  const conn: PooledConnection = {
    socket,
    busy: true,
    idleTimer: null,
    onData: null,
    onClose: null,
    ready: new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new GatewayError(`${connection.host} did not respond.`, 0));
      }, REQUEST_TIMEOUT_MS);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        const peer = socket.getPeerCertificate();
        const actual = peer?.raw ? createHash('sha256').update(peer.raw).digest('hex').toUpperCase() : '';
        if (actual !== expected) {
          socket.destroy();
          reject(
            new GatewayError(
              'This gateway presented a different identity than the one LocalTunnel recorded.',
              0,
            ),
          );
          return;
        }
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new GatewayError(describeNetworkError(err, connection.host, connection.port), 0));
      });
    }),
  };

  // A single set of listeners for the life of the connection; the in-flight
  // request, if any, is handed whatever arrives.
  socket.on('data', (chunk: Buffer) => conn.onData?.(chunk));
  socket.on('error', () => {
    const handler = conn.onClose;
    discard(key, conn);
    handler?.();
  });
  socket.on('close', () => {
    const handler = conn.onClose;
    discard(key, conn);
    handler?.();
  });
  return conn;
}

/** Send one request on an established connection and read exactly one response. */
function sendOn(
  conn: PooledConnection,
  key: string,
  connection: GatewayConnection,
  method: string,
  path: string,
  body: unknown,
  /** True for a connection opened only because the pooled one was in use. */
  disposable: boolean,
): Promise<AdminResponse<unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let chunks: Buffer[] = [];
    let received = 0;
    let headerEnd = -1;
    let bodyStart = 0;
    let expectedLength = -1;
    let status = 0;
    let closesAfter = false;

    const finish = (err: GatewayError | null, value?: AdminResponse<unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.onData = null;
      conn.onClose = null;
      if (err || closesAfter || disposable) {
        discard(key, conn);
      } else {
        conn.busy = false;
        conn.idleTimer = setTimeout(() => discard(key, conn), IDLE_TIMEOUT_MS);
        conn.idleTimer.unref?.();
      }
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(
      () => finish(new GatewayError(`${connection.host} did not respond.`, 0)),
      REQUEST_TIMEOUT_MS,
    );

    const parse = (): void => {
      const raw = Buffer.concat(chunks, received);
      if (headerEnd === -1) {
        headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        bodyStart = headerEnd + 4;
        const head = raw.subarray(0, headerEnd).toString('latin1');
        const lines = head.split('\r\n');
        status = Number(lines[0].split(' ')[1]);
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const name = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (name === 'content-length') expectedLength = Number(value);
          else if (name === 'connection' && /close/i.test(value)) closesAfter = true;
          else if (name === 'transfer-encoding') expectedLength = -2;
        }
      }
      if (expectedLength === -2) {
        // The gateway always sends a content-length; anything else is not a
        // response this client should try to reuse the connection after.
        closesAfter = true;
        finish(new GatewayError('The gateway sent a response this client cannot read.', 0));
        return;
      }
      if (expectedLength < 0 || raw.length - bodyStart < expectedLength) return;
      const text = raw.subarray(bodyStart, bodyStart + expectedLength).toString('utf8');
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
      chunks = [];
      finish(null, { status, body: parsed });
    };

    conn.onData = (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      parse();
    };
    conn.onClose = () => {
      finish(new GatewayError(`${connection.host} closed the connection unexpectedly.`, 0));
    };

    const payload = body === undefined ? null : JSON.stringify(body);
    const head = [
      `${method} ${path} HTTP/1.1`,
      'host: gateway',
      `authorization: Bearer ${connection.adminToken}`,
      'connection: keep-alive',
    ];
    if (payload !== null) {
      head.push('content-type: application/json');
      head.push(`content-length: ${Buffer.byteLength(payload)}`);
    }
    conn.socket.write(`${head.join('\r\n')}\r\n\r\n${payload ?? ''}`);
  });
}

async function rawRequest(
  connection: GatewayConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<AdminResponse<unknown>> {
  const key = poolKey(connection);
  const pooled = POOL.get(key);

  if (pooled && !pooled.busy) {
    pooled.busy = true;
    if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
    pooled.idleTimer = null;
    try {
      return await sendOn(pooled, key, connection, method, path, body, false);
    } catch (err) {
      // A pooled connection can be closed by the far end between requests. That
      // is invisible until the write fails, so one retry on a fresh connection
      // is correct — but only for a request that changes nothing.
      if (method !== 'GET') throw err;
    }
  }

  // If the pooled connection is mid-request, this one gets its own rather than
  // queueing behind it: a slow call must not hold up the app's status polling.
  // That extra connection is closed as soon as its response is read.
  const disposable = Boolean(pooled?.busy);
  const conn = openConnection(connection, key);
  if (!disposable) POOL.set(key, conn);
  try {
    await conn.ready;
  } catch (err) {
    discard(key, conn);
    throw err;
  }
  try {
    return await sendOn(conn, key, connection, method, path, body, disposable);
  } catch (err) {
    discard(key, conn);
    throw err;
  }
}

/** Close every pooled admin connection — used when the app is shutting down. */
export function closeAdminConnections(): void {
  for (const [key, conn] of [...POOL]) discard(key, conn);
}

export function describeNetworkError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}:${port}. The gateway may be stopped.`;
    case 'ETIMEDOUT':
      return `${host}:${port} timed out. Check that TCP ${port} is open in your VPS provider's firewall — on Oracle Cloud this is the VCN security list.`;
    case 'ENOTFOUND':
      return `${host} could not be resolved.`;
    case 'ECONNRESET':
      return `${host} closed the connection unexpectedly.`;
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/* ------------------------------------------------------------------ shapes */

export interface GatewayStatus {
  gateway: {
    id: string;
    name: string;
    version: string;
    publicIp: string;
    httpsPort: number;
    httpPort: number;
    tlsMode: 'acme' | 'selfsigned';
    startedAt: string;
    uptimeSeconds: number;
    totals: { bytesIn: number; bytesOut: number };
  };
  machines: MachineView[];
  services: ServiceView[];
  certificates: CertificateView[];
  ports: { port: number; proto: string; label: string; open: boolean }[];
}

export interface MachineView {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  connected: boolean;
  latencyMs: number | null;
  activeStreams: number;
  agentVersion: string | null;
  serviceCount: number;
}

export interface CertificateView {
  hostname: string;
  state: 'none' | 'pending' | 'valid' | 'error';
  expiresAt: string | null;
  autoRenew: boolean;
  error: string | null;
  issuer: string;
  /** What the gateway is waiting for — shown while a certificate is pending. */
  detail?: string | null;
  nextAttemptAt?: string | null;
}

export interface ServiceView {
  id: string;
  machineId: string;
  name: string;
  type: 'http' | 'https' | 'tcp' | 'udp';
  localHost: string;
  localPort: number;
  hostname: string | null;
  publicPort: number | null;
  enabled: boolean;
  allowLanTarget: boolean;
  expiresAt: string | null;
  createdAt: string;
  stats: {
    bytesIn: number;
    bytesOut: number;
    requests: number;
    status2xx: number;
    status4xx: number;
    status5xx: number;
    errors: number;
    connections: number;
  };
  machineConnected: boolean;
  localReachable: boolean | null;
  localError: string | null;
  certificate: CertificateView | null;
  publicUrl: string | null;
  status: 'online' | 'disabled' | 'machine_offline' | 'local_unreachable';
}

export const gatewayApi = {
  status: (c: GatewayConnection) => adminFetch<GatewayStatus>(c, 'GET', '/v1/status'),
  machines: (c: GatewayConnection) => adminFetch<{ machines: MachineView[] }>(c, 'GET', '/v1/machines'),
  enrollToken: (c: GatewayConnection) =>
    adminFetch<{ token: string; expiresAt: string; gatewayId: string }>(
      c,
      'POST',
      '/v1/machines/enroll-token',
    ),
  revokeMachine: (c: GatewayConnection, id: string) =>
    adminFetch(c, 'POST', `/v1/machines/${encodeURIComponent(id)}/revoke`),
  removeMachine: (c: GatewayConnection, id: string) => adminFetch(c, 'DELETE', `/v1/machines/${encodeURIComponent(id)}`),
  renameMachine: (c: GatewayConnection, id: string, name: string) =>
    adminFetch(c, 'PATCH', `/v1/machines/${encodeURIComponent(id)}`, { name }),
  services: (c: GatewayConnection) => adminFetch<{ services: ServiceView[] }>(c, 'GET', '/v1/services'),
  createService: (c: GatewayConnection, service: Record<string, unknown>) =>
    adminFetch<{ service: ServiceView }>(c, 'POST', '/v1/services', service),
  updateService: (c: GatewayConnection, id: string, patch: Record<string, unknown>) =>
    adminFetch<{ service: ServiceView }>(c, 'PATCH', `/v1/services/${encodeURIComponent(id)}`, patch),
  removeService: (c: GatewayConnection, id: string) => adminFetch(c, 'DELETE', `/v1/services/${encodeURIComponent(id)}`),
  certificates: (c: GatewayConnection) =>
    adminFetch<{ certificates: CertificateView[] }>(c, 'GET', '/v1/certificates'),
  reissueCertificate: (c: GatewayConnection, hostname: string) =>
    adminFetch<{ certificate: CertificateView }>(
      c,
      'POST',
      `/v1/certificates/${encodeURIComponent(hostname)}/issue`,
    ),
  diagnostics: (c: GatewayConnection, serviceId?: string) =>
    adminFetch<GatewayDiagnostics>(
      c,
      'GET',
      serviceId ? `/v1/diagnostics?serviceId=${encodeURIComponent(serviceId)}` : '/v1/diagnostics',
    ),
};

export interface GatewayDiagnostics {
  gateway: { ok: boolean; publicIp: string };
  services: {
    serviceId: string;
    name: string;
    machineConnected: boolean;
    machineLatencyMs: number | null;
    localServiceReachable: boolean | null;
    localServiceError: string | null;
    certificate: CertificateView | null;
    expectedDnsTarget: string;
    hostname: string | null;
    publicPort: number | null;
  }[];
}
