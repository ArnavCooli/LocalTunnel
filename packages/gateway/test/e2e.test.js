/**
 * The flow the whole product exists for:
 *
 *   localhost:PORT  →  agent  →  encrypted tunnel  →  gateway  →  public HTTPS
 *
 * Everything below runs a real gateway, a real agent, real TLS and a real local web
 * server. Nothing is mocked.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Identity } = require('../../agent/dist/auth/identity.js');
const { enroll } = require('../../agent/dist/auth/enroll.js');
const { TunnelClient } = require('../../agent/dist/tunnel/client.js');

const { bootGateway, adminRequest, publicRequest, startLocalSite, waitFor } = require('./helpers.js');

const HOSTNAME = 'mysite.example.com';

/** Stand up gateway + local site + enrolled, connected agent. */
async function scaffold(siteHandler) {
  const ctx = await bootGateway();
  const site = await startLocalSite(siteHandler);
  const agentDir = mkdtempSync(join(tmpdir(), 'lt-agent-'));
  const identity = new Identity(agentDir);

  const tokenRes = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  assert.equal(tokenRes.status, 200, 'minting an enrolment token');

  const credentials = await enroll(
    {
      host: '127.0.0.1',
      port: ctx.httpsPort,
      token: tokenRes.body.token,
      fingerprint: ctx.fingerprint,
    },
    identity,
  );

  const client = new TunnelClient(identity);
  client.start();
  await waitFor(() => client.status().state === 'connected', { label: 'agent to connect' });

  return {
    ctx,
    site,
    identity,
    client,
    credentials,
    async publish(overrides = {}) {
      const res = await adminRequest(ctx, 'POST', '/v1/services', {
        machineId: credentials.machineId,
        name: 'My Website',
        type: 'http',
        localHost: '127.0.0.1',
        localPort: site.port,
        hostname: HOSTNAME,
        ...overrides,
      });
      assert.equal(res.status, 201, `publishing service: ${res.raw}`);
      // The self-signed certificate is generated asynchronously on publish.
      await waitFor(
        async () => {
          const certs = await adminRequest(ctx, 'GET', '/v1/certificates');
          return certs.body.certificates.some((c) => c.hostname === HOSTNAME && c.state === 'valid');
        },
        { label: 'certificate to be issued' },
      );
      return res.body.service;
    },
    async teardown() {
      client.stop();
      await site.stop();
      await ctx.stop();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

test('a local website becomes publicly reachable over HTTPS', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  const service = await env.publish();
  assert.equal(service.publicUrl, `https://${HOSTNAME}`);

  const res = await publicRequest(env.ctx, HOSTNAME, '/hello');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello from home: /hello');
});

test('the visitor\'s address and protocol reach the local service', async (t) => {
  let seen = null;
  const env = await scaffold((req, res) => {
    seen = req.headers;
    res.end('ok');
  });
  t.after(() => env.teardown());
  await env.publish();

  await publicRequest(env.ctx, HOSTNAME, '/');
  assert.ok(seen['x-forwarded-for'], 'X-Forwarded-For is set');
  assert.equal(seen['x-forwarded-proto'], 'https');
  assert.equal(seen['x-forwarded-host'], HOSTNAME);
  assert.equal(seen.host, HOSTNAME);
});

test('request and response bodies larger than the flow-control window survive', async (t) => {
  const payload = 'x'.repeat(900 * 1024);
  const env = await scaffold((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const received = Buffer.concat(chunks).length;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${received}:${payload}`);
    });
  });
  t.after(() => env.teardown());
  await env.publish();

  const res = await publicRequest(env.ctx, HOSTNAME, '/upload', {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(res.status, 200);
  const [received, echoed] = res.body.split(':');
  assert.equal(Number(received), payload.length, 'full request body arrived');
  assert.equal(echoed.length, payload.length, 'full response body came back');
});

test('an unknown hostname gets a 404 that does not disclose other services', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  const res = await publicRequest(env.ctx, 'someone-elses-domain.example', '/');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes(HOSTNAME), 'no other hostname is leaked');
});

test('a stopped local service produces a 502 that keeps the home network private', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  const service = await env.publish();
  await env.site.stop();

  const res = await publicRequest(env.ctx, HOSTNAME, '/');
  assert.equal(res.status, 502);
  assert.match(res.body, /temporarily unavailable/i);
  // A visitor is a stranger to this network: the page must not describe it.
  assert.doesNotMatch(res.body, new RegExp(String(env.site.port)), 'leaked the local port');
  assert.doesNotMatch(res.body, /127\.0\.0\.1|localhost/i, 'leaked the local address');
  assert.doesNotMatch(res.body, /nothing is listening/i, 'leaked the local failure reason');

  // Withholding detail from strangers is not the same as hiding it from the
  // owner: the failure is still visible over the authenticated admin API.
  const services = await adminRequest(env.ctx, 'GET', '/v1/services');
  const owned = services.body.services.find((s) => s.id === service.id);
  assert.ok(owned, 'the service is still listed for its owner');
  assert.ok(owned.stats.errors > 0, 'the failure is recorded against the service');
});

test('the tunnel reconnects by itself after the connection drops', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  assert.equal((await publicRequest(env.ctx, HOSTNAME, '/')).status, 200);

  // The agent now comes back within milliseconds of noticing, so the drop is
  // observed through its event rather than by polling for a state that no longer
  // lingers long enough to be sampled.
  const noticed = new Promise((resolve) => env.client.once('retry', resolve));

  // Simulate the home internet dropping: kill the tunnel from the gateway side.
  env.ctx.gateway.registry.drop(env.credentials.machineId, 'test: simulated network drop');
  await noticed;

  await waitFor(() => env.client.status().state === 'connected', {
    label: 'agent to reconnect',
    timeoutMs: 20000,
  });
  const after = await publicRequest(env.ctx, HOSTNAME, '/again');
  assert.equal(after.status, 200);
  assert.equal(after.body, 'hello from home: /again');
});

test('revoking a machine takes its services off the internet immediately', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();
  assert.equal((await publicRequest(env.ctx, HOSTNAME, '/')).status, 200);

  const res = await adminRequest(
    env.ctx,
    'POST',
    `/v1/machines/${env.credentials.machineId}/revoke`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.machine.revoked, true);

  await waitFor(() => env.client.status().state === 'revoked', { label: 'agent to see revocation' });
  assert.equal(env.identity.credentials(), null, 'the agent deleted its credential');

  const after = await publicRequest(env.ctx, HOSTNAME, '/');
  assert.equal(after.status, 404, 'the service is no longer routable');
});

test('the admin API rejects a wrong token', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  const res = await adminRequest(
    { ...env.ctx, adminToken: 'definitely-not-the-token' },
    'GET',
    '/v1/status',
  );
  assert.equal(res.status, 401);
});

test('enrolment tokens are single use', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  const tokenRes = await adminRequest(env.ctx, 'POST', '/v1/machines/enroll-token');
  const agentDir = mkdtempSync(join(tmpdir(), 'lt-agent2-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const first = await enroll(
    { host: '127.0.0.1', port: env.ctx.httpsPort, token: tokenRes.body.token, fingerprint: env.ctx.fingerprint },
    new Identity(agentDir),
  );
  assert.ok(first.machineId);

  const secondDir = mkdtempSync(join(tmpdir(), 'lt-agent3-'));
  t.after(() => rmSync(secondDir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      enroll(
        { host: '127.0.0.1', port: env.ctx.httpsPort, token: tokenRes.body.token, fingerprint: env.ctx.fingerprint },
        new Identity(secondDir),
      ),
    /not valid any more/i,
  );
});

test('a gateway with the wrong fingerprint is refused', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  const tokenRes = await adminRequest(env.ctx, 'POST', '/v1/machines/enroll-token');
  const agentDir = mkdtempSync(join(tmpdir(), 'lt-agent4-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      enroll(
        {
          host: '127.0.0.1',
          port: env.ctx.httpsPort,
          token: tokenRes.body.token,
          fingerprint: 'AA'.repeat(32),
        },
        new Identity(agentDir),
      ),
    /identity does not match/i,
  );
});

test('two machines can serve different hostnames through one gateway', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  // A second machine, with its own site.
  const secondSite = await startLocalSite((req, res) => res.end('second machine'));
  t.after(() => secondSite.stop());
  const secondDir = mkdtempSync(join(tmpdir(), 'lt-agent5-'));
  t.after(() => rmSync(secondDir, { recursive: true, force: true }));

  const tokenRes = await adminRequest(env.ctx, 'POST', '/v1/machines/enroll-token');
  const identity = new Identity(secondDir);
  const credentials = await enroll(
    { host: '127.0.0.1', port: env.ctx.httpsPort, token: tokenRes.body.token, fingerprint: env.ctx.fingerprint },
    identity,
  );
  const client = new TunnelClient(identity);
  t.after(() => client.stop());
  client.start();
  await waitFor(() => client.status().state === 'connected', { label: 'second agent to connect' });

  const created = await adminRequest(env.ctx, 'POST', '/v1/services', {
    machineId: credentials.machineId,
    name: 'Second site',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: secondSite.port,
    hostname: 'second.example.com',
  });
  assert.equal(created.status, 201, created.raw);
  await waitFor(async () => {
    const certs = await adminRequest(env.ctx, 'GET', '/v1/certificates');
    return certs.body.certificates.some((c) => c.hostname === 'second.example.com' && c.state === 'valid');
  }, { label: 'second certificate' });

  assert.equal((await publicRequest(env.ctx, HOSTNAME, '/')).body, 'hello from home: /');
  assert.equal((await publicRequest(env.ctx, 'second.example.com', '/')).body, 'second machine');
});

test('a temporary link works without the user owning a domain', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  // Exactly what the "Expose temporarily" checkbox sends: no hostname at all.
  const res = await adminRequest(env.ctx, 'POST', '/v1/services', {
    machineId: env.credentials.machineId,
    name: 'Dev server',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: env.site.port,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(res.status, 201, `temporary service should be accepted: ${res.raw}`);

  const service = res.body.service;
  assert.ok(service.hostname, 'the gateway must mint a hostname');
  // No wildcard domain is configured here, so it derives one from its own IP.
  assert.match(service.hostname, /^[a-f0-9]{10}\.127\.0\.0\.1\.sslip\.io$/);
  assert.equal(service.publicUrl, `https://${service.hostname}`);
  assert.ok(service.expiresAt, 'it should still expire');

  await waitFor(
    async () => {
      const certs = await adminRequest(env.ctx, 'GET', '/v1/certificates');
      return certs.body.certificates.some((c) => c.hostname === service.hostname && c.state === 'valid');
    },
    { label: 'a certificate for the temporary hostname' },
  );

  // And the link actually serves the local site.
  const visit = await publicRequest(env.ctx, service.hostname, '/temp');
  assert.equal(visit.status, 200);
  assert.equal(visit.body, 'hello from home: /temp');
});

test('a permanent web service still requires a hostname', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());

  const res = await adminRequest(env.ctx, 'POST', '/v1/services', {
    machineId: env.credentials.machineId,
    name: 'No hostname',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: env.site.port,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /hostname/i);
});

test('a real browser negotiates a protocol the gateway can actually speak', async (t) => {
  const tls = require('node:tls');
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  // Every browser offers h2 first. Advertising h2 without serving it made them
  // negotiate HTTP/2 and then fail — the tests missed it by pinning http/1.1.
  const negotiated = await new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: env.ctx.httpsPort,
        servername: HOSTNAME,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: false,
      },
      () => {
        const protocol = socket.alpnProtocol;
        socket.destroy();
        resolve(protocol);
      },
    );
    socket.on('error', reject);
  });

  // The invariant that matters: whatever gets negotiated must actually be served.
  // Advertising h2 without serving it broke every browser; serving only what is
  // advertised is the thing to hold onto.
  assert.ok(['h2', 'http/1.1'].includes(negotiated), `unexpected protocol: ${negotiated}`);

  // And the request still works over that negotiated protocol.
  const res = await publicRequest(env.ctx, HOSTNAME, '/browser');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello from home: /browser');
});

