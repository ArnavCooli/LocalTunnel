import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { isValidHostname, isValidPort, type ServiceType } from '@localtunnel/protocol';
import type { GatewayConfig } from '../main/config.js';
import type { Logger } from '../main/log.js';
import { sha256, type Store } from '../main/state.js';
import type { TunnelRegistry } from '../tunnels/registry.js';
import type { CertificateManager } from '../tls/certificates.js';
import type { TcpForwarder } from '../ingress/tcp-forwarder.js';
import type { RateLimiter } from '../auth/limits.js';

const GATEWAY_VERSION = '1.0.0';
const MAX_BODY_BYTES = 256 * 1024;

export interface AdminDeps {
  config: GatewayConfig;
  store: Store;
  registry: TunnelRegistry;
  certificates: CertificateManager;
  forwarder: TcpForwarder;
  log: Logger;
  limiter: RateLimiter;
  /** Called after any change that affects routing, so the gateway can re-sync. */
  onChange: () => void | Promise<void>;
  startedAt: Date;
}

/**
 * The management API the desktop app talks to. It lives behind its own ALPN on 443,
 * so it shares the single public port without ever being reachable from a browser
 * that wanders onto the gateway's IP.
 *
 * There is deliberately no endpoint here that runs a command, reads a file, or
 * otherwise offers shell-equivalent access.
 */
export class AdminApi {
  private server: http.Server;

  constructor(private readonly deps: AdminDeps) {
    this.server = http.createServer((req, res) => void this.route(req, res));
    this.server.on('clientError', (_e, socket) => socket.destroy());
  }

  handle(socket: Duplex): void {
    this.server.emit('connection', socket);
  }

