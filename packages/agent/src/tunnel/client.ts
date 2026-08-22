import { EventEmitter } from 'node:events';
import type tls from 'node:tls';
import {
  ALPN,
  Backoff,
  Mux,
  PROTOCOL_VERSION,
  type ControlMessage,
  type ServiceDescriptor,
  type ServiceProbe,
  type TunnelStream,
} from '@localtunnel/protocol';
import { Identity, type Credentials } from '../auth/identity.js';
import { connectPinned, friendlyConnectError } from '../auth/enroll.js';
import { assertAllowed, connectLocal, probe } from '../service_proxy/local.js';

const AGENT_VERSION = '1.0.0';
const METRICS_INTERVAL_MS = 30_000;
const PROBE_INTERVAL_MS = 20_000;
const PING_INTERVAL_MS = 15_000;
/**
 * Reconnect delays. A tunnel that was healthy retries almost immediately — the
 * usual cause is the gateway restarting or a wifi blip, and every millisecond
 * here is downtime for the user's site. Repeated failures back off quickly so a
 * gateway that is genuinely down is not hammered.
 */
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 15_000;
/** Jitter applied to the first retry after a working connection dropped. */
const IMMEDIATE_RETRY_JITTER_MS = 150;

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'revoked'
  | 'error';

export interface TunnelStatus {
  state: TunnelState;
  machineId: string | null;
  gatewayId: string | null;
  gatewayHost: string | null;
  latencyMs: number | null;
  connectedSince: string | null;
  services: ServiceDescriptor[];
  probes: Record<string, ServiceProbe>;
  lastError: string | null;
  /** Seconds until the next reconnect attempt, when reconnecting. */
  retryInSeconds: number | null;
  attempts: number;
  bytesIn: number;
  bytesOut: number;
  activeStreams: number;
}

/**
 * The agent's side of the tunnel: one outbound connection, reconnected forever.
 *
 * The connection is always dialled from here — nothing ever connects inbound to this
 * machine, which is exactly why this works behind CGNAT.
 */
export class TunnelClient extends EventEmitter {
  private identity: Identity;
  private credentials: Credentials | null;
  private socket: tls.TLSSocket | null = null;
  private mux: Mux | null = null;
  private backoff = new Backoff(RETRY_BASE_MS, RETRY_MAX_MS);
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAt: number | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  private state: TunnelState = 'idle';
  private services: ServiceDescriptor[] = [];
  private probes: Record<string, ServiceProbe> = {};
  private latencyMs: number | null = null;
  private connectedSince: Date | null = null;
  private lastError: string | null = null;
  private opens = 0;
  /** True once a tunnel has completed its handshake, until it next drops. */
  private wasConnected = false;
  private openFailures = 0;

