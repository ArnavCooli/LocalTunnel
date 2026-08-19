const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { ALPN } = require('../../protocol/dist/index.js');
const { startGateway, defaultConfig } = require('../dist/main/index.js');
const { DEFAULT_LIMITS } = require('../dist/main/config.js');

/** A throwaway directory that cleans itself up. */
function tempDir(prefix = 'lt-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Boot a real gateway on loopback with self-signed web certificates. */
async function bootGateway(overrides = {}) {
  const { dir, cleanup } = tempDir('lt-gw-');
  const httpsPort = await freePort();
  const httpPort = await freePort();
  const adminToken = 'test-admin-token-' + Math.random().toString(36).slice(2);

  const config = defaultConfig({
    gatewayId: 'gw_test',
    name: 'Test Gateway',
    publicIp: '127.0.0.1',
    httpsPort,
    httpPort,
    dataDir: dir,
    logFile: null,
    logLevel: 'error',
    adminTokenHash: createHash('sha256').update(adminToken).digest('hex'),
    tls: { mode: 'selfsigned', acmeDirectoryUrl: '', contactEmail: null, renewBeforeDays: 30 },
    firewall: { manage: false },
    ...overrides,
    /*
     * Every connection in this suite comes from 127.0.0.1, so the whole suite
     * shares one per-IP budget — including the harness's own polling, which
     * opens a fresh TLS connection per tick. On a loaded machine the
     * self-signed RSA keygen takes long enough that waiting for a certificate
     * alone can burn the production allowance, and the *next* test connection
     * is then dropped: an ECONNRESET with nothing to do with what was being
     * tested. The limiter has its own test in limits.test.js; here it is
     * raised out of the way so it cannot mask a real failure.
     *
     * A test that wants the real thing passes `limits` explicitly.
     */
    limits: { ...DEFAULT_LIMITS, connectionsPerIpPerMinute: 100_000, ...(overrides.limits ?? {}) },
  });

  const gateway = await startGateway(config);
  return {
    gateway,
    config,
    adminToken,
    httpsPort,
    httpPort,
    fingerprint: gateway.identityFingerprint,
    async stop() {
      await gateway.stop();
      cleanup();
    },
  };
}

/** Talk to the admin API over its own ALPN on the single public port. */
function adminRequest(ctx, method, path, body) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: ctx.httpsPort,
      ALPNProtocols: [ALPN.admin],
      rejectUnauthorized: false,
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = [
        `${method} ${path} HTTP/1.1`,
        'host: gateway',
        `authorization: Bearer ${ctx.adminToken}`,
        'connection: close',
      ];
      if (payload) {
        headers.push('content-type: application/json');
        headers.push(`content-length: ${Buffer.byteLength(payload)}`);
      }
      socket.write(headers.join('\r\n') + '\r\n\r\n' + (payload ?? ''));
    });

    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) return reject(new Error(`bad admin response: ${raw}`));
      const head = raw.slice(0, separator);
      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      const bodyText = raw.slice(separator + 4);
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        /* leave null */
      }
      resolve({ status, body: parsed, raw: bodyText });
    });
  });
}

/** A public HTTPS request through the gateway, exactly as a visitor would make it. */
function publicRequest(ctx, hostname, path = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: options.method ?? 'GET',
        path,
        headers: { host: hostname, ...(options.headers ?? {}) },
        createConnection: () =>
          tls.connect({
            host: '127.0.0.1',
            port: ctx.httpsPort,
            servername: hostname,
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: false,
          }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** A tiny local "website" standing in for whatever the user runs at home. */
async function startLocalSite(handler) {
  const port = await freePort();
  const server = http.createServer(
    handler ??
      ((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`hello from home: ${req.url}`);
      }),
  );
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, server, stop: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Poll until something becomes true.
 *
 * `intervalMs` is deliberately not tiny: several predicates here open a network
 * connection per tick, and polling far faster than the event can possibly occur
 * only adds load to the machine that is already the reason it is slow.
 */
function waitFor(predicate, { timeoutMs = 15000, intervalMs = 250, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      let result;
      try {
        result = await predicate();
      } catch {
        result = false;
      }
      if (result) return resolve(result);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}

module.exports = {
  tempDir,
  freePort,
  bootGateway,
  adminRequest,
  publicRequest,
  startLocalSite,
  waitFor,
};
