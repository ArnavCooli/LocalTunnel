import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import {
  Mux,
  PROTOCOL_VERSION,
  type ControlMessage,
  type HelloMessage,
  type ServiceDescriptor,
  type ServiceProbe,
  type TunnelStream,
} from '@localtunnel/protocol';
import type { Logger } from '../main/log.js';
import type { Store } from '../main/state.js';

const HEARTBEAT_MS = 15_000;
const MISSED_HEARTBEATS_ALLOWED = 3;
const GATEWAY_VERSION = '1.0.0';

export interface TunnelInfo {
  machineId: string;
  hostname: string;
  os: string;
  arch: string;
  agentVersion: string;
  connectedAt: string;
  latencyMs: number | null;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  /** What the agent reports about each local service's reachability. */
  probes: Record<string, ServiceProbe>;
}

class Tunnel {
  readonly mux: Mux;
  readonly machineId: string;
  readonly hello: HelloMessage;
  readonly connectedAt = new Date();
  latencyMs: number | null = null;
  probes: Record<string, ServiceProbe> = {};
  private lastPong = Date.now();
  private heartbeat: NodeJS.Timeout;

  constructor(
    socket: Duplex,
    hello: HelloMessage,
    private readonly onDead: (reason: string) => void,
  ) {
    this.machineId = hello.machineId;
    this.hello = hello;
    this.mux = new Mux(socket, { role: 'gateway' });

    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private beat(): void {
    const silentFor = Date.now() - this.lastPong;
    if (silentFor > HEARTBEAT_MS * MISSED_HEARTBEATS_ALLOWED) {
      this.onDead(`no heartbeat for ${Math.round(silentFor / 1000)}s`);
      return;
    }
    this.mux.sendControl({ t: 'ping', ts: Date.now() });
  }

  notePong(sentAt: number): void {
    this.lastPong = Date.now();
    this.latencyMs = Math.max(0, Date.now() - sentAt);
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.mux.close();
  }
}

/**
 * Every live agent connection, and the only way the rest of the gateway reaches a
 * home machine: `openStream` either hands back a live stream or throws with a reason
 * a human can act on.
 */
export class TunnelRegistry extends EventEmitter {
  private tunnels = new Map<string, Tunnel>();

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    private readonly limits: { streamsPerMachine: number },
    private readonly publicIp: string,
    private readonly gatewayId: string,
  ) {
    super();
  }

  isConnected(machineId: string): boolean {
    return this.tunnels.has(machineId);
  }

  info(machineId: string): TunnelInfo | null {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return null;
    return {
      machineId,
      hostname: tunnel.hello.hostname,
      os: tunnel.hello.os,
      arch: tunnel.hello.arch,
      agentVersion: tunnel.hello.agentVersion,
      connectedAt: tunnel.connectedAt.toISOString(),
      latencyMs: tunnel.latencyMs,
      activeStreams: tunnel.mux.activeStreams,
      bytesIn: tunnel.mux.bytesIn,
      bytesOut: tunnel.mux.bytesOut,
      probes: tunnel.probes,
    };
  }

  all(): TunnelInfo[] {
    return [...this.tunnels.keys()].map((id) => this.info(id)!).filter(Boolean);
  }

