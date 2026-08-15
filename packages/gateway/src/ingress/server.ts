import http from 'node:http';
import tls, { type TLSSocket } from 'node:tls';
import {
  ALPN,
  FrameType,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  type HelloMessage,
} from '@localtunnel/protocol';
import type { GatewayConfig } from '../main/config.js';
import type { Logger } from '../main/log.js';
import type { Store } from '../main/state.js';
import type { CaMaterial } from '../auth/ca.js';
import { certificateCommonName } from '../auth/ca.js';
import { ConnectionCounter, RateLimiter } from '../auth/limits.js';
import type { EnrollmentHandler } from '../auth/enroll.js';
import type { TunnelRegistry } from '../tunnels/registry.js';
import type { CertificateManager } from '../tls/certificates.js';
import type { AdminApi } from '../admin/api.js';
import type { HttpProxy } from './http-proxy.js';

const HELLO_TIMEOUT_MS = 10_000;

export interface IngressDeps {
  config: GatewayConfig;
  log: Logger;
  store: Store;
  identity: CaMaterial;
  ca: CaMaterial;
  certificates: CertificateManager;
  registry: TunnelRegistry;
  proxy: HttpProxy;
  admin: AdminApi;
  enrollment: EnrollmentHandler;
  connections: ConnectionCounter;
}

/**
 * The public listener. Everything the product needs arrives on TCP 443 and is
 * separated by TLS ALPN, so a user's provider firewall only ever needs two rules.
 */
export class IngressServer {
  private tlsServer: tls.Server | null = null;
  private httpServer: http.Server | null = null;
  private newConnections: RateLimiter;

  constructor(private readonly deps: IngressDeps) {
    this.newConnections = new RateLimiter(deps.config.limits.connectionsPerIpPerMinute, 60_000);
  }

  async listen(): Promise<void> {
    await this.listenTls();
    await this.listenPlainHttp();
  }

  private async listenTls(): Promise<void> {
    const { config, log, identity, ca, certificates } = this.deps;

    this.tlsServer = tls.createServer({
      // Default identity, used for the tunnel/enrol/admin ALPNs and any handshake
      // whose SNI we do not recognise.
      cert: identity.certPem,
      key: identity.keyPem,
      ca: [ca.certPem],
      // Client certificates are requested for everyone but only *required* for the
      // tunnel ALPN, which is enforced explicitly below.
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      ALPNProtocols: [ALPN.tunnel, ALPN.enroll, ALPN.admin, 'h2', 'http/1.1'],
      SNICallback: (servername, callback) => {
        const context = certificates.contextFor(servername);
        // Unknown SNI falls back to the identity certificate rather than a
        // customer's, so no domain name is ever disclosed to a scanner.
        callback(null, context ?? undefined);
      },
      handshakeTimeout: config.limits.tlsHandshakeTimeoutMs,
    });

    this.tlsServer.on('secureConnection', (socket) => this.onSecureConnection(socket));
    this.tlsServer.on('tlsClientError', (err, socket) => {
      log.debug('tls handshake failed', {
        ip: (socket as unknown as { remoteAddress?: string }).remoteAddress,
        error: err.message,
      });
    });
    this.tlsServer.on('error', (err) => log.error('tls listener error', { error: err.message }));

    await new Promise<void>((resolve, reject) => {
      this.tlsServer!.once('error', reject);
      this.tlsServer!.listen(config.httpsPort, () => {
        log.info('listening', { port: config.httpsPort, protocols: 'tunnel/enrol/admin/https' });
        resolve();
      });
    });
  }

