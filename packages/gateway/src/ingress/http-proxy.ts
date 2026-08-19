import http from 'node:http';
import http2 from 'node:http2';
import zlib from 'node:zlib';
import type { Duplex } from 'node:stream';
import type { TunnelStream } from '@localtunnel/protocol';
import type { Logger } from '../main/log.js';
import type { ServiceRecord, Store } from '../main/state.js';
import { TunnelRegistry, TunnelUnavailableError } from '../tunnels/registry.js';

/** Requests and responses arrive over either protocol; the handling is shared. */
type AnyRequest = http.IncomingMessage | http2.Http2ServerRequest;
type AnyResponse = http.ServerResponse | http2.Http2ServerResponse;

/** How long the local service has to respond before the visitor gets a 504. */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Only worth compressing text; images and archives are already compressed. */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|xhtml|rss|atom|manifest|wasm)|image\/svg)/i;

/**
 * What a visitor is told when something behind the tunnel is broken.
 *
 * Everything more specific — which machine is offline, which local host and port
 * refused the connection, what the agent said — describes the inside of someone's
 * home network, and the person reading a public error page is not its owner. The
 * detail goes to the gateway log and to the owner's Diagnostics screen instead.
 */
const PUBLIC_FAILURE = 'This service is temporarily unavailable. Please try again shortly.';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface HttpProxyOptions {
  store: Store;
  registry: TunnelRegistry;
  log: Logger;
  /** Set on responses once the hostname has a valid certificate. */
  hsts: boolean;
}

/**
 * Layer-7 ingress: terminates the visitor's HTTP request on the VPS and replays it
 * down a fresh tunnel stream, so the home machine sees an ordinary local request.
 */
export class HttpProxy {
  private server: http.Server;
  private h2Server: http2.Http2Server;

