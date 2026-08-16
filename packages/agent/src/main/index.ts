#!/usr/bin/env node
import { Identity } from '../auth/identity.js';
import { TunnelClient } from '../tunnel/client.js';
import { startIpcServer, ipcPath, anotherAgentIsRunning, claimIpcSocket } from './ipc.js';

export { TunnelClient } from '../tunnel/client.js';
export { Identity, agentDataDir } from '../auth/identity.js';
export { enroll } from '../auth/enroll.js';
export { ipcPath, anotherAgentIsRunning, claimIpcSocket } from './ipc.js';
export { installAutostart, removeAutostart, autostartPath } from './service.js';
export { main as runAgent };
export { discoverLocalServices, classifyAddress } from '../service_proxy/local.js';
export type { TunnelStatus, TunnelState } from '../tunnel/client.js';

/**
 * Run the agent in this process until it is stopped.
 *
 * Exported so a front end — the CLI's `localtunnel agent` — can be the ExecStart
 * of a service unit without pointing systemd inside node_modules.
 */
export async function main(): Promise<void> {
  const identity = new Identity();

  // The desktop app spawns an agent, and the autostart entry (launchd/systemd/
  // Startup) also runs one. Only one may hold this machine's identity, so whoever
  // arrives second steps aside rather than fighting over the tunnel.
  const socketPath = ipcPath(identity.dataDir);
  try {
    await claimIpcSocket(socketPath);
  } catch {
    process.stdout.write('localtunnel-agent is already running; this instance will exit\n');
    process.exit(0);
  }

  const client = new TunnelClient(identity);

  client.on('status', (status) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...status, services: undefined })}\n`);
  });
  client.on('retry', ({ reason, delayMs, attempt }) => {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'retry', reason, delayMs, attempt })}\n`,
    );
  });
  client.on('revoked', (reason: string) => {
    process.stderr.write(`This machine was revoked: ${reason}\n`);
  });

  const ipc = startIpcServer({ client, identity });
  ipc.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stdout.write('localtunnel-agent is already running; this instance will exit\n');
      process.exit(0);
    }
  });
  process.stdout.write(`localtunnel-agent listening on ${ipcPath(identity.dataDir)}\n`);

  client.start();

  const shutdown = () => {
    client.stop();
    ipc.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  void main();
}
