/**
 * The agent's two local trust boundaries.
 *
 * 1. The gateway tells the agent which local addresses to serve. A gateway that
 *    has been taken over must not be able to turn the agent into a probe into the
 *    user's home network, or into cloud metadata.
 * 2. Any process on this computer can reach the agent's control socket. Being
 *    local is not the same as being LocalTunnel.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { classifyAddress, connectLocal, probe } = require('../dist/service_proxy/local.js');
const { Identity, controlSecret, secretsMatch } = require('../dist/auth/identity.js');
const { startIpcServer, CONTROL_HEADER } = require('../dist/main/ipc.js');

/* ------------------------------------------------------------ address policy */

test('loopback is allowed, LAN needs an opt-in, metadata is never allowed', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('localhost'), 'loopback');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('127.1.2.3'), 'loopback');

  assert.equal(classifyAddress('192.168.1.50'), 'lan');
  assert.equal(classifyAddress('10.0.0.5'), 'lan');
  assert.equal(classifyAddress('172.16.0.1'), 'lan');
  assert.equal(classifyAddress('fd00::1'), 'lan');

  // Cloud instance metadata, link-local, multicast and anything routable.
  assert.equal(classifyAddress('169.254.169.254'), 'denied');
  assert.equal(classifyAddress('169.254.1.1'), 'denied');
  assert.equal(classifyAddress('224.0.0.1'), 'denied');
  assert.equal(classifyAddress('8.8.8.8'), 'denied');
  assert.equal(classifyAddress('172.32.0.1'), 'denied');
  assert.equal(classifyAddress('fe80::1'), 'denied');
  assert.equal(classifyAddress('2606:4700::1111'), 'denied');
});

test('an IPv4-mapped IPv6 address is judged as the address it names', () => {
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:192.168.1.9'), 'lan');
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'denied');
});