  /** Port 80 exists for ACME's http-01 challenge and to redirect bare http://. */
  private async listenPlainHttp(): Promise<void> {
    const { config, log, certificates } = this.deps;
    this.httpServer = http.createServer((req, res) => {
      const path = req.url ?? '/';
      const challenge = certificates.challengeResponse(path);
      if (challenge) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(challenge);
        return;
      }
      const host = (req.headers.host ?? '').split(':')[0];
      res.writeHead(301, { location: `https://${host}${path}` });
      res.end();
    });
    this.httpServer.on('error', (err) => log.error('http listener error', { error: err.message }));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(config.httpPort, () => {
        log.info('listening', { port: config.httpPort, protocols: 'acme/redirect' });
        resolve();
      });
    });
  }

  private onSecureConnection(socket: TLSSocket): void {
    const { log, config, connections } = this.deps;
    const ip = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';

    if (!this.newConnections.allow(ip)) {
      log.warn('connection rate limit', { ip });
      socket.destroy();
      return;
    }

    switch (socket.alpnProtocol) {
      case ALPN.tunnel:
        this.acceptTunnel(socket, ip);
        return;
      case ALPN.enroll:
        this.deps.enrollment.handle(socket, ip);
        return;
      case ALPN.admin:
        this.deps.admin.handle(socket);
        return;
      default: {
        const slot = connections.tryAcquire(ip);
        if (!slot.ok) {
          log.warn('public connection limit reached', { ip, reason: slot.reason });
          socket.end('HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n');
          return;
        }
        socket.setTimeout(config.limits.idleConnectionTimeoutMs, () => socket.destroy());
        socket.once('close', () => connections.release(ip));
        this.deps.proxy.handle(socket);
      }
    }
  }

  /**
   * Adopt an agent connection. Two separate checks: the TLS chain must verify
   * against our CA, and the identity in that certificate must map to a machine that
   * is registered and not revoked.
   */
  private acceptTunnel(socket: TLSSocket, ip: string): void {
    const { log, store, registry } = this.deps;

    if (!socket.authorized) {
      log.warn('tunnel rejected: client certificate not trusted', {
        ip,
        error: socket.authorizationError?.toString(),
      });
      socket.destroy();
      return;
    }

    const peer = socket.getPeerCertificate();
    const commonName = peer?.subject?.CN ?? certificateCommonName(pemFromPeer(peer));
    const machineId = Array.isArray(commonName) ? commonName[0] : commonName;
    if (!machineId) {
      log.warn('tunnel rejected: certificate has no machine id', { ip });
      socket.destroy();
      return;
    }

    const machine = store.machine(machineId);
    if (!machine || machine.revoked || store.isSerialRevoked(machine.certSerial)) {
      log.warn('tunnel rejected: machine unknown or revoked', { ip, machineId });
      socket.destroy();
      return;
    }

    // Wait for the hello frame before handing the socket to the registry, so a
    // silent connection cannot hold a slot open. Bytes that arrived after hello are
    // unshifted back onto the socket so the mux sees a clean stream.
    const timeout = setTimeout(() => {
      log.warn('tunnel rejected: no hello frame', { ip, machineId });
      socket.destroy();
    }, HELLO_TIMEOUT_MS);
    timeout.unref();

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < HEADER_SIZE) return;

      const type = buffered.readUInt8(0);
      const streamId = buffered.readUInt32BE(1);
      const length = buffered.readUInt32BE(5);
      if (type !== FrameType.CONTROL || streamId !== 0 || length > 64 * 1024) {
        clearTimeout(timeout);
        log.warn('tunnel rejected: first frame was not a hello', { ip, machineId });
        socket.destroy();
        return;
      }
      if (buffered.length < HEADER_SIZE + length) return;

      let hello: HelloMessage;
      try {
        hello = JSON.parse(buffered.subarray(HEADER_SIZE, HEADER_SIZE + length).toString('utf8'));
      } catch {
        clearTimeout(timeout);
        socket.destroy();
        return;
      }
      if (hello.t !== 'hello') {
        clearTimeout(timeout);
        socket.destroy();
        return;
      }

      clearTimeout(timeout);
      socket.removeListener('data', onData);
      const leftover = buffered.subarray(HEADER_SIZE + length);
      socket.pause();
      if (leftover.length > 0) socket.unshift(leftover);

      if (hello.protocol !== PROTOCOL_VERSION) {
        log.warn('tunnel protocol mismatch', { machineId, got: hello.protocol });
      }
      registry.accept(socket, hello, machineId);
      process.nextTick(() => socket.resume());
    };
    socket.on('data', onData);
    socket.on('error', () => clearTimeout(timeout));
  }

  close(): void {
    this.tlsServer?.close();
    this.httpServer?.close();
  }
}

function pemFromPeer(peer: tls.PeerCertificate | undefined): string {
  if (!peer?.raw) return '';
  const base64 = peer.raw.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}