  constructor(identity = new Identity()) {
    super();
    this.identity = identity;
    this.credentials = identity.credentials();
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      machineId: this.credentials?.machineId ?? null,
      gatewayId: this.credentials?.gatewayId ?? null,
      gatewayHost: this.credentials?.gatewayHost ?? null,
      latencyMs: this.latencyMs,
      connectedSince: this.connectedSince?.toISOString() ?? null,
      services: this.services,
      probes: this.probes,
      lastError: this.lastError,
      retryInSeconds: this.retryAt ? Math.max(0, Math.round((this.retryAt - Date.now()) / 1000)) : null,
      attempts: this.backoff.attempts,
      bytesIn: this.mux?.bytesIn ?? 0,
      bytesOut: this.mux?.bytesOut ?? 0,
      activeStreams: this.mux?.activeStreams ?? 0,
    };
  }

  reloadCredentials(): void {
    this.credentials = this.identity.credentials();
  }

  start(): void {
    this.stopped = false;
    this.reloadCredentials();
    if (!this.credentials) {
      this.setState('idle', 'This computer is not connected to a gateway yet.');
      return;
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
    this.teardown();
    this.setState('idle');
  }

  private setState(state: TunnelState, error?: string | null): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.emit('status', this.status());
  }

  private async connect(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials || this.stopped) return;

    this.setState(this.backoff.attempts === 0 ? 'connecting' : 'reconnecting');

    try {
      const socket = await connectPinned({
        host: credentials.gatewayHost,
        port: credentials.gatewayPort,
        fingerprint: credentials.gatewayFingerprint,
        alpn: ALPN.tunnel,
        cert: credentials.certPem,
        key: this.identity.privateKeyPem(),
        ca: credentials.caPem,
      });
      this.attach(socket, credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.scheduleRetry(message);
    }
  }

  private attach(socket: tls.TLSSocket, credentials: Credentials): void {
    this.socket = socket;
    const mux = new Mux(socket, { role: 'agent' });
    this.mux = mux;

    mux.on('control', (message) => this.onControl(message));
    mux.on('stream', (stream) => void this.onStream(stream));
    mux.on('error', () => {
      /* handled by close */
    });
    mux.on('close', () => {
      if (this.state === 'revoked' || this.stopped) return;
      this.scheduleRetry('The connection to the gateway was lost.');
    });

    const details = this.identity.describe();
    mux.sendControl({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      machineId: credentials.machineId,
      hostname: details.hostname,
      os: details.os,
      arch: details.arch,
    });
  }

  private onControl(message: ControlMessage): void {
    switch (message.t) {
      case 'hello.ok':
        this.backoff.reset();
        this.wasConnected = true;
        this.connectedSince = new Date();
        this.retryAt = null;
        this.setState('connected', null);
        this.startTimers();
        break;

      case 'hello.err':
        this.scheduleRetry(
          `The gateway does not support this agent version (${message.error}). Update LocalTunnel.`,
        );
        break;

      case 'services.sync':
        void this.onServicesSync(message.services);
        break;

      case 'ping':
        this.mux?.sendControl({ t: 'pong', ts: message.ts });
        break;

      case 'pong':
        this.latencyMs = Math.max(0, Date.now() - message.ts);
        this.emit('status', this.status());
        break;

      case 'revoked':
        this.onRevoked(message.reason);
        break;

      default:
        break;
    }
  }

  private async onServicesSync(services: ServiceDescriptor[]): Promise<void> {
    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const service of services) {
      try {
        assertAllowed(service);
        accepted.push(service.id);
      } catch (err) {
        rejected.push({ id: service.id, reason: (err as Error).message });
      }
    }
    const allowed = new Set(accepted);
    this.services = services.filter((s) => allowed.has(s.id));
    const probes = await this.probeAll();
    this.mux?.sendControl({ t: 'services.ack', accepted, rejected, probe: probes });
    this.emit('status', this.status());
  }

  private async probeAll(): Promise<Record<string, ServiceProbe>> {
    const entries = await Promise.all(
      this.services.map(async (service) => [service.id, await probe(service)] as const),
    );
    this.probes = Object.fromEntries(entries);
    return this.probes;
  }

  /** A visitor arrived at the gateway; connect the stream to the local service. */
  private async onStream(stream: TunnelStream): Promise<void> {
    const service = this.services.find((s) => s.id === stream.open.serviceId);
    this.opens += 1;
    // Refusing a stream destroys it with a reason, which the Duplex reports as an
    // 'error' event. That is an expected outcome here, not a crash.
    stream.on('error', () => {});

    if (!service) {
      this.openFailures += 1;
      stream.destroy(new Error('no_such_service'));
      return;
    }

    try {
      await connectLocal(service, stream);
      this.mux?.confirmStream(stream.id);
    } catch (err) {
      this.openFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.probes[service.id] = { reachable: false, error: message };
      stream.destroy(new Error(message));
      this.emit('status', this.status());
    }
  }

  private onRevoked(reason: string): void {
    this.setState('revoked', reason);
    this.identity.clearCredentials();
    this.credentials = null;
    this.stopped = true;
    this.teardown();
    this.emit('revoked', reason);
  }

  private startTimers(): void {
    this.stopTimers();
    // The gateway pings us to detect a dead tunnel; we ping it to measure the
    // round-trip time the UI shows. Without this the agent replies to pongs it
    // never asked for and its own latency stays permanently unknown.
    this.pingTimer = setInterval(() => {
      if (this.state === 'connected') this.mux?.sendControl({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
    this.mux?.sendControl({ t: 'ping', ts: Date.now() });

    this.probeTimer = setInterval(() => void this.refreshProbes(), PROBE_INTERVAL_MS);
    this.probeTimer.unref();
    this.metricsTimer = setInterval(() => this.reportMetrics(), METRICS_INTERVAL_MS);
    this.metricsTimer.unref();
  }

  private async refreshProbes(): Promise<void> {
    if (this.state !== 'connected' || this.services.length === 0) return;
    const before = JSON.stringify(this.probes);
    const probes = await this.probeAll();
    if (JSON.stringify(probes) !== before) {
      this.mux?.sendControl({
        t: 'services.ack',
        accepted: this.services.map((s) => s.id),
        probe: probes,
      });
      this.emit('status', this.status());
    }
  }

  private reportMetrics(): void {
    if (!this.mux || this.state !== 'connected') return;
    this.mux.sendControl({
      t: 'metrics',
      ts: Date.now(),
      streams: this.mux.activeStreams,
      bytesIn: this.mux.bytesIn,
      bytesOut: this.mux.bytesOut,
      opens: this.opens,
      openFailures: this.openFailures,
    });
  }

  private stopTimers(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.probeTimer = null;
    this.metricsTimer = null;
    this.pingTimer = null;
  }

  private teardown(): void {
    this.stopTimers();
    this.connectedSince = null;
    this.latencyMs = null;
    if (this.mux) {
      this.mux.removeAllListeners();
      this.mux.close();
      this.mux = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** 1s, 2s, 4s … capped at 30s, with jitter. Never gives up on its own. */
  private scheduleRetry(reason: string): void {
    this.teardown();
    if (this.stopped) return;

    // A connection that was working until a moment ago comes straight back.
    let delay: number;
    if (this.wasConnected) {
      this.wasConnected = false;
      this.backoff.reset();
      this.backoff.next();
      delay = Math.round(Math.random() * IMMEDIATE_RETRY_JITTER_MS);
    } else {
      delay = this.backoff.next();
    }
    this.retryAt = Date.now() + delay;
    this.setState('reconnecting', reason);
    this.emit('retry', { reason, delayMs: delay, attempt: this.backoff.attempts });

    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    this.retryTimer.unref();
  }
}

export { friendlyConnectError };