  private authorized(req: http.IncomingMessage, ip: string): boolean {
    if (!this.deps.limiter.remaining(ip)) return false;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return false;
    const provided = Buffer.from(sha256(token), 'hex');
    const expected = Buffer.from(this.deps.config.adminTokenHash, 'hex');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    if (!this.authorized(req, ip)) {
      this.deps.limiter.fail(ip);
      this.deps.log.warn('admin auth failed', { ip, path: req.url });
      return json(res, 401, { error: 'unauthorized' });
    }
    this.deps.limiter.reset(ip);

    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      const handled = await this.dispatch(method, path, url, req, res);
      if (!handled) json(res, 404, { error: 'no such endpoint' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.error('admin request failed', { path, error: message });
      if (!res.headersSent) json(res, 500, { error: message });
    }
  }

  private async dispatch(
    method: string,
    path: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const { store, registry, certificates, forwarder, config } = this.deps;

    if (method === 'GET' && path === '/v1/status') {
      json(res, 200, this.status());
      return true;
    }

    /* --------------------------------------------------------- machines */

    if (method === 'GET' && path === '/v1/machines') {
      json(res, 200, { machines: this.machines() });
      return true;
    }

    if (method === 'POST' && path === '/v1/machines/enroll-token') {
      const { token, record } = store.createEnrollToken();
      this.deps.log.info('enrolment token minted', { expiresAt: record.expiresAt });
      json(res, 200, { token, expiresAt: record.expiresAt, gatewayId: config.gatewayId });
      return true;
    }

    const revokeMatch = /^\/v1\/machines\/([\w-]+)\/revoke$/.exec(path);
    if (method === 'POST' && revokeMatch) {
      const machine = store.revokeMachine(revokeMatch[1]);
      if (!machine) return json(res, 404, { error: 'no such machine' }), true;
      registry.drop(machine.id, 'Machine revoked by administrator', true);
      await this.deps.onChange();
      json(res, 200, { machine: this.machine(machine.id) });
      return true;
    }

    const machineMatch = /^\/v1\/machines\/([\w-]+)$/.exec(path);
    if (machineMatch) {
      const id = machineMatch[1];
      if (method === 'DELETE') {
        registry.drop(id, 'Machine removed by administrator', true);
        store.removeMachine(id);
        await this.deps.onChange();
        json(res, 200, { ok: true });
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson<{ name?: string }>(req);
        const machine = store.machine(id);
        if (!machine) return json(res, 404, { error: 'no such machine' }), true;
        if (typeof body.name === 'string' && body.name.trim()) {
          machine.name = body.name.trim().slice(0, 64);
          store.save();
        }
        json(res, 200, { machine: this.machine(id) });
        return true;
      }
      if (method === 'GET') {
        const machine = this.machine(id);
        if (!machine) return json(res, 404, { error: 'no such machine' }), true;
        json(res, 200, { machine });
        return true;
      }
    }

    /* --------------------------------------------------------- services */

    if (method === 'GET' && path === '/v1/services') {
      json(res, 200, { services: store.services.map((s) => this.service(s.id)) });
      return true;
    }

    if (method === 'POST' && path === '/v1/services') {
      const body = await readJson<Record<string, unknown>>(req);
      const validation = validateService(body, store);
      if ('error' in validation) return json(res, 400, { error: validation.error }), true;

      const service = store.addService(validation.value);
      if (service.hostname) void certificates.ensure(service.hostname);
      await forwarder.reconcile();
      registry.syncServices(service.machineId);
      await this.deps.onChange();
      this.deps.log.info('service created', {
        serviceId: service.id,
        type: service.type,
        hostname: service.hostname,
        publicPort: service.publicPort,
      });
      json(res, 201, { service: this.service(service.id) });
      return true;
    }

    const serviceMatch = /^\/v1\/services\/([\w-]+)$/.exec(path);
    if (serviceMatch) {
      const id = serviceMatch[1];
      const existing = store.service(id);
      if (!existing) return json(res, 404, { error: 'no such service' }), true;

      if (method === 'PATCH') {
        const body = await readJson<Record<string, unknown>>(req);
        const patch: Record<string, unknown> = {};
        if (typeof body.name === 'string') patch.name = body.name.slice(0, 64);
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (typeof body.localPort === 'number' && isValidPort(body.localPort)) {
          patch.localPort = body.localPort;
        }
        if (typeof body.localHost === 'string') patch.localHost = body.localHost;
        const updated = store.updateService(id, patch)!;
        if (updated.hostname && updated.enabled) void certificates.ensure(updated.hostname);
        await forwarder.reconcile();
        registry.syncServices(updated.machineId);
        await this.deps.onChange();
        json(res, 200, { service: this.service(id) });
        return true;
      }

      if (method === 'DELETE') {
        const machineId = existing.machineId;
        const hostname = existing.hostname;
        store.removeService(id);
        if (hostname) certificates.forget(hostname);
        await forwarder.reconcile();
        registry.syncServices(machineId);
        await this.deps.onChange();
        this.deps.log.info('service removed', { serviceId: id });
        json(res, 200, { ok: true });
        return true;
      }
    }

    /* ----------------------------------------------------- certificates */

    if (method === 'GET' && path === '/v1/certificates') {
      json(res, 200, { certificates: certificates.allStatuses() });
      return true;
    }

    const issueMatch = /^\/v1\/certificates\/([a-z0-9.-]+)\/issue$/i.exec(path);
    if (method === 'POST' && issueMatch) {
      const hostname = issueMatch[1].toLowerCase();
      certificates.forget(hostname);
      await certificates.ensure(hostname);
      json(res, 200, { certificate: certificates.status(hostname) });
      return true;
    }

    /* ------------------------------------------------------- diagnostics */

    if (method === 'GET' && path === '/v1/diagnostics') {
      json(res, 200, this.diagnostics(url.searchParams.get('serviceId')));
      return true;
    }

    return false;
  }

  /* ------------------------------------------------------------ shaping */

  private status() {
    const { store, registry, certificates, forwarder, config } = this.deps;
    return {
      gateway: {
        id: config.gatewayId,
        name: config.name,
        version: GATEWAY_VERSION,
        publicIp: config.publicIp,
        httpsPort: config.httpsPort,
        httpPort: config.httpPort,
        tlsMode: config.tls.mode,
        startedAt: this.deps.startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - this.deps.startedAt.getTime()) / 1000),
        totals: store.totals,
      },
      machines: this.machines(),
      services: store.services.map((s) => this.service(s.id)),
      certificates: certificates.allStatuses(),
      ports: [
        { port: config.httpsPort, proto: 'tcp', label: 'HTTPS', open: true },
        { port: config.httpPort, proto: 'tcp', label: 'HTTP', open: true },
        ...forwarder.openPorts.map(({ port, proto }) => ({
          port,
          proto,
          label: store.serviceByPublicPort(port)?.name ?? 'Service',
          open: true,
        })),
      ],
      connectedMachines: registry.all(),
    };
  }

  private machines() {
    return this.deps.store.machines.map((m) => this.machine(m.id)!);
  }

  private machine(id: string) {
    const machine = this.deps.store.machine(id);
    if (!machine) return null;
    const tunnel = this.deps.registry.info(id);
    return {
      ...machine,
      connected: tunnel !== null,
      latencyMs: tunnel?.latencyMs ?? null,
      activeStreams: tunnel?.activeStreams ?? 0,
      agentVersion: tunnel?.agentVersion ?? null,
      serviceCount: this.deps.store.servicesForMachine(id).length,
    };
  }

  private service(id: string) {
    const service = this.deps.store.service(id);
    if (!service) return null;
    const tunnel = this.deps.registry.info(service.machineId);
    const probe = tunnel?.probes[service.id];
    const cert = service.hostname ? this.deps.certificates.status(service.hostname) : null;
    const machineConnected = tunnel !== null;
    return {
      ...service,
      machineConnected,
      localReachable: probe?.reachable ?? null,
      localError: probe?.error ?? null,
      certificate: cert,
      publicUrl: service.hostname
        ? `https://${service.hostname}`
        : service.publicPort
          ? `${this.deps.config.publicIp}:${service.publicPort}`
          : null,
      status: !service.enabled
        ? 'disabled'
        : !machineConnected
          ? 'machine_offline'
          : probe && !probe.reachable
            ? 'local_unreachable'
            : 'online',
    };
  }

  /** Everything the gateway itself can see; the desktop app checks the rest. */
  private diagnostics(serviceId: string | null) {
    const { store, registry, certificates } = this.deps;
    const services = serviceId ? [store.service(serviceId)].filter(Boolean) : store.services;
    return {
      gateway: { ok: true, publicIp: this.deps.config.publicIp },
      services: services.map((service) => {
        const s = service!;
        const tunnel = registry.info(s.machineId);
        const probe = tunnel?.probes[s.id];
        return {
          serviceId: s.id,
          name: s.name,
          machineConnected: tunnel !== null,
          machineLatencyMs: tunnel?.latencyMs ?? null,
          localServiceReachable: probe?.reachable ?? null,
          localServiceError: probe?.error ?? null,
          certificate: s.hostname ? certificates.status(s.hostname) : null,
          expectedDnsTarget: this.deps.config.publicIp,
          hostname: s.hostname,
          publicPort: s.publicPort,
        };
      }),
    };
  }
}

