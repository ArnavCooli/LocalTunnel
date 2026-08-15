/**
 * Raw TCP forwarding — the path a Minecraft server or an SSH daemon takes, where the
 * client does not speak TLS-with-our-ALPN and therefore needs its own public port.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Identity } = require('../../agent/dist/auth/identity.js');
const { enroll } = require('../../agent/dist/auth/enroll.js');
const { TunnelClient } = require('../../agent/dist/tunnel/client.js');
const { bootGateway, adminRequest, freePort, waitFor } = require('./helpers.js');

async function connectedAgent(ctx) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-tcp-agent-'));
  const identity = new Identity(dir);
  const tokenRes = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  const credentials = await enroll(
    { host: '127.0.0.1', port: ctx.httpsPort, token: tokenRes.body.token, fingerprint: ctx.fingerprint },
    identity,
  );
  const client = new TunnelClient(identity);
  client.start();
  await waitFor(() => client.status().state === 'connected', { label: 'agent to connect' });
  return { client, credentials, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A stand-in for a game server: uppercases whatever it receives. */
async function startEchoServer() {
  const port = await freePort();
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk.toString().toUpperCase()));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, stop: () => new Promise((resolve) => server.close(resolve)) };
}

function talkTo(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out talking to the public port'));
    }, 8000);
    socket.once('connect', () => socket.write(message));
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('a raw TCP service is forwarded through the tunnel on its own public port', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const agent = await connectedAgent(ctx);
  t.after(() => {
    agent.client.stop();
    agent.cleanup();
  });
  const local = await startEchoServer();
  t.after(() => local.stop());

  const publicPort = await freePort();
  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: agent.credentials.machineId,
    name: 'Minecraft',
    type: 'tcp',
    localHost: '127.0.0.1',
    localPort: local.port,
    publicPort,
  });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.body.service.publicUrl, `127.0.0.1:${publicPort}`);

  const reply = await talkTo(publicPort, 'hello minecraft');
  assert.equal(reply, 'HELLO MINECRAFT');
});

test('the gateway refuses to hand out ports 80 and 443 to a service', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const agent = await connectedAgent(ctx);
  t.after(() => {
    agent.client.stop();
    agent.cleanup();
  });

  const res = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: agent.credentials.machineId,
    name: 'Sneaky',
    type: 'tcp',
    localHost: '127.0.0.1',
    localPort: 9999,
    publicPort: 443,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /reserved/i);
});

test('removing a TCP service closes its public port', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const agent = await connectedAgent(ctx);
  t.after(() => {
    agent.client.stop();
    agent.cleanup();
  });
  const local = await startEchoServer();
  t.after(() => local.stop());

  const publicPort = await freePort();
  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: agent.credentials.machineId,
    name: 'Temporary TCP',
    type: 'tcp',
    localHost: '127.0.0.1',
    localPort: local.port,
    publicPort,
  });
  assert.equal(created.status, 201);
  assert.equal(await talkTo(publicPort, 'x'), 'X');

  const removed = await adminRequest(ctx, 'DELETE', `/v1/services/${created.body.service.id}`);
  assert.equal(removed.status, 200);

  await assert.rejects(() => talkTo(publicPort, 'x'), 'the port should no longer accept connections');
});

test('the agent refuses a service pointing at a blocked address', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const agent = await connectedAgent(ctx);
  t.after(() => {
    agent.client.stop();
    agent.cleanup();
  });

  // Cloud instance metadata: never a legitimate target, even if the gateway asks.
  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: agent.credentials.machineId,
    name: 'Metadata',
    type: 'tcp',
    localHost: '169.254.169.254',
    localPort: 80,
    publicPort: await freePort(),
    allowLanTarget: true,
  });
  assert.equal(created.status, 201, 'the gateway stores it');

  // ...but the agent rejects it locally and says so.
  await waitFor(
    () => agent.client.status().services.every((s) => s.localHost !== '169.254.169.254'),
    { label: 'agent to reject the metadata address' },
  );
});

test('a LAN target is refused unless the user opted in', async (t) => {
  const { classifyAddress } = require('../../agent/dist/service_proxy/local.js');
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('localhost'), 'loopback');
  assert.equal(classifyAddress('192.168.1.50'), 'lan');
  assert.equal(classifyAddress('10.0.0.5'), 'lan');
  assert.equal(classifyAddress('172.16.4.2'), 'lan');
  assert.equal(classifyAddress('169.254.169.254'), 'denied');
  assert.equal(classifyAddress('8.8.8.8'), 'denied');
  assert.equal(classifyAddress('224.0.0.1'), 'denied');

  const { assertAllowed } = require('../../agent/dist/service_proxy/local.js');
  assert.throws(
    () => assertAllowed({ id: 's', name: 'x', type: 'tcp', localHost: '192.168.1.50', localPort: 80 }),
    /allow LAN target/,
  );
  assert.doesNotThrow(() =>
    assertAllowed({
      id: 's',
      name: 'x',
      type: 'tcp',
      localHost: '192.168.1.50',
      localPort: 80,
      allowLanTarget: true,
    }),
  );
});

test('temporary services are removed when they expire', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const agent = await connectedAgent(ctx);
  t.after(() => {
    agent.client.stop();
    agent.cleanup();
  });

  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: agent.credentials.machineId,
    name: 'Dev server',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: 3000,
    hostname: 'temp.example.com',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(created.status, 201);

  const expired = ctx.gateway.store.expireServices();
  assert.deepEqual(expired, [created.body.service.id]);
  assert.equal(ctx.gateway.store.service(created.body.service.id), undefined);
});
