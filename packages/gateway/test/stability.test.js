/**
 * Tunnel stability.
 *
 * The failure these cover: two agent processes sharing one machine identity. The
 * gateway keeps only the newest tunnel per machine, so each would evict the other
 * forever and the tunnel would flap instead of staying up.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Identity } = require('../../agent/dist/auth/identity.js');
const { enroll } = require('../../agent/dist/auth/enroll.js');
const { TunnelClient } = require('../../agent/dist/tunnel/client.js');
const { anotherAgentIsRunning } = require('../../agent/dist/main/ipc.js');
const { bootGateway, adminRequest, waitFor } = require('./helpers.js');

const AGENT_ENTRY = join(__dirname, '..', '..', 'agent', 'dist', 'main', 'index.js');

async function enrolledIdentity(ctx, dir) {
  const identity = new Identity(dir);
  const token = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  const credentials = await enroll(
    { host: '127.0.0.1', port: ctx.httpsPort, token: token.body.token, fingerprint: ctx.fingerprint },
    identity,
  );
  return { identity, credentials };
}

test('a second agent sharing the same identity refuses to start', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-single-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, 'agent.sock');

  // Nothing listening yet.
  assert.equal(await anotherAgentIsRunning(socket), false, 'no agent should be detected initially');

  const first = spawn(process.execPath, [AGENT_ENTRY], {
    env: { ...process.env, LOCALTUNNEL_AGENT_DIR: dir, LOCALTUNNEL_AGENT_SOCKET: socket },
    stdio: 'pipe',
  });
  t.after(() => first.kill());
  await waitFor(() => anotherAgentIsRunning(socket), { label: 'first agent to be listening' });

  // A second process with the same data directory must stand down.
  const second = spawn(process.execPath, [AGENT_ENTRY], {
    env: { ...process.env, LOCALTUNNEL_AGENT_DIR: dir, LOCALTUNNEL_AGENT_SOCKET: socket },
    stdio: 'pipe',
  });
  let output = '';
  second.stdout.on('data', (c) => {
    output += c.toString();
  });

  const exitCode = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(exitCode, 0, 'the second agent should exit cleanly rather than compete');
  assert.match(output, /already running/i);
  assert.equal(await anotherAgentIsRunning(socket), true, 'the first agent is still serving');
});

test('two tunnels for one machine would flap — the newest wins and the old one is evicted', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const dir = mkdtempSync(join(tmpdir(), 'lt-flap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { identity, credentials } = await enrolledIdentity(ctx, dir);

  const a = new TunnelClient(identity);
  t.after(() => a.stop());
  a.start();
  await waitFor(() => a.status().state === 'connected', { label: 'first tunnel' });

  // A second client with the *same* credentials — what two agent processes did.
  const b = new TunnelClient(identity);
  t.after(() => b.stop());
  b.start();
  await waitFor(() => b.status().state === 'connected', { label: 'second tunnel' });

  // The gateway keeps exactly one tunnel per machine…
  assert.equal(ctx.gateway.registry.isConnected(credentials.machineId), true);
  // …and the first client is knocked off, which is precisely the flap.
  await waitFor(() => a.status().state !== 'connected', {
    label: 'first tunnel to be evicted',
    timeoutMs: 10000,
  });

  a.stop();
  b.stop();
});

test('a single tunnel stays connected across heartbeat cycles', async (t) => {
  // Real heartbeats are 15s apart, so watching two of them used to mean a 36s
  // sleep in the middle of the suite. The interval is configuration, so this
  // runs the same number of cycles with the clock turned up.
  const heartbeatMs = 500;
  const ctx = await bootGateway({ limits: { heartbeatMs } });
  t.after(() => ctx.stop());
  const dir = mkdtempSync(join(tmpdir(), 'lt-steady-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { identity, credentials } = await enrolledIdentity(ctx, dir);
  const client = new TunnelClient(identity);
  t.after(() => client.stop());

  const states = [];
  client.on('status', (s) => {
    if (states[states.length - 1] !== s.state) states.push(s.state);
  });

  client.start();
  await waitFor(() => client.status().state === 'connected', { label: 'tunnel to come up' });

  // More than the three missed beats that would have the gateway declare the
  // tunnel dead: a broken ping/pong shows up here as a reconnect.
  await new Promise((resolve) => setTimeout(resolve, heartbeatMs * 8));

  assert.equal(client.status().state, 'connected', `state churned: ${states.join(' → ')}`);
  assert.ok(
    !states.includes('reconnecting'),
    `the tunnel should never have reconnected, saw: ${states.join(' → ')}`,
  );
  assert.equal(client.status().attempts, 0, 'no retry attempts should have been made');
  assert.ok(
    typeof client.status().latencyMs === 'number',
    'heartbeats should have measured a round-trip latency',
  );
  assert.equal(ctx.gateway.registry.isConnected(credentials.machineId), true);
});