  constructor(private readonly options: HttpProxyOptions) {
    this.server = http.createServer({ keepAliveTimeout: 30_000 });
    this.server.on('request', (req, res) => this.guard(this.onRequest(req, res), res));
    this.server.on('upgrade', (req, socket, head) =>
      this.onUpgrade(req, socket, head).catch(() => {
        if (!socket.destroyed) socket.destroy();
      }),
    );
    this.server.on('clientError', (_err, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    /*
     * HTTP/2. TLS has already run, so a cleartext h2 server is exactly right: what
     * arrives on the socket after the handshake is the h2 preface either way.
     * The compatibility API gives the same req/res shape as HTTP/1.1, so one
     * request path serves both.
     */
    this.h2Server = http2.createServer({ settings: { enablePush: false } });
    this.h2Server.on('request', (req, res) => this.guard(this.onRequest(req, res), res));
    this.h2Server.on('sessionError', () => {
      /* a broken client should not take the gateway down */
    });
    this.h2Server.on('clientError', (_err, socket) => socket.destroy());
  }

  /**
   * Nothing a visitor sends may take the gateway down.
   *
   * These handlers are async, so a throw becomes a rejected promise — and an
   * unhandled rejection ends the Node process. Header values that Node's server
   * accepts but its client rejects are one way to provoke exactly that, so the
   * failure is contained here and answered with a 502 instead.
   */
  private guard(work: Promise<void>, res: AnyResponse): void {
    work.catch((err) => {
      this.options.log.error('request handler failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        if (!res.headersSent) respondPage(res, 502, 'Service unavailable', PUBLIC_FAILURE);
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  }

  /** Hand over a socket that has already completed TLS (or plain :80 traffic). */
  handle(socket: Duplex): void {
    this.server.emit('connection', socket);
  }

  /** The same, for a socket whose ALPN negotiated HTTP/2. */
  handleH2(socket: Duplex): void {
    this.h2Server.emit('connection', socket);
  }

  private resolve(req: AnyRequest): ServiceRecord | null {
    // HTTP/2 carries the target in :authority; HTTP/1.1 in Host.
    const authority = (req.headers[':authority'] as string | undefined) ?? req.headers.host ?? '';
    const host = authority.split(':')[0].toLowerCase();
    if (!host) return null;
    const service = this.options.store.serviceByHostname(host);
    if (!service) return null;
    return service.type === 'http' || service.type === 'https' ? service : null;
  }

  private async onRequest(req: AnyRequest, res: AnyResponse): Promise<void> {
    const { store, registry, log } = this.options;
    const service = this.resolve(req);

    if (!service) {
      // Deliberately does not reveal which hostnames this gateway does serve.
      respondPage(res, 404, 'Not found', 'No service is published at this address.');
      return;
    }

    let stream: TunnelStream;
    try {
      stream = registry.openStream(service.machineId, service.id, remoteAddr(req.socket));
    } catch (err) {
      store.recordServiceError(service.id);
      log.warn('no tunnel for request', {
        serviceId: service.id,
        machineId: service.machineId,
        code: err instanceof TunnelUnavailableError ? err.code : 'unknown',
        error: String(err),
      });
      respondPage(res, 502, 'Service unavailable', PUBLIC_FAILURE);
      return;
    }

    // The stream is torn down with a reason whenever the agent refuses the open or
    // the tunnel drops; the HTTP client below turns that into the 502 response.
    stream.on('error', () => {});

    const agent = oneShotAgent(stream);
    const headers = forwardHeaders(req, service);

    const upstream = http.request(
      {
        method: req.method,
        path: req.url,
        timeout: UPSTREAM_TIMEOUT_MS,
        headers,
        agent,
        // The agent dials the local service itself; these are placeholders that
        // never leave this process.
        host: service.localHost,
        port: service.localPort,
      },
      (upstreamRes) => {
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) outHeaders[name] = value;
        }
        if (this.options.hsts) {
          outHeaders['strict-transport-security'] = 'max-age=31536000';
        }

        // Compress text on the way out. The tunnel is the narrow part of the
        // path, so this is the cheapest speed-up available — but never for
        // already-encoded bodies, and never for server-sent events, which must
        // not be buffered.
        const status = upstreamRes.statusCode ?? 502;
        const contentType = String(upstreamRes.headers['content-type'] ?? '');
        const compress =
          /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) &&
          !upstreamRes.headers['content-encoding'] &&
          !/text\/event-stream/i.test(contentType) &&
          COMPRESSIBLE.test(contentType) &&
          req.method !== 'HEAD' &&
          status !== 204 &&
          status !== 304;

        if (compress) {
          delete outHeaders['content-length'];
          outHeaders['content-encoding'] = 'gzip';
          outHeaders.vary = outHeaders.vary ? `${String(outHeaders.vary)}, Accept-Encoding` : 'Accept-Encoding';
          writeHead(res, status, outHeaders);
          const gzip = zlib.createGzip();
          gzip.on('error', () => res.destroy());
          upstreamRes.pipe(gzip).pipe(res as unknown as NodeJS.WritableStream);
        } else {
          writeHead(res, status, outHeaders);
          upstreamRes.pipe(res as unknown as NodeJS.WritableStream);
        }

        upstreamRes.on('end', () => {
          store.recordResponse(service.id, upstreamRes.statusCode ?? 0);
          store.recordTraffic(service.id, stream.bytesOut, stream.bytesIn);
        });
      },
    );

    // When the agent cannot reach the local service it closes the stream with a
    // reason. That reason is written for a person to read, so prefer it over
    // whatever the HTTP client makes of the socket going away.
    let refusal: string | null = null;
    stream.on('remote-close', (reason: { reason: string }) => {
      refusal = reason.reason;
    });

    upstream.on('error', (err) => {
      store.recordServiceError(service.id);
      // The agent's own words are the useful diagnostic, and they name the user's
      // local host and port — so they go in the log, never in the public page.
      log.warn('upstream error', {
        serviceId: service.id,
        target: `${service.localHost}:${service.localPort}`,
        error: refusal ?? err.message,
      });
      if (!res.headersSent) {
        respondPage(res, 502, 'Service unavailable', PUBLIC_FAILURE);
      } else {
        res.destroy();
      }
      stream.destroy();
    });

    upstream.on('timeout', () => {
      log.warn('upstream timed out', {
        serviceId: service.id,
        target: `${service.localHost}:${service.localPort}`,
        afterSeconds: UPSTREAM_TIMEOUT_MS / 1000,
      });
      store.recordServiceError(service.id);
      if (!res.headersSent) {
        respondPage(
          res,
          504,
          'Service timed out',
          'The service did not respond in time. Please try again shortly.',
        );
      }
      upstream.destroy();
      stream.destroy();
    });

    req.pipe(upstream as unknown as NodeJS.WritableStream);
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
  }

  /** WebSockets and other Upgrade traffic pass through as raw bytes. */
  private async onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { store, registry } = this.options;
    const service = this.resolve(req);
    if (!service) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    let stream: TunnelStream;
    try {
      stream = registry.openStream(service.machineId, service.id, remoteAddr(socket));
    } catch {
      store.recordServiceError(service.id);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    const headers = forwardHeaders(req, service);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const single of Array.isArray(value) ? value : [value]) {
        if (single !== undefined) lines.push(`${name}: ${single}`);
      }
    }
    // Upgrade and Connection are hop-by-hop for proxies in general, but for a
    // WebSocket handshake they are exactly what the local server needs to see.
    if (req.headers.upgrade) lines.push(`Upgrade: ${req.headers.upgrade}`);
    lines.push('Connection: Upgrade', '', '');
    stream.write(lines.join('\r\n'));
    if (head.length > 0) stream.write(head);

    stream.pipe(socket);
    socket.pipe(stream);

    const cleanup = () => {
      store.recordTraffic(service.id, stream.bytesOut, stream.bytesIn);
      if (!stream.destroyed) stream.destroy();
      if (!socket.destroyed) socket.destroy();
    };
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    stream.on('error', cleanup);
    stream.on('close', cleanup);
  }
}

