/**
 * The abuse controls, tested on their own.
 *
 * These used to be exercised only incidentally, by the rest of the suite
 * happening to share one source address with them — which meant the harness
 * competed with the code under test for the same budget and produced failures
 * that looked like anything but a rate limit. Here the limit is the subject:
 * set deliberately small, and asserted on directly.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');

const { ALPN } = require('../../protocol/dist/index.js');
const { DEFAULT_LIMITS } = require('../dist/main/config.js');
const { RateLimiter, ConnectionCounter } = require('../dist/auth/limits.js');
const { bootGateway, adminRequest } = require('./helpers.js');

/** One TLS connection; resolves with what the gateway did with it. */
function probe(port, alpn) {
  return new Promise((resolve) => {
    const chunks = [];
    const socket = tls.connect(
      { host: '127.0.0.1', port, ALPNProtocols: [alpn], rejectUnauthorized: false },
      () => socket.write('GET / HTTP/1.1\r\nhost: nobody.example.com\r\nconnection: close\r\n\r\n'),
    );
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (err) => resolve({ outcome: 'error', code: err.code ?? err.message }));
    socket.on('close', () => resolve({ outcome: 'closed', text: Buffer.concat(chunks).toString('utf8') }));
    setTimeout(() => socket.destroy(), 5000).unref();
  });
}

test('the per-IP connection rate limit actually rejects, and says so', async (t) => {
  const budget = 5;
  const ctx = await bootGateway({
    limits: { ...DEFAULT_LIMITS, connectionsPerIpPerMinute: budget },
  });
  t.after(() => ctx.stop());

  const results = [];
  for (let i = 0; i < budget + 3; i++) {
    results.push(await probe(ctx.httpsPort, 'http/1.1'));
  }

  const limited = results.filter((r) => r.outcome === 'closed' && /429 Too Many Requests/.test(r.text));
  assert.ok(limited.length >= 3, `expected the tail to be rate limited, got ${JSON.stringify(results.map((r) => r.outcome))}`);

  // A refusal a person can diagnose, rather than a bare connection reset.
  assert.match(limited[0].text, /retry-after: 60/);

  // And the ones inside the budget were served normally.
  const served = results.slice(0, budget).filter((r) => r.outcome === 'closed' && /404|HTTP\/1\.1/.test(r.text));
  assert.ok(served.length > 0, 'connections within the allowance should be answered');
});

test('the admin ALPN is still closed outright when rate limited', async (t) => {
  const ctx = await bootGateway({
    limits: { ...DEFAULT_LIMITS, connectionsPerIpPerMinute: 3 },
  });
  t.after(() => ctx.stop());

  for (let i = 0; i < 3; i++) await probe(ctx.httpsPort, ALPN.admin);
  const over = await probe(ctx.httpsPort, ALPN.admin);
  // Not HTTP, so there is nothing meaningful to answer with — but it must be
  // refused rather than served.
  assert.ok(
    over.outcome === 'error' || !/200 OK/.test(over.text ?? ''),
    'an over-budget admin connection must not be served',
  );
});

test('a generous allowance does not interfere with ordinary use', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  // The harness raises the limit; twenty back-to-back admin calls must all work.
  for (let i = 0; i < 20; i++) {
    const res = await adminRequest(ctx, 'GET', '/v1/status');
    assert.equal(res.status, 200, `request ${i} was rejected`);
  }
});

/* ------------------------------------------------------- the units themselves */

test('RateLimiter counts within a window and resets after it', () => {
  const limiter = new RateLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.equal(limiter.allow('a', t0), true);
  assert.equal(limiter.allow('a', t0), true);
  assert.equal(limiter.allow('a', t0), true);
  assert.equal(limiter.allow('a', t0), false, 'the fourth in the window is refused');
  // A different key has its own budget.
  assert.equal(limiter.allow('b', t0), true);
  // Past the window, the budget is fresh.
  assert.equal(limiter.allow('a', t0 + 1001), true);
});

test('ConnectionCounter bounds per IP and in total, and releases cleanly', () => {
  const counter = new ConnectionCounter(2, 3);
  assert.deepEqual(counter.tryAcquire('a'), { ok: true });
  assert.deepEqual(counter.tryAcquire('a'), { ok: true });
  assert.deepEqual(counter.tryAcquire('a'), { ok: false, reason: 'per_ip' });

  assert.deepEqual(counter.tryAcquire('b'), { ok: true });
  assert.deepEqual(counter.tryAcquire('b'), { ok: false, reason: 'total' });

  counter.release('a');
  assert.deepEqual(counter.tryAcquire('a'), { ok: true });
  assert.equal(counter.active, 3);

  // Releasing more than was taken must not drive the count negative, or the
  // gateway would slowly grant itself unlimited connections.
  for (let i = 0; i < 10; i++) counter.release('a');
  assert.equal(counter.active, 0);
  assert.deepEqual(counter.tryAcquire('a'), { ok: true });
});

test('a listener that cannot bind fails the reconcile instead of hanging', async (t) => {
  // Hold a port so the forwarder cannot have it.
  const squatter = net.createServer();
  const port = await new Promise((resolve) => {
    squatter.listen(0, '127.0.0.1', () => resolve(squatter.address().port));
  });
  t.after(() => new Promise((r) => squatter.close(r)));

  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  const tokenRes = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  const { Identity } = require('../../agent/dist/auth/identity.js');
  const { enroll } = require('../../agent/dist/auth/enroll.js');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'lt-bind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const credentials = await enroll(
    { host: '127.0.0.1', port: ctx.httpsPort, token: tokenRes.body.token, fingerprint: ctx.fingerprint },
    new Identity(dir),
  );

  // Publishing on the taken port must answer, not wedge: `listen` reporting an
  // error used to leave reconcile awaiting a callback that never came.
  const created = await Promise.race([
    adminRequest(ctx, 'POST', '/v1/services', {
      machineId: credentials.machineId,
      name: 'Squatted',
      type: 'tcp',
      localHost: '127.0.0.1',
      localPort: 25565,
      publicPort: port,
    }),
    new Promise((_r, reject) => setTimeout(() => reject(new Error('reconcile hung')), 10_000)),
  ]);
  assert.equal(created.status, 201);

  // And the gateway is still healthy afterwards.
  const status = await adminRequest(ctx, 'GET', '/v1/status');
  assert.equal(status.status, 200);
});
