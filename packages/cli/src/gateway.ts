import { createHash } from 'node:crypto';
import tls from 'node:tls';
import { ALPN } from '@localtunnel/protocol';

/**
 * Client for a gateway's admin API — the same wire protocol the desktop app uses.
 *
 * Deliberately a copy rather than an import: the desktop package pulls in Electron,
 * and this has to run on a headless Linux box over SSH.
 */

export interface GatewayConnection {
  host: string;
  port: number;
  adminToken: string;
  fingerprint: string;
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

function rawRequest(
  connection: GatewayConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const expected = connection.fingerprint.replace(/[^a-f0-9]/gi, '').toUpperCase();
    const socket = tls.connect({
      host: connection.host,
      port: connection.port,
      ALPNProtocols: [ALPN.admin],
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new GatewayError(`${connection.host} did not respond.`, 0));
    }, REQUEST_TIMEOUT_MS);

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      const actual = peer?.raw ? createHash('sha256').update(peer.raw).digest('hex').toUpperCase() : '';
      if (actual !== expected) {
        clearTimeout(timer);
        socket.destroy();
        reject(
          new GatewayError(
            'This gateway presented a different identity than the one LocalTunnel recorded.',
            0,
          ),
        );
        return;
      }

      const payload = body === undefined ? null : JSON.stringify(body);
      const head = [
        `${method} ${path} HTTP/1.1`,
        'host: gateway',
        `authorization: Bearer ${connection.adminToken}`,
        'connection: close',
      ];
      if (payload !== null) {
        head.push('content-type: application/json');
        head.push(`content-length: ${Buffer.byteLength(payload)}`);
      }
      socket.write(`${head.join('\r\n')}\r\n\r\n${payload ?? ''}`);
    });

    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new GatewayError(describeNetworkError(err, connection.host, connection.port), 0));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) {
        reject(new GatewayError('The gateway sent an incomplete response.', 0));
        return;
      }
      const status = Number(raw.slice(0, separator).split('\r\n')[0].split(' ')[1]);
      const text = raw.slice(separator + 4);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
      resolve({ status, body: parsed });
    });
  });
}

export function describeNetworkError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}:${port}. The gateway may be stopped.`;
    case 'ETIMEDOUT':
      return `${host}:${port} timed out. Check that TCP ${port} is open in your VPS provider's firewall.`;
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

export const gatewayApi = {
  status: (c: GatewayConnection) => adminFetch<GatewayStatus>(c, 'GET', '/v1/status'),
  machines: (c: GatewayConnection) => adminFetch<{ machines: MachineView[] }>(c, 'GET', '/v1/machines'),
  enrollToken: (c: GatewayConnection) =>
    adminFetch<{ token: string; expiresAt: string; gatewayId: string }>(
      c,
      'POST',
      '/v1/machines/enroll-token',
    ),
  revokeMachine: (c: GatewayConnection, id: string) => adminFetch(c, 'POST', `/v1/machines/${id}/revoke`),
  removeMachine: (c: GatewayConnection, id: string) => adminFetch(c, 'DELETE', `/v1/machines/${id}`),
  renameMachine: (c: GatewayConnection, id: string, name: string) =>
    adminFetch(c, 'PATCH', `/v1/machines/${id}`, { name }),
  services: (c: GatewayConnection) => adminFetch<{ services: ServiceView[] }>(c, 'GET', '/v1/services'),
  createService: (c: GatewayConnection, service: Record<string, unknown>) =>
    adminFetch<{ service: ServiceView }>(c, 'POST', '/v1/services', service),
  updateService: (c: GatewayConnection, id: string, patch: Record<string, unknown>) =>
    adminFetch<{ service: ServiceView }>(c, 'PATCH', `/v1/services/${id}`, patch),
  removeService: (c: GatewayConnection, id: string) => adminFetch(c, 'DELETE', `/v1/services/${id}`),
  certificates: (c: GatewayConnection) =>
    adminFetch<{ certificates: CertificateView[] }>(c, 'GET', '/v1/certificates'),
  reissueCertificate: (c: GatewayConnection, hostname: string) =>
    adminFetch<{ certificate: CertificateView }>(c, 'POST', `/v1/certificates/${hostname}/issue`),
  diagnostics: (c: GatewayConnection, serviceId?: string) =>
    adminFetch<GatewayDiagnostics>(
      c,
      'GET',
      serviceId ? `/v1/diagnostics?serviceId=${encodeURIComponent(serviceId)}` : '/v1/diagnostics',
    ),
};
