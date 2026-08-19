/**
 * The gateway's public edge, exercised the way a stranger would.
 *
 * Everything here arrives from the open internet on ports 80 and 443, before any
 * authentication exists — so the only correct responses are ones that neither
 * describe someone's home network nor take the process down.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');

const { bootGateway, adminRequest } = require('./helpers.js');

/** Enrol a throwaway machine so services can be published against it. */
async function enrolledMachine(ctx, token, t) {
  const { Identity } = require('../../agent/dist/auth/identity.js');
  const { enroll } = require('../../agent/dist/auth/enroll.js');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'lt-ingress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return enroll(
    { host: '127.0.0.1', port: ctx.httpsPort, token, fingerprint: ctx.fingerprint },
    new Identity(dir),
  );
}

/** A raw request on the plain-HTTP port, so the request line can be malformed. */
function plainRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(requestText));
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    setTimeout(() => socket.destroy(), 4000).unref();
  });
}

function plainGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, timeout: 4000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

test('port 80 only redirects to hostnames this gateway actually serves', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  // A hostname nobody published must not be reflected back as a redirect: that
  // is an open redirect wearing this gateway's address.
  const stranger = await plainGet(ctx.httpPort, '/', { host: 'evil.example.com' });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.location, null);
  assert.doesNotMatch(stranger.body, /evil\.example\.com/);
});

test('port 80 survives host headers that a response writer would reject', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  // Bytes Node's request parser tolerates but its response writer refuses. If
  // these escaped the handler they would end the process, not the request.
  const hostile = [
    'Host: \x80\x81\xffexample.com',
    'Host: exam ple.com',
    'Host: ' + 'a'.repeat(2000) + '.com',
    'Host: .',
    'Host: ..',
    'Host: -leading.example.com',
  ];
  for (const header of hostile) {
    const response = await plainRequest(
      ctx.httpPort,
      `GET / HTTP/1.1\r\n${header}\r\nConnection: close\r\n\r\n`,
    );
    assert.ok(response.length > 0, `no answer for ${JSON.stringify(header)}`);
    assert.doesNotMatch(response, /^HTTP\/1\.1 (301|302)/, `redirected on ${header}`);
  }

  // Still alive and still answering after all of that.
  const after = await plainGet(ctx.httpPort, '/', { host: 'evil.example.com' });
  assert.equal(after.status, 404);
});

test('a published hostname still gets its redirect to HTTPS', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  const tokenRes = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  const credentials = await enrolledMachine(ctx, tokenRes.body.token, t);
  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: credentials.machineId,
    name: 'Site',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: 3000,
    hostname: 'redirect-test.example.com',
  });
  assert.equal(created.status, 201, created.raw);

  const res = await plainGet(ctx.httpPort, '/some/path?a=1', {
    host: 'redirect-test.example.com',
  });
  assert.equal(res.status, 301);
  assert.equal(res.location, 'https://redirect-test.example.com/some/path?a=1');
});

test('the admin API rejects a certificate issue for a hostname it does not serve', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  // Issuing on demand for arbitrary names is how an authenticated caller would
  // spend the server's ACME quota on domains that are nothing to do with it.
  const res = await adminRequest(ctx, 'POST', '/v1/certificates/not-ours.example.com/issue');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no service/i);
});

test('the admin API rejects a malformed hostname for certificate issue', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());
  const res = await adminRequest(ctx, 'POST', '/v1/certificates/.../issue');
  assert.equal(res.status, 400);
});

test('a service localHost cannot be patched to something create would reject', async (t) => {
  const ctx = await bootGateway();
  t.after(() => ctx.stop());

  const tokenRes = await adminRequest(ctx, 'POST', '/v1/machines/enroll-token');
  assert.equal(tokenRes.status, 200);

  const credentials = await enrolledMachine(ctx, tokenRes.body.token, t);

  const created = await adminRequest(ctx, 'POST', '/v1/services', {
    machineId: credentials.machineId,
    name: 'Site',
    type: 'http',
    localHost: '127.0.0.1',
    localPort: 3000,
    hostname: 'patch-test.example.com',
  });
  assert.equal(created.status, 201, created.raw);

  for (const bad of ['127.0.0.1 ; rm -rf /', 'host with spaces', 'a/../b', '']) {
    const patched = await adminRequest(ctx, 'PATCH', `/v1/services/${created.body.service.id}`, {
      localHost: bad,
    });
    assert.equal(patched.status, 400, `localHost ${JSON.stringify(bad)} was accepted`);
  }

  // A legitimate change still goes through.
  const ok = await adminRequest(ctx, 'PATCH', `/v1/services/${created.body.service.id}`, {
    localHost: '192.168.1.20',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.service.localHost, '192.168.1.20');
});
