import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_HEADER,
  agentDataDir,
  anotherAgentIsRunning,
  autostartPath,
  controlSecret,
  ipcPath,
  installAutostart,
  removeAutostart,
  type TunnelStatus,
} from '@localtunnel/agent';

/**
 * Talking to the background agent on this computer.
 *
 * The agent owns the tunnel and this machine's private key; the CLI only asks it
 * questions over the same unix socket the desktop app uses, so the two front ends
 * can be used interchangeably on the same machine.
 */

export type { TunnelStatus };

export interface DiscoveredService {
  port: number;
  guess: 'http' | 'tcp';
}

const SOCKET = () => ipcPath(agentDataDir());

function ipc<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET(),
        path,
        method,
        timeout: 30_000,
        // Being a local process is not authorisation; the agent wants the secret
        // from its own data directory, which only this user can read.
        headers: {
          [CONTROL_HEADER]: controlSecret(agentDataDir()),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = { error: text.slice(0, 300) };
          }
          if ((res.statusCode ?? 500) >= 400) {
            const detail =
              parsed && typeof parsed === 'object' && 'error' in parsed
                ? String((parsed as { error: unknown }).error)
                : `the agent returned status ${res.statusCode}`;
            reject(new AgentError(detail));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new AgentError('The agent did not answer in time.'));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new AgentNotRunningError());
      } else {
        reject(new AgentError(err.message));
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export class AgentError extends Error {}

export class AgentNotRunningError extends AgentError {
  constructor() {
    super('The LocalTunnel agent is not running on this computer.');
  }
}

export const agent = {
  running: () => anotherAgentIsRunning(SOCKET()),
  status: () => ipc<TunnelStatus>('GET', '/status'),
  discover: () => ipc<{ services: DiscoveredService[] }>('GET', '/discover'),
  enroll: (body: { host: string; port: number; token: string; fingerprint: string }) =>
    ipc<{ machineId: string; gatewayId: string }>('POST', '/enroll', body),
  start: () => ipc<TunnelStatus>('POST', '/start'),
  pause: () => ipc<TunnelStatus>('POST', '/stop'),
  disconnect: () => ipc<{ ok: boolean }>('POST', '/disconnect'),
  reset: () => ipc<{ ok: boolean }>('POST', '/reset'),
  shutdown: () => ipc<{ ok: boolean }>('POST', '/shutdown'),
  autostartPath,
  autostartInstalled: () => existsSync(autostartPath()),
};

/** Where the agent's entrypoint lives, whether installed or run from a checkout. */
export function agentScriptPath(): string {
  try {
    return require.resolve('@localtunnel/agent');
  } catch {
    // Running from source without the workspace link (a bare `node dist/index.js`).
    const local = join(__dirname, '..', '..', 'agent', 'dist', 'main', 'index.js');
    if (existsSync(local)) return local;
    throw new AgentError(
      'Could not find the LocalTunnel agent. Run `npm run build` in the LocalTunnel checkout first.',
    );
  }
}

/**
 * Start the agent in the background and wait until it answers.
 *
 * Detached with its output in a log file, so the tunnel outlives the shell — closing
 * the terminal should not take the user's website down.
 */
export async function ensureAgentRunning(): Promise<'already' | 'started'> {
  if (await agent.running()) return 'already';

  const logPath = join(agentDataDir(), 'agent.log');
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [agentScriptPath()], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await agent.running()) return 'started';
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new AgentError(`The agent did not start. Check ${logPath} for what went wrong.`);
}

export async function enableAutostart(): Promise<string> {
  return installAutostart({ execPath: process.execPath, scriptPath: agentScriptPath() });
}

export async function disableAutostart(): Promise<void> {
  await removeAutostart();
}

export function agentLogPath(): string {
  return join(agentDataDir(), 'agent.log');
}
