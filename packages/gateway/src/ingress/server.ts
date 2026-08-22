import http from 'node:http';
import tls, { type TLSSocket } from 'node:tls';
import {
  ALPN,
  FrameType,
  HEADER_SIZE,
  PROTOCOL_VERSION,
  isValidHostname,
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
      // Advertise only what the proxy can actually serve. Both are real here:
      // h2 sockets go to an HTTP/2 server, everything else to the HTTP/1.1 one.
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
      try {
        this.servePlainHttp(req, res, certificates);
      } catch (err) {
        log.warn('plain http request failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    });
    this.httpServer.on('clientError', (_err, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
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

  /** ACME http-01 challenges, and the redirect for visitors who typed `http://`. */
  private servePlainHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    certificates: CertificateManager,
  ): void {
    const path = req.url ?? '/';
    const challenge = certificates.challengeResponse(path);
    if (challenge) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(challenge);
      return;
    }

    /*
     * Redirect to the same name over HTTPS — but only if the request really did
     * name one of ours. `Host` and the request target are both attacker
     * controlled: reflecting them unchecked is an open redirect, and a value
     * Node's response writer rejects would throw out of this handler.
     */
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (!isValidHostname(host) || !certificates.serves(host)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('No service is published at this address.\n');
      return;
    }
    res.writeHead(301, { location: `https://${host}${safeRequestTarget(path)}` });
    res.end();
  }

  private onSecureConnection(socket: TLSSocket): void {
    const { log, config, connections } = this.deps;
    const ip = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    // Every socket here carries interactive, message-shaped traffic: tunnel
    // frames, HTTP requests, admin calls. Nagle's algorithm delays each of those
    // by up to a round trip waiting for more bytes that are not coming.
    socket.setNoDelay(true);

    if (!this.newConnections.allow(ip)) {
      log.warn('connection rate limit', { ip, alpn: socket.alpnProtocol || 'none' });
      /*
       * Say why, where the protocol allows it.
       *
       * A silent destroy reaches the other end as a bare ECONNRESET, which is
       * indistinguishable from a crash, a network fault or a bug — for the
       * visitor, for the operator reading a report, and for whoever is trying
       * to work out why an occasional request fails. Ordinary web traffic gets
       * a 429; the tunnel, enrol and admin ALPNs are not HTTP, so those still
       * close, but the log line above now records which one it was.
       */
      const alpn = socket.alpnProtocol;
      if (alpn === ALPN.tunnel || alpn === ALPN.enroll || alpn === ALPN.admin) {
        socket.destroy();
      } else {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\n' +
            'retry-after: 60\r\n' +
            'connection: close\r\n' +
            'content-length: 0\r\n\r\n',
        );
      }
      return;
    }

    switch (socket.alpnProtocol) {
      case ALPN.tunnel:
        // The OS notices a vanished peer long before the application heartbeat
        // does, which is what makes a reconnect after a network drop fast.
        socket.setKeepAlive(true, 15_000);
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
        // TLS has already negotiated the protocol, so the socket carries either an
        // HTTP/2 preface or an HTTP/1.1 request line.
        if (socket.alpnProtocol === 'h2') this.deps.proxy.handleH2(socket);
        else this.deps.proxy.handle(socket);
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

    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length) : Buffer.concat([buffered, chunk]);
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

/**
 * A request target safe to put in a Location header.
 *
 * Node's HTTP parser is more permissive about the request line than its response
 * writer is about header values, so anything outside the printable-ASCII range
 * that a URL may legally contain is percent-encoded rather than reflected.
 */
function safeRequestTarget(target: string): string {
  if (!target.startsWith('/')) return '/';
  return target.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%[\]]/g, (c) =>
    Array.from(Buffer.from(c, 'utf8'), (b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join(''),
  );
}

function pemFromPeer(peer: tls.PeerCertificate | undefined): string {
  if (!peer?.raw) return '';
  const base64 = peer.raw.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}
