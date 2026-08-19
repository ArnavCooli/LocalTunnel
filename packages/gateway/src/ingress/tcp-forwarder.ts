import net from 'node:net';
import dgram from 'node:dgram';
import type { Logger } from '../main/log.js';
import type { Store } from '../main/state.js';
import type { TunnelRegistry } from '../tunnels/registry.js';
import type { ConnectionCounter } from '../auth/limits.js';
import type { Firewall } from '../system/firewall.js';

/**
 * Concurrent UDP source addresses one public port will track.
 *
 * A datagram's source address is unverified, so a single sender can invent as
 * many of them as it likes. Each one costs a tunnel stream, and streams are a
 * per-machine budget shared with that machine's web services — without a cap
 * here, a UDP flood takes the owner's websites down as collateral.
 */
const MAX_UDP_SESSIONS_PER_PORT = 256;

/**
 * Layer-4 ingress for services that are not HTTP — a Minecraft server, an SSH
 * daemon, a game server. Each such service gets its own public port, opened and
 * closed by the gateway (including the host firewall rule) as services come and go.
 */
export class TcpForwarder {
  private listeners = new Map<number, net.Server>();
  private udpSockets = new Map<number, dgram.Socket>();

  constructor(
    private readonly store: Store,
    private readonly registry: TunnelRegistry,
    private readonly log: Logger,
    private readonly connections: ConnectionCounter,
    private readonly firewall: Firewall,
  ) {}

  /** Bring the set of open public ports in line with the enabled services. */
  async reconcile(): Promise<void> {
    const wanted = this.store.publicServicePorts();
    const wantedTcp = new Set(wanted.filter((p) => p.proto === 'tcp').map((p) => p.port));
    const wantedUdp = new Set(wanted.filter((p) => p.proto === 'udp').map((p) => p.port));

    for (const [port, server] of this.listeners) {
      if (!wantedTcp.has(port)) {
        server.close();
        this.listeners.delete(port);
        await this.firewall.closePort(port, 'tcp');
        this.log.info('closed public tcp port', { port });
      }
    }
    for (const [port, socket] of this.udpSockets) {
      if (!wantedUdp.has(port)) {
        socket.close();
        this.udpSockets.delete(port);
        await this.firewall.closePort(port, 'udp');
        this.log.info('closed public udp port', { port });
      }
    }
    for (const port of wantedTcp) {
      if (!this.listeners.has(port)) await this.openTcp(port);
    }
    for (const port of wantedUdp) {
      if (!this.udpSockets.has(port)) await this.openUdp(port);
    }
  }

  private async openTcp(port: number): Promise<void> {
    const server = net.createServer((socket) => this.onConnection(port, socket));
    // A port that cannot be bound — already in use, or privileged — must fail the
    // reconcile rather than leave it awaiting a callback that will never fire.
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.log.error('could not open public tcp port', { port, error: err.message });
        server.close();
        resolve(false);
      };
      server.once('error', onError);
      server.listen(port, () => {
        server.removeListener('error', onError);
        resolve(true);
      });
    });
    if (!listening) return;

    server.on('error', (err) => {
      this.log.error('tcp listener error', { port, error: err.message });
      this.listeners.delete(port);
    });
    this.listeners.set(port, server);
    await this.firewall.openPort(port, 'tcp');
    this.log.info('opened public tcp port', { port });
  }

  private onConnection(port: number, socket: net.Socket): void {
    const service = this.store.serviceByPublicPort(port);
    const ip = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    if (!service) {
      socket.destroy();
      return;
    }
    const slot = this.connections.tryAcquire(ip);
    if (!slot.ok) {
      this.log.warn('connection limit reached', { port, ip, reason: slot.reason });
      socket.destroy();
      return;
    }

    let stream;
    try {
      stream = this.registry.openStream(service.machineId, service.id, `${ip}:${socket.remotePort}`);
    } catch (err) {
      this.store.recordServiceError(service.id);
      this.log.warn('no tunnel for tcp connection', { port, error: String(err) });
      this.connections.release(ip);
      socket.destroy();
      return;
    }

    service.stats.connections += 1;
    socket.setNoDelay(true);
    socket.pipe(stream);
    stream.pipe(socket);

    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      this.connections.release(ip);
      this.store.recordTraffic(service.id, stream.bytesOut, stream.bytesIn);
      if (!socket.destroyed) socket.destroy();
      if (!stream.destroyed) stream.destroy();
    };
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    stream.on('error', cleanup);
    stream.on('close', cleanup);
  }

  /**
   * UDP forwarding. Datagrams have no connection to multiplex, so each source
   * address gets a short-lived stream carrying length-prefixed datagrams.
   */
  private async openUdp(port: number): Promise<void> {
    const socket = dgram.createSocket('udp4');
    const sessions = new Map<string, { stream: import('@localtunnel/protocol').TunnelStream; timer: NodeJS.Timeout }>();

    socket.on('message', (msg, rinfo) => {
      const service = this.store.serviceByPublicPort(port);
      if (!service) return;
      const key = `${rinfo.address}:${rinfo.port}`;
      let session = sessions.get(key);
      if (!session) {
        if (sessions.size >= MAX_UDP_SESSIONS_PER_PORT) {
          this.log.warn('udp session limit reached', { port, sources: sessions.size });
          return;
        }
        let stream;
        try {
          stream = this.registry.openStream(service.machineId, service.id, key);
        } catch {
          this.store.recordServiceError(service.id);
          return;
        }
        const timer = setTimeout(() => {
          sessions.delete(key);
          stream.destroy();
        }, 30_000);
        timer.unref();
        session = { stream, timer };
        sessions.set(key, session);

        // Datagrams coming back are framed the same way.
        let buffer = Buffer.alloc(0);
        stream.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 2) {
            const length = buffer.readUInt16BE(0);
            if (buffer.length < 2 + length) break;
            socket.send(buffer.subarray(2, 2 + length), rinfo.port, rinfo.address);
            buffer = buffer.subarray(2 + length);
          }
        });
        stream.on('close', () => {
          clearTimeout(timer);
          sessions.delete(key);
        });
      }
      session.timer.refresh();
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(msg.length, 0);
      session.stream.write(Buffer.concat([header, msg]));
    });

    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.log.error('could not open public udp port', { port, error: err.message });
        try {
          socket.close();
        } catch {
          /* never bound */
        }
        resolve(false);
      };
      socket.once('error', onError);
      socket.bind(port, () => {
        socket.removeListener('error', onError);
        resolve(true);
      });
    });
    if (!bound) return;

    socket.on('error', (err) => this.log.error('udp listener error', { port, error: err.message }));
    this.udpSockets.set(port, socket);
    await this.firewall.openPort(port, 'udp');
    this.log.info('opened public udp port', { port });
  }

  get openPorts(): { port: number; proto: 'tcp' | 'udp' }[] {
    return [
      ...[...this.listeners.keys()].map((port) => ({ port, proto: 'tcp' as const })),
      ...[...this.udpSockets.keys()].map((port) => ({ port, proto: 'udp' as const })),
    ];
  }

  close(): void {
    for (const server of this.listeners.values()) server.close();
    for (const socket of this.udpSockets.values()) socket.close();
    this.listeners.clear();
    this.udpSockets.clear();
  }
}