/* ------------------------------------------------------------- helpers */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

type NewService = Parameters<Store['addService']>[0];

function validateService(
  body: Record<string, unknown>,
  store: Store,
): { value: NewService } | { error: string } {
  const type = body.type as ServiceType;
  if (!['http', 'https', 'tcp', 'udp'].includes(type)) {
    return { error: 'type must be one of http, https, tcp, udp' };
  }
  const machineId = String(body.machineId ?? '');
  if (!store.machine(machineId)) return { error: 'unknown machine' };
  if (store.machine(machineId)!.revoked) return { error: 'that machine is revoked' };

  const localPort = Number(body.localPort);
  if (!isValidPort(localPort)) return { error: 'localPort must be between 1 and 65535' };
  const localHost = String(body.localHost ?? '127.0.0.1');
  if (!/^[\w.:-]+$/.test(localHost)) return { error: 'localHost is not a valid address' };

  const hostname = body.hostname ? String(body.hostname).toLowerCase() : null;
  const publicPort = body.publicPort == null ? null : Number(body.publicPort);

  if (type === 'http' || type === 'https') {
    if (!hostname || !isValidHostname(hostname)) {
      return { error: 'a public hostname like mysite.example.com is required for web services' };
    }
    const clash = store.serviceByHostname(hostname);
    if (clash) return { error: `${hostname} is already used by "${clash.name}"` };
  } else {
    if (publicPort === null || !isValidPort(publicPort)) {
      return { error: 'a public port is required for TCP and UDP services' };
    }
    if (publicPort === 80 || publicPort === 443) {
      return { error: 'ports 80 and 443 are reserved for the gateway itself' };
    }
    const clash = store.serviceByPublicPort(publicPort);
    if (clash) return { error: `port ${publicPort} is already used by "${clash.name}"` };
  }

  const expiresAt = body.expiresAt ? String(body.expiresAt) : null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return { error: 'expiresAt must be an ISO timestamp' };
  }

  return {
    value: {
      machineId,
      name: String(body.name ?? 'Service').slice(0, 64) || 'Service',
      type,
      localHost,
      localPort,
      hostname: type === 'http' || type === 'https' ? hostname : null,
      publicPort: type === 'tcp' || type === 'udp' ? publicPort : null,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      allowLanTarget: Boolean(body.allowLanTarget),
      expiresAt,
    },
  };
}
