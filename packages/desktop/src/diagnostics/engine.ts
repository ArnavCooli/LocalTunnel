import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import type { GatewayConnection, ServiceView } from '../services/gateway-client.js';
import { gatewayApi } from '../services/gateway-client.js';

/**
 * The diagnostics engine.
 *
 * The point is never to say "something went wrong". Every check that fails must say
 * which link in the chain broke and what to change, in the user's own terms.
 */

export type CheckState = 'pass' | 'fail' | 'warn' | 'skip' | 'running';

export interface CheckResult {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  /** Concrete instruction shown under a failure. */
  fix?: string;
  /** Extra facts worth showing, e.g. observed vs expected DNS target. */
  facts?: { label: string; value: string }[];
}

export interface DiagnosticsInput {
  connection: GatewayConnection | null;
  /** Status from the local agent's IPC endpoint, if it is running. */
  agentStatus: {
    state: string;
    latencyMs: number | null;
    lastError: string | null;
    probes: Record<string, { reachable: boolean; error?: string }>;
  } | null;
  /** Narrow the run to a single service. */
  service?: ServiceView | null;
}

export async function runDiagnostics(input: DiagnosticsInput): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await checkInternet());
  results.push(await checkCgnat());

  if (!input.connection) {
    results.push({
      id: 'gateway',
      label: 'Gateway',
      state: 'fail',
      detail: 'No gateway has been set up yet.',
      fix: 'Open the Gateways tab and set up your VPS gateway.',
    });
    return results;
  }

  const gatewayReachable = await checkGatewayPort(input.connection);
  results.push(gatewayReachable);

  const gatewayApiCheck = await checkGatewayApi(input.connection);
  results.push(gatewayApiCheck);

  results.push(checkAgent(input.agentStatus));

  const service = input.service ?? null;
  if (!service) {
    return results;
  }

  results.push(checkTunnelForService(service));
  results.push(checkLocalService(service, input.agentStatus));

  if (service.hostname) {
    results.push(await checkDns(service.hostname, input.connection.host));
    results.push(await checkTls(service.hostname, input.connection.host, input.connection.port));
    results.push(await checkEndToEnd(service.hostname, input.connection.host));
  } else if (service.publicPort) {
    results.push(await checkPublicPort(input.connection.host, service.publicPort));
  }

  return results;
}

/* ------------------------------------------------------------- individual */

async function checkInternet(): Promise<CheckResult> {
  try {
    await dns.resolve4('one.one.one.one');
    await tcpProbe('1.1.1.1', 443, 4000);
    return { id: 'internet', label: 'Internet', state: 'pass', detail: 'This computer is online.' };
  } catch {
    return {
      id: 'internet',
      label: 'Internet',
      state: 'fail',
      detail: 'This computer cannot reach the internet.',
      fix: 'Check your Wi-Fi or Ethernet connection, then run diagnostics again.',
    };
  }
}

/**
 * Detects CGNAT. This is informational, not a failure: LocalTunnel exists precisely
 * to work in this situation, and saying so plainly is reassuring rather than alarming.
 */
async function checkCgnat(): Promise<CheckResult> {
  const local = localAddresses();
  let publicIp: string | null = null;
  try {
    publicIp = await fetchPublicIp();
  } catch {
    return {
      id: 'cgnat',
      label: 'Home connection',
      state: 'skip',
      detail: 'Could not determine your public IP address.',
    };
  }

  const behindCgnat = local.some(isCgnatRange);
  const hasPublicLocally = publicIp !== null && local.includes(publicIp);

  if (hasPublicLocally) {
    return {
      id: 'cgnat',
      label: 'Home connection',
      state: 'pass',
      detail: 'Your computer has a public IP address.',
      facts: [{ label: 'Public IP', value: publicIp! }],
    };
  }

  return {
    id: 'cgnat',
    label: 'Home connection',
    state: 'pass',
    detail: behindCgnat
      ? 'You are behind CGNAT, so inbound connections are impossible. LocalTunnel routes around this by dialling out to your gateway.'
      : 'You are behind NAT. LocalTunnel dials out to your gateway, so no port forwarding is needed.',
    facts: publicIp ? [{ label: 'Your ISP address', value: publicIp }] : undefined,
  };
}

async function checkGatewayPort(connection: GatewayConnection): Promise<CheckResult> {
  try {
    await tcpProbe(connection.host, connection.port, 8000);
    return {
      id: 'gateway-port',
      label: 'Gateway reachable',
      state: 'pass',
      detail: `${connection.host}:${connection.port} is accepting connections.`,
    };
  } catch {
    return {
      id: 'gateway-port',
      label: 'Gateway reachable',
      state: 'fail',
      detail: `Nothing answered on ${connection.host}:${connection.port}.`,
      fix:
        'This is almost always the provider firewall rather than the gateway itself. On Oracle Cloud: Networking → Virtual Cloud Networks → your VCN → Security Lists → Default → Add Ingress Rules, source 0.0.0.0/0, TCP ports 443 and 80.',
    };
  }
}