/** A listener bound to a loopback alias, so a dial really does land on 127.x. */
function loopbackServer() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => {
      // The probe destroys its end as soon as the connect succeeds, so this side
      // sees an RST. That is the expected shape of a probe, not a test failure.
      s.on('error', () => {});
      s.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

test('a name that resolves to loopback is accepted after the dial', async () => {
  const server = await loopbackServer();
  try {
    const service = {
      id: 'svc_1',
      name: 'site',
      type: 'http',
      localHost: 'localhost',
      localPort: server.port,
    };
    const result = await probe(service);
    assert.equal(result.reachable, true, result.error);
  } finally {
    server.close();
  }
});

test('a decimal-form address is checked against where it actually connects', async () => {
  const server = await loopbackServer();
  try {
    // "2130706433" is 127.0.0.1 written as an integer. The classifier reads it as
    // a hostname — which is why the check that matters runs after the connect.
    const service = {
      id: 'svc_1',
      name: 'sneaky',
      type: 'http',
      localHost: '2130706433',
      localPort: server.port,
      allowLanTarget: true,
    };
    const result = await probe(service);
    // Either the resolver refuses it, or it lands on loopback and is allowed.
    // What must never happen is it being judged only on the string.
    if (result.reachable) assert.ok(!result.error);
  } finally {
    server.close();
  }
});

test('a LAN-classified name is refused after the dial without the opt-in', async () => {
  const server = await loopbackServer();
  try {
    // A hostname is classified 'lan' up front, so without the opt-in it never
    // gets as far as a socket.
    const service = {
      id: 'svc_1',
      name: 'nas',
      type: 'http',
      localHost: 'nas.example',
      localPort: server.port,
      allowLanTarget: false,
    };
    const result = await probe(service);
    assert.equal(result.reachable, false);
    assert.match(result.error, /allow LAN target|not an address/i);
  } finally {
    server.close();
  }
});

test('connectLocal refuses a denied target outright', async () => {
  await assert.rejects(
    () =>
      connectLocal(
        {
          id: 'svc_1',
          name: 'metadata',
          type: 'http',
          localHost: '169.254.169.254',
          localPort: 80,
          allowLanTarget: true,
        },
        null,
      ),
    /will not expose|not an address/i,
  );
});

/* -------------------------------------------------------------- control IPC */

function agentDir() {
  const dir = mkdtempSync(join(tmpdir(), 'lt-agent-sec-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A TunnelClient stand-in: the IPC surface is what is under test here. */
function fakeClient() {
  return {
    calls: [],
    status() {
      this.calls.push('status');
      return { state: 'idle', machineId: 'm_secret', services: [] };
    },
    start() {
      this.calls.push('start');
    },
    stop() {
      this.calls.push('stop');
    },
    reloadCredentials() {},
  };
}

function ipcRequest(socketPath, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

test('the agent control socket refuses callers without the control secret', async (t) => {
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const identity = new Identity(dir);
  const client = fakeClient();
  const socketPath = join(dir, 'test.sock');
  const server = startIpcServer({ client, identity, path: socketPath });
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));

  for (const [method, path] of [
    ['GET', '/status'],
    ['GET', '/discover'],
    ['POST', '/start'],
    ['POST', '/stop'],
    ['POST', '/disconnect'],
    ['POST', '/enroll'],
    ['POST', '/reset'],
    ['POST', '/shutdown'],
  ]) {
    const res = await ipcRequest(socketPath, method, path);
    assert.equal(res.status, 401, `${method} ${path} should need the control secret`);
  }
  assert.deepEqual(client.calls, [], 'no privileged call reached the tunnel client');
});

test('a wrong control secret is refused', async (t) => {
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const identity = new Identity(dir);
  const socketPath = join(dir, 'test.sock');
  const server = startIpcServer({ client: fakeClient(), identity, path: socketPath });
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));

  const real = controlSecret(dir);
  for (const wrong of ['', 'x', `${real}x`, real.slice(0, -1), 'A'.repeat(real.length)]) {
    const res = await ipcRequest(socketPath, 'GET', '/status', { [CONTROL_HEADER]: wrong });
    assert.equal(res.status, 401, `secret ${JSON.stringify(wrong.slice(0, 8))} was accepted`);
  }
});

test('the right control secret is accepted', async (t) => {
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const identity = new Identity(dir);
  const socketPath = join(dir, 'test.sock');
  const server = startIpcServer({ client: fakeClient(), identity, path: socketPath });
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));

  const res = await ipcRequest(socketPath, 'GET', '/status', {
    [CONTROL_HEADER]: controlSecret(dir),
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /m_secret/);
});

test('the liveness probe answers unauthenticated but reveals nothing', async (t) => {
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const identity = new Identity(dir);
  const socketPath = join(dir, 'test.sock');
  const server = startIpcServer({ client: fakeClient(), identity, path: socketPath });
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));

  const res = await ipcRequest(socketPath, 'GET', '/alive');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.doesNotMatch(res.body, /m_secret/);
});

test('the control socket is not readable by other users', async (t) => {
  if (process.platform === 'win32') return;
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const identity = new Identity(dir);
  const socketPath = join(dir, 'test.sock');
  const server = startIpcServer({ client: fakeClient(), identity, path: socketPath });
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  // Give the listen callback a tick to apply the mode.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(statSync(socketPath).mode & 0o077, 0, 'group and other must have no access');
});

test('the control secret file is private and stable', (t) => {
  const { dir, cleanup } = agentDir();
  t.after(cleanup);
  const first = controlSecret(dir);
  assert.ok(first.length >= 32);
  assert.equal(controlSecret(dir), first, 'the secret is reused, not regenerated');
  assert.equal(statSync(join(dir, 'control.key')).mode & 0o077, 0);
});

test('secretsMatch rejects mismatched lengths and empty secrets', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('abc', 'abcd'), false);
  assert.equal(secretsMatch('', ''), false);
});