function writeHead(res: AnyResponse, status: number, headers: http.OutgoingHttpHeaders): void {
  (res as http.ServerResponse).writeHead(status, headers);
}

/** An http.Agent that hands the client exactly one pre-made connection. */
function oneShotAgent(stream: TunnelStream): http.Agent {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  (agent as unknown as { createConnection: () => unknown }).createConnection = () => stream;
  return agent;
}

function forwardHeaders(req: AnyRequest, service: ServiceRecord): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    // `:method`, `:path`, `:scheme`, `:authority` are HTTP/2 pseudo-headers and are
    // rejected by an HTTP/1.1 client, so they are translated rather than copied.
    if (name.startsWith(':')) continue;
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  const clientIp = remoteIp(req.socket);
  // Set, never append. A visitor can send any X-Forwarded-For they like, and
  // appending would let them forge the chain the local app trusts.
  headers['x-forwarded-for'] = clientIp;
  headers.host = (req.headers[':authority'] as string | undefined) ?? req.headers.host ?? '';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = service.hostname ?? req.headers.host ?? '';
  headers['x-real-ip'] = clientIp;
  return headers;
}

function remoteIp(socket: { remoteAddress?: string | null }): string {
  return socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

function remoteAddr(socket: { remoteAddress?: string | null; remotePort?: number } | Duplex): string {
  const peer = socket as { remoteAddress?: string | null; remotePort?: number };
  return `${remoteIp(peer)}:${peer.remotePort ?? 0}`;
}



/** A plain, self-explanatory error page — never a bare proxy error. */
function respondPage(res: AnyResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
  main{max-width:34rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{color:#9198a1;margin:0}
  .tag{font:12px ui-monospace,monospace;color:#6e7681;margin-top:1.5rem;display:block}
</style></head><body><main>
<h1>${title}</h1><p>${escapeHtml(detail)}</p>
<span class="tag">LocalTunnel gateway</span>
</main></body></html>`;
  writeHead(res, status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