test('HTTP/2 is negotiated and actually served', async (t) => {
  const tls = require('node:tls');
  const http2 = require('node:http2');
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  const negotiated = await new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port: env.ctx.httpsPort, servername: HOSTNAME,
        ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false },
      () => { const p = socket.alpnProtocol; socket.destroy(); resolve(p); },
    );
    socket.on('error', reject);
  });
  assert.equal(negotiated, 'h2', 'a browser should get HTTP/2');

  const body = await new Promise((resolve, reject) => {
    const session = http2.connect(`https://${HOSTNAME}`, {
      createConnection: () =>
        tls.connect({ host: '127.0.0.1', port: env.ctx.httpsPort, servername: HOSTNAME,
          ALPNProtocols: ['h2'], rejectUnauthorized: false }),
    });
    session.on('error', reject);
    const req = session.request({ ':path': '/over-h2', ':method': 'GET' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('response', (headers) => {
      assert.equal(headers[':status'], 200);
    });
    req.on('end', () => { session.close(); resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(body, 'hello from home: /over-h2', 'the local site is served over HTTP/2');
});

test('HTTP/1.1 still works alongside HTTP/2', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();
  const res = await publicRequest(env.ctx, HOSTNAME, '/over-h1');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello from home: /over-h1');
});

test('text responses are compressed, and a forged X-Forwarded-For is replaced', async (t) => {
  let seen = null;
  const env = await scaffold((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>' + 'a'.repeat(4000) + '</html>');
  });
  t.after(() => env.teardown());
  await env.publish();

  const res = await publicRequest(env.ctx, HOSTNAME, '/', {
    headers: { 'accept-encoding': 'gzip', 'x-forwarded-for': '10.9.9.9' },
  });
  assert.equal(res.headers['content-encoding'], 'gzip', 'html should be compressed');
  assert.match(String(res.headers.vary ?? ''), /accept-encoding/i);

  // The visitor claimed to be 10.9.9.9; the local app must not be told that.
  assert.ok(seen, 'the local service saw the request');
  assert.ok(!String(seen['x-forwarded-for']).includes('10.9.9.9'), 'a forged chain must be discarded');
  assert.equal(seen['x-forwarded-for'], '127.0.0.1');
});

test('an image is not compressed', async (t) => {
  const env = await scaffold((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.alloc(4000, 7));
  });
  t.after(() => env.teardown());
  await env.publish();
  const res = await publicRequest(env.ctx, HOSTNAME, '/x.png', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers['content-encoding'], undefined);
});
