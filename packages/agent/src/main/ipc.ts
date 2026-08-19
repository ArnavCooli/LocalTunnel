import http from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { discoverLocalServices } from '../service_proxy/local.js';
import { enroll } from '../auth/enroll.js';
import { Identity, secretsMatch } from '../auth/identity.js';
import type { TunnelClient } from '../tunnel/client.js';

/** Header a local client presents to prove it may drive this agent. */
export const CONTROL_HEADER = 'x-localtunnel-control';

/** The largest control request body the agent will read. */
const MAX_IPC_BODY_BYTES = 64 * 1024;

/**
 * The desktop app's channel to the background agent.
 *
 * A unix socket (named pipe on Windows) rather than a TCP port: nothing on the
 * network, not even localhost, can reach it.
 *
 * Being local is not by itself authorisation. This endpoint can enrol the
 * computer with a gateway, start and stop tunnels and erase its identity, so
 * every route except the liveness probe requires the control secret from the
 * agent's own 0700 data directory. That is a boundary another user's process
 * cannot cross, and on Windows — where a named pipe's ACL is not ours to set
 * from Node — it is the only boundary there is.
 */
export function ipcPath(dataDir = new Identity().dataDir): string {
  if (platform() === 'win32') return '\\\\.\\pipe\\localtunnel-agent';
  return process.env.LOCALTUNNEL_AGENT_SOCKET ?? join(dataDir, 'agent.sock');
}

/**
 * Is a healthy agent already running?
 *
 * Two agents sharing one credential is not a harmless duplicate: they have the same
 * machine identity, and the gateway only keeps the newest tunnel per machine. Each
 * would evict the other forever, so the tunnel would flap instead of staying up.
 */
export function anotherAgentIsRunning(socketPath = ipcPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      // `/alive` answers without the control secret on purpose: it reveals only
      // that an agent holds this socket, which is what a second instance needs
      // to know before standing aside.
      { socketPath, path: '/alive', method: 'GET', timeout: 2000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );
    // No socket file, or nothing listening on it: the previous agent is gone and
    // its socket is stale.
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export interface IpcOptions {
  client: TunnelClient;
  identity: Identity;
  path?: string;
}

export class AgentAlreadyRunningError extends Error {
  constructor() {
    super('another LocalTunnel agent already holds this machine\'s identity');
  }
}

/**
 * Claim the IPC socket, and with it the right to be this machine's agent.
 *
 * The bind itself is the lock. Deleting an existing socket before listening — as
 * this used to — lets a second process steal it from a live agent, and then both
 * run: they share one machine identity, the gateway keeps only the newest tunnel,
 * and they evict each other forever.
 */
export async function claimIpcSocket(socketPath: string): Promise<void> {
  if (platform() === 'win32') return;
  if (!existsSync(socketPath)) return;
  if (await anotherAgentIsRunning(socketPath)) throw new AgentAlreadyRunningError();
  // Nothing answered, so the socket is left over from a crashed agent.
  try {
    unlinkSync(socketPath);
  } catch {
    /* ignore */
  }
}

export function startIpcServer(options: IpcOptions): http.Server {
  const { client, identity } = options;
  const socketPath = options.path ?? ipcPath(identity.dataDir);

  const secret = identity.controlSecret();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // Liveness only. It carries no information about the machine, its gateway or
    // its services, so it is the one route that answers unauthenticated.
    if (method === 'GET' && path === '/alive') {
      return json(res, 200, { ok: true });
    }

    const presented = req.headers[CONTROL_HEADER];
    if (typeof presented !== 'string' || !secretsMatch(presented, secret)) {
      return json(res, 401, {
        error:
          'This request did not present the local control secret. Only LocalTunnel ' +
          'on this user account may drive the agent.',
      });
    }

    if (method === 'GET' && path === '/status') {
      return json(res, 200, client.status());
    }

    if (method === 'GET' && path === '/discover') {
      return json(res, 200, { services: await discoverLocalServices() });
    }

    if (method === 'POST' && path === '/enroll') {
      const body = await readJson<{ host: string; port: number; token: string; fingerprint: string }>(req);
      if (!body.host || !body.token || !body.fingerprint) {
        return json(res, 400, { error: 'host, token and fingerprint are required' });
      }
      const credentials = await enroll(
        { host: body.host, port: body.port || 443, token: body.token, fingerprint: body.fingerprint },
        identity,
      );
      client.reloadCredentials();
      client.start();
      return json(res, 200, { machineId: credentials.machineId, gatewayId: credentials.gatewayId });
    }

    if (method === 'POST' && path === '/start') {
      client.start();
      return json(res, 200, client.status());
    }

    if (method === 'POST' && path === '/stop') {
      client.stop();
      return json(res, 200, client.status());
    }

    if (method === 'POST' && path === '/disconnect') {
      client.stop();
      identity.clearCredentials();
      client.reloadCredentials();
      return json(res, 200, { ok: true });
    }

    // Full reset: forget the private key too, so the next enrolment produces a
    // completely new machine rather than reusing this one's keypair.
    if (method === 'POST' && path === '/reset') {
      client.stop();
      identity.reset();
      client.reloadCredentials();
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150).unref();
      return;
    }

    // Stop for real: unlinking should leave no agent process behind, or the user
    // has "stopped" something that is still running.
    if (method === 'POST' && path === '/shutdown') {
      client.stop();
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150).unref();
      return;
    }

    json(res, 404, { error: 'no such endpoint' });
  }

  server.listen(socketPath, () => {
    // Belt as well as braces: the data directory is already 0700, but the socket
    // itself is created with the process umask, and LOCALTUNNEL_AGENT_SOCKET can
    // put it somewhere far less private. Windows named pipes have no mode bits —
    // the control secret is what protects them.
    if (platform() !== 'win32') {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        /* a socket we cannot chmod is still guarded by the control secret */
      }
    }
  });
  return server;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_IPC_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
