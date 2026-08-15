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

test('a stopped local service produces a readable 502, not a bare proxy error', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();
  await env.site.stop();

  const res = await publicRequest(env.ctx, HOSTNAME, '/');
  assert.equal(res.status, 502);
  assert.match(res.body, /nothing is listening/i);
  assert.match(res.body, new RegExp(String(env.site.port)));
});

test('the tunnel reconnects by itself after the connection drops', async (t) => {
  const env = await scaffold();
  t.after(() => env.teardown());
  await env.publish();

  assert.equal((await publicRequest(env.ctx, HOSTNAME, '/')).status, 200);

  // Simulate the home internet dropping: kill the tunnel from the gateway side.
  env.ctx.gateway.registry.drop(env.credentials.machineId, 'test: simulated network drop');
  await waitFor(() => env.client.status().state === 'reconnecting', { label: 'agent to notice' });

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