  /**
   * Adopt a socket that has completed mutual TLS and been authorised. The caller has
   * already checked the client certificate; `machineId` comes from that certificate,
   * never from the hello message.
   */
  accept(socket: Duplex, hello: HelloMessage, machineId: string): void {
    if (hello.protocol !== PROTOCOL_VERSION) {
      const mux = new Mux(socket, { role: 'gateway' });
      mux.on('error', () => {});
      mux.sendControl({
        t: 'hello.err',
        error: `unsupported protocol version ${hello.protocol}`,
        supportedProtocols: [PROTOCOL_VERSION],
      });
      setTimeout(() => mux.close(), 100).unref();
      return;
    }

    // One tunnel per machine: a reconnect after a network drop replaces the stale one.
    const existing = this.tunnels.get(machineId);
    if (existing) {
      this.log.info('replacing stale tunnel', { machineId });
      existing.dispose();
      this.tunnels.delete(machineId);
    }

    // The machine id is taken from the verified client certificate, not from hello.
    const tunnel = new Tunnel(socket, { ...hello, machineId }, (reason) =>
      this.drop(machineId, reason),
    );
    this.tunnels.set(machineId, tunnel);

    tunnel.mux.on('control', (message) => this.onControl(machineId, message));
    tunnel.mux.on('error', (err) => {
      this.log.info('tunnel error', { machineId, error: err.message });
    });
    tunnel.mux.on('close', () => {
      if (this.tunnels.get(machineId) === tunnel) {
        this.tunnels.delete(machineId);
        this.log.info('tunnel closed', { machineId });
        this.emit('disconnected', machineId);
      }
    });

    this.store.touchMachine(machineId);
    tunnel.mux.sendControl({
      t: 'hello.ok',
      gatewayVersion: GATEWAY_VERSION,
      gatewayId: this.gatewayId,
      publicIp: this.publicIp,
      heartbeatMs: HEARTBEAT_MS,
    });
    this.syncServices(machineId);

    this.log.info('tunnel established', {
      machineId,
      hostname: hello.hostname,
      agentVersion: hello.agentVersion,
    });
    this.emit('connected', machineId);
  }

  private onControl(machineId: string, message: ControlMessage): void {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return;
    switch (message.t) {
      case 'pong':
        tunnel.notePong(message.ts);
        this.store.touchMachine(machineId);
        break;
      case 'ping':
        tunnel.mux.sendControl({ t: 'pong', ts: message.ts });
        break;
      case 'services.ack':
        tunnel.probes = message.probe ?? {};
        if (message.rejected?.length) {
          this.log.warn('agent rejected services', { machineId, rejected: message.rejected });
        }
        this.emit('probes', machineId, tunnel.probes);
        break;
      case 'metrics':
        this.emit('metrics', machineId, message);
        break;
      default:
        break;
    }
  }

  /** Push the authoritative service list for a machine down its tunnel. */
  syncServices(machineId: string): void {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return;
    const services: ServiceDescriptor[] = this.store
      .servicesForMachine(machineId)
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        localHost: s.localHost,
        localPort: s.localPort,
        hostname: s.hostname,
        publicPort: s.publicPort,
        allowLanTarget: s.allowLanTarget,
      }));
    tunnel.mux.sendControl({ t: 'services.sync', services });
  }

  syncAll(): void {
    for (const machineId of this.tunnels.keys()) this.syncServices(machineId);
  }

  /**
   * Open a stream to a machine for one public connection. Throws with a message the
   * HTTP proxy turns into a readable 502 page rather than a generic gateway error.
   */
  openStream(machineId: string, serviceId: string, remoteAddr: string): TunnelStream {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) {
      const machine = this.store.machine(machineId);
      throw new TunnelUnavailableError(
        machine
          ? `${machine.name} is not connected to this gateway right now.`
          : 'That machine is not registered with this gateway.',
        'machine_offline',
      );
    }
    if (tunnel.mux.activeStreams >= this.limits.streamsPerMachine) {
      throw new TunnelUnavailableError(
        'This machine already has the maximum number of open connections.',
        'stream_limit',
      );
    }
    return tunnel.mux.openStream({ serviceId, remoteAddr, proto: 'tcp' });
  }

  /** Close a machine's tunnel — used on revocation and on shutdown. */
  drop(machineId: string, reason: string, notify = false): void {
    const tunnel = this.tunnels.get(machineId);
    if (!tunnel) return;
    if (notify) tunnel.mux.sendControl({ t: 'revoked', reason });
    this.log.info('dropping tunnel', { machineId, reason });
    this.tunnels.delete(machineId);
    // Give the control frame a moment to flush before tearing the socket down.
    setTimeout(() => tunnel.dispose(), notify ? 50 : 0).unref();
    this.emit('disconnected', machineId);
  }

  shutdown(): void {
    for (const machineId of [...this.tunnels.keys()]) {
      this.drop(machineId, 'gateway shutting down');
    }
  }
}

export class TunnelUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: 'machine_offline' | 'stream_limit',
  ) {
    super(message);
    this.name = 'TunnelUnavailableError';
  }
}