async function checkGatewayApi(connection: GatewayConnection): Promise<CheckResult> {
  try {
    const status = await gatewayApi.status(connection);
    return {
      id: 'gateway',
      label: 'Gateway',
      state: 'pass',
      detail: `${status.gateway.name} is online.`,
      facts: [
        { label: 'Version', value: status.gateway.version },
        { label: 'Uptime', value: formatDuration(status.gateway.uptimeSeconds) },
        { label: 'Machines', value: String(status.machines.filter((m) => m.connected).length) },
      ],
    };
  } catch (err) {
    return {
      id: 'gateway',
      label: 'Gateway',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'If the gateway was reinstalled, remove it here and add it again so LocalTunnel picks up its new identity.',
    };
  }
}

function checkAgent(status: DiagnosticsInput['agentStatus']): CheckResult {
  if (!status) {
    return {
      id: 'agent',
      label: 'Agent',
      state: 'fail',
      detail: 'The LocalTunnel agent is not running on this computer.',
      fix: 'Open the Machines tab and press Connect.',
    };
  }
  if (status.state === 'connected') {
    return {
      id: 'agent',
      label: 'Agent',
      state: 'pass',
      detail: 'Connected to the gateway.',
      facts: status.latencyMs === null ? undefined : [{ label: 'Latency', value: `${status.latencyMs} ms` }],
    };
  }
  if (status.state === 'revoked') {
    return {
      id: 'agent',
      label: 'Agent',
      state: 'fail',
      detail: 'This computer was revoked by the gateway.',
      fix: 'Connect this computer again from the Machines tab to get a new identity.',
    };
  }
  return {
    id: 'agent',
    label: 'Agent',
    state: 'fail',
    detail: status.lastError ?? `The agent is ${status.state}.`,
    fix: 'The agent retries automatically. If this persists, check that the gateway is running.',
  };
}

function checkTunnelForService(service: ServiceView): CheckResult {
  return service.machineConnected
    ? {
        id: 'tunnel',
        label: 'Tunnel',
        state: 'pass',
        detail: 'The tunnel carrying this service is healthy.',
      }
    : {
        id: 'tunnel',
        label: 'Tunnel',
        state: 'fail',
        detail: 'The machine that hosts this service is not connected.',
        fix: 'Wake that computer, or check its LocalTunnel agent.',
      };
}

function checkLocalService(service: ServiceView, agent: DiagnosticsInput['agentStatus']): CheckResult {
  const probe = agent?.probes?.[service.id];
  const target = `${service.localHost}:${service.localPort}`;
  if (probe?.reachable || service.localReachable) {
    return {
      id: 'local-service',
      label: 'Local service',
      state: 'pass',
      detail: `${target} is listening.`,
    };
  }
  if (service.localReachable === null && !probe) {
    return {
      id: 'local-service',
      label: 'Local service',
      state: 'skip',
      detail: 'The local service has not been checked yet.',
    };
  }
  return {
    id: 'local-service',
    label: 'Local service',
    state: 'fail',
    detail: probe?.error ?? service.localError ?? `Nothing is listening on ${target}.`,
    fix: `Start the service on ${target}. If it is running on a different port, change it in this service's settings.`,
  };
}

async function checkDns(hostname: string, expectedIp: string): Promise<CheckResult> {
  let addresses: string[] = [];
  try {
    addresses = await dns.resolve4(hostname);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id: 'dns',
      label: 'DNS',
      state: 'fail',
      detail:
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? `${hostname} does not have a DNS record yet.`
          : `${hostname} could not be resolved.`,
      fix: `Create an A record for ${hostname} pointing to ${expectedIp}. New records usually work within a few minutes.`,
      facts: [
        { label: 'Type', value: 'A' },
        { label: 'Name', value: hostname.split('.')[0] },
        { label: 'Value', value: expectedIp },
      ],
    };
  }

  if (addresses.includes(expectedIp)) {
    return {
      id: 'dns',
      label: 'DNS',
      state: 'pass',
      detail: `${hostname} points at your gateway.`,
      facts: [{ label: hostname, value: addresses.join(', ') }],
    };
  }

  return {
    id: 'dns',
    label: 'DNS',
    state: 'fail',
    detail: `${hostname} points somewhere else.`,
    fix: `Change the A record for ${hostname} to ${expectedIp}. If you use Cloudflare, also set the record to "DNS only" (grey cloud) — LocalTunnel terminates TLS on your own server and must not be proxied.`,
    facts: [
      { label: 'Currently resolves to', value: addresses.join(', ') },
      { label: 'Your gateway', value: expectedIp },
    ],
  };
}

