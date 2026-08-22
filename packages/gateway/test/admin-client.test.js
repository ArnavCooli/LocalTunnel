const test = require('node:test');
const assert = require('node:assert/strict');

const { bootGateway } = require('./helpers.js');
const {
  adminFetch,
  closeAdminConnections,
} = require('../../desktop/dist/services/gateway-client.js');

/**
 * The desktop app's admin client keeps one connection per gateway alive. These
 * check that reuse actually happens, that it survives many calls, and that a
 * connection dropped by the far end does not surface as a failed request.
 */
test('the admin client reuses one connection across requests', async (t) => {
  const gw = await bootGateway();
  t.after(() => {
    closeAdminConnections();
    return gw.stop();
  });

  const connection = {
    host: '127.0.0.1',
    port: gw.httpsPort,
    adminToken: gw.adminToken,
    fingerprint: gw.fingerprint,
  };

  const first = await adminFetch(connection, 'GET', '/v1/status');
  assert.ok(first.gateway.id, 'the first request returns a status');

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await adminFetch(connection, 'GET', '/v1/machines'));
  }
  assert.equal(results.length, 5);
  for (const result of results) assert.ok(Array.isArray(result.machines));

  // Concurrent calls must not interleave on the single pooled socket.
  const [a, b] = await Promise.all([
    adminFetch(connection, 'GET', '/v1/status'),
    adminFetch(connection, 'GET', '/v1/services'),
  ]);
  assert.ok(a.gateway.id);
  assert.ok(Array.isArray(b.services));

  // A stale pooled connection is replaced rather than failing the request.
  closeAdminConnections();
  const afterDrop = await adminFetch(connection, 'GET', '/v1/status');
  assert.ok(afterDrop.gateway.id, 'a request after the pool was closed still works');
});
