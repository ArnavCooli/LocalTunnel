import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { TunnelStream } from '@localtunnel/protocol';
import type { Logger } from '../main/log.js';
import type { ServiceRecord, Store } from '../main/state.js';
import { TunnelRegistry, TunnelUnavailableError } from '../tunnels/registry.js';

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

  constructor(private readonly options: HttpProxyOptions) {
    this.server = http.createServer({ keepAliveTimeout: 30_000 });
    this.server.on('request', (req, res) => void this.onRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket, head));
    this.server.on('clientError', (_err, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  /** Hand over a socket that has already completed TLS (or plain :80 traffic). */
  handle(socket: Duplex): void {
    this.server.emit('connection', socket);
  }

  private resolve(req: http.IncomingMessage): ServiceRecord | null {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (!host) return null;
    const service = this.options.store.serviceByHostname(host);
    if (!service) return null;
    return service.type === 'http' || service.type === 'https' ? service : null;
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
      const message =
        err instanceof TunnelUnavailableError
          ? err.message
          : 'This service is temporarily unavailable.';
      log.warn('no tunnel for request', { serviceId: service.id, error: String(err) });
      respondPage(res, 502, 'Service unavailable', message);
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
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
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
      log.warn('upstream error', { serviceId: service.id, error: refusal ?? err.message });
      if (!res.headersSent) {
        respondPage(res, 502, 'Service unavailable', refusal ?? localFailureMessage(service, err));
      } else {
        res.destroy();
      }
      stream.destroy();
    });

    req.pipe(upstream);
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

/** An http.Agent that hands the client exactly one pre-made connection. */
function oneShotAgent(stream: TunnelStream): http.Agent {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  (agent as unknown as { createConnection: () => unknown }).createConnection = () => stream;
  return agent;
}

function forwardHeaders(req: http.IncomingMessage, service: ServiceRecord): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  const existingFor = req.headers['x-forwarded-for'];
  const clientIp = remoteIp(req.socket);
  headers['x-forwarded-for'] = existingFor ? `${existingFor}, ${clientIp}` : clientIp;
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


function localFailureMessage(service: ServiceRecord, err: Error): string {
  const target = `${service.localHost}:${service.localPort}`;
  if (/ECONNREFUSED|dial_failed|connect/i.test(err.message)) {
    return `The tunnel is up, but nothing is listening on ${target} on your computer. Start the service and try again.`;
  }
  return 'This service is temporarily unavailable.';
}

/** A plain, self-explanatory error page — never a bare proxy error. */
function respondPage(res: http.ServerResponse, status: number, title: string, detail: string): void {
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
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
