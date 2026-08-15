import net from 'node:net';
import { isIP } from 'node:net';
import type { ServiceDescriptor, ServiceProbe, TunnelStream } from '@localtunnel/protocol';

const DIAL_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

export type AddressPolicy = 'loopback' | 'lan' | 'denied';

/**
 * What the agent is willing to connect to.
 *
 * The gateway tells the agent which local addresses to serve, so this is the check
 * that keeps a compromised or hostile gateway from turning the agent into a probe
 * into the user's home network.
 */
export function classifyAddress(host: string): AddressPolicy {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return 'loopback';

  if (isIP(lower) === 4) {
    const [a, b] = lower.split('.').map(Number);
    if (a === 127) return 'loopback';
    // Cloud instance metadata and link-local are never legitimate targets.
    if (a === 169 && b === 254) return 'denied';
    if (a >= 224) return 'denied';
    if (a === 10) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    return 'denied';
  }

  if (isIP(lower) === 6) {
    if (lower.startsWith('fe80')) return 'denied';
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'lan';
    return 'denied';
  }

  // A hostname such as `nas.local` — treated as LAN, so it needs the explicit
  // opt-in the desktop app collects with a warning.
  return 'lan';
}

export class PolicyError extends Error {
  readonly code = 'policy_denied';
}

/** Check a service against the policy before any connection is attempted. */
export function assertAllowed(service: ServiceDescriptor): void {
  const policy = classifyAddress(service.localHost);
  if (policy === 'denied') {
    throw new PolicyError(
      `${service.localHost} is not an address LocalTunnel will expose (link-local, multicast and metadata addresses are blocked).`,
    );
  }
  if (policy === 'lan' && !service.allowLanTarget) {
    throw new PolicyError(
      `${service.localHost} is another device on your network. Enable "allow LAN target" for this service to expose it.`,
    );
  }
}

/** Dial the local service and pipe it to the tunnel stream. */
export function connectLocal(service: ServiceDescriptor, stream: TunnelStream): Promise<void> {
  return new Promise((resolve, reject) => {
    assertAllowed(service);

    const socket = net.connect({ host: service.localHost, port: service.localPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${service.localHost}:${service.localPort}.`));
    }, DIAL_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.pipe(stream);
      stream.pipe(socket);

      const cleanup = () => {
        if (!socket.destroyed) socket.destroy();
        if (!stream.destroyed) stream.destroy();
      };
      socket.on('error', cleanup);
      socket.on('close', cleanup);
      stream.on('error', cleanup);
      stream.on('close', cleanup);
      resolve();
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === 'ECONNREFUSED'
            ? `Nothing is listening on ${service.localHost}:${service.localPort}.`
            : `Could not reach ${service.localHost}:${service.localPort}: ${err.message}`,
        ),
      );
    });
  });
}

/**
 * Is the local service actually up? Reported to the gateway so diagnostics can say
 * "your local server isn't running" before a visitor ever sees a 502.
 */
export function probe(service: ServiceDescriptor): Promise<ServiceProbe> {
  return new Promise((resolve) => {
    try {
      assertAllowed(service);
    } catch (err) {
      resolve({ reachable: false, error: (err as Error).message });
      return;
    }

    const started = Date.now();
    const socket = net.connect({ host: service.localHost, port: service.localPort });
    const finish = (result: ServiceProbe) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ reachable: false, error: 'Timed out while checking the local service.' }),
      PROBE_TIMEOUT_MS,
    );

    socket.once('connect', () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish({
        reachable: false,
        error:
          code === 'ECONNREFUSED'
            ? `Nothing is listening on ${service.localHost}:${service.localPort}.`
            : err.message,
      });
    });
  });
}

/** Ports worth suggesting in the UI when the user opens "Expose a Service". */
export const COMMON_DEV_PORTS = [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8443, 9000];

/** Scan localhost for things the user might want to expose. */
export async function discoverLocalServices(
  ports: number[] = COMMON_DEV_PORTS,
): Promise<{ port: number; guess: 'http' | 'tcp' }[]> {
  const results = await Promise.all(
    ports.map(
      (port) =>
        new Promise<{ port: number; guess: 'http' | 'tcp' } | null>((resolve) => {
          const socket = net.connect({ host: '127.0.0.1', port });
          const timer = setTimeout(() => {
            socket.destroy();
            resolve(null);
          }, 300);
          socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ port, guess: port === 25565 ? 'tcp' : 'http' });
          });
          socket.once('error', () => {
            clearTimeout(timer);
            resolve(null);
          });
        }),
    ),
  );
  return results.filter((r): r is { port: number; guess: 'http' | 'tcp' } => r !== null);
}