async function checkTls(hostname: string, gatewayIp: string, port: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: gatewayIp,
      port,
      servername: hostname,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
      timeout: 8000,
    });
    const finish = (result: CheckResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      const names = [peer.subject?.CN, ...(peer.subjectaltname ?? '').split(/,\s*/).map((s) => s.replace('DNS:', ''))];
      const matches = names.filter(Boolean).some((n) => String(n).toLowerCase() === hostname);
      const expiry = peer.valid_to ? new Date(peer.valid_to) : null;
      const selfSigned = peer.issuer?.O === 'LocalTunnel';

      if (!matches) {
        return finish({
          id: 'tls',
          label: 'HTTPS',
          state: 'fail',
          detail: `The certificate being served does not cover ${hostname}.`,
          fix: 'Reissue the certificate from the Domains tab once DNS points at your gateway.',
        });
      }
      if (selfSigned) {
        return finish({
          id: 'tls',
          label: 'HTTPS',
          state: 'warn',
          detail: 'A temporary self-signed certificate is in use, so browsers will warn visitors.',
          fix: "Point the domain at your gateway and reissue the certificate to get a Let's Encrypt one.",
        });
      }
      if (expiry && expiry.getTime() < Date.now()) {
        return finish({
          id: 'tls',
          label: 'HTTPS',
          state: 'fail',
          detail: `The certificate for ${hostname} expired on ${expiry.toDateString()}.`,
          fix: 'Reissue the certificate from the Domains tab.',
        });
      }
      finish({
        id: 'tls',
        label: 'HTTPS',
        state: 'pass',
        detail: 'The certificate is valid.',
        facts: expiry ? [{ label: 'Expires', value: expiry.toDateString() }] : undefined,
      });
    });
    socket.once('timeout', () =>
      finish({
        id: 'tls',
        label: 'HTTPS',
        state: 'fail',
        detail: 'The TLS handshake timed out.',
        fix: 'Check that TCP 443 is open in your provider firewall.',
      }),
    );
    socket.once('error', (err) =>
      finish({
        id: 'tls',
        label: 'HTTPS',
        state: 'fail',
        detail: err.message,
        fix: 'Check that the gateway is running and that TCP 443 is open.',
      }),
    );
  });
}

/** The check that matters most: does the public URL actually serve the site? */
async function checkEndToEnd(hostname: string, gatewayIp: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: gatewayIp,
        servername: hostname,
        port: 443,
        path: '/',
        method: 'GET',
        headers: { host: hostname },
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status === 502) {
          resolve({
            id: 'end-to-end',
            label: 'Public endpoint',
            state: 'fail',
            detail: 'The gateway answered, but could not reach your computer.',
            fix: 'Check the tunnel and local service checks above.',
          });
        } else if (status === 404) {
          resolve({
            id: 'end-to-end',
            label: 'Public endpoint',
            state: 'fail',
            detail: `The gateway has no service published at ${hostname}.`,
            fix: 'Republish the service, or check the hostname for typos.',
          });
        } else {
          resolve({
            id: 'end-to-end',
            label: 'Public endpoint',
            state: 'pass',
            detail: `https://${hostname} responded with HTTP ${status}.`,
          });
        }
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        id: 'end-to-end',
        label: 'Public endpoint',
        state: 'fail',
        detail: 'The public endpoint timed out.',
        fix: 'Check that TCP 443 is open in your provider firewall.',
      });
    });
    req.on('error', (err) =>
      resolve({
        id: 'end-to-end',
        label: 'Public endpoint',
        state: 'fail',
        detail: err.message,
      }),
    );
    req.end();
  });
}

async function checkPublicPort(host: string, port: number): Promise<CheckResult> {
  try {
    await tcpProbe(host, port, 8000);
    return {
      id: 'public-port',
      label: 'Public port',
      state: 'pass',
      detail: `${host}:${port} is accepting connections.`,
    };
  } catch {
    return {
      id: 'public-port',
      label: 'Public port',
      state: 'fail',
      detail: `Nothing answered on ${host}:${port}.`,
      fix: `LocalTunnel opened this port on the server itself, but your provider has its own firewall. Add an ingress rule for TCP ${port} from 0.0.0.0/0.`,
    };
  }
}

/* ------------------------------------------------------------------ utils */

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address);
}

/** 100.64.0.0/10 — the range reserved for carrier-grade NAT. */
function isCgnatRange(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function fetchPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: 'api.ipify.org', path: '/', method: 'GET', timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
