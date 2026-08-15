/**
 * Certificate issuance must survive DNS not being ready yet.
 *
 * Publishing before the DNS record propagates is the natural thing to do — the app
 * shows you the record only after you publish. Previously that attempt failed once
 * and stayed failed until the user found the Reissue button.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { CertificateManager } = require('../dist/tls/certificates.js');
const { defaultConfig } = require('../dist/main/config.js');
const { Logger } = require('../dist/main/log.js');

function manager(publicIp) {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cert-'));
  const config = defaultConfig({
    dataDir: dir,
    publicIp,
    logFile: null,
    tls: { mode: 'acme', acmeDirectoryUrl: 'https://127.0.0.1:1/nonexistent', contactEmail: null, renewBeforeDays: 30 },
  });
  const log = new Logger('test', { file: null, level: 'error' });
  return { cm: new CertificateManager(config, log), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a hostname that does not point at the gateway waits instead of failing', async (t) => {
  const { cm, cleanup } = manager('203.0.113.77');
  t.after(cleanup);

  // Nothing resolves to 203.0.113.77, so DNS can never match.
  await cm.ensure('definitely-not-pointing-here.example.com');
  const status = cm.status('definitely-not-pointing-here.example.com');

  assert.equal(status.state, 'pending', 'it should wait, not error');
  assert.match(status.detail, /waiting for/i);
  assert.match(status.detail, /203\.0\.113\.77/, 'it names the address the record must point at');
  assert.match(status.detail, /few minutes/i, 'it says a fresh DNS record takes time');
  assert.ok(status.nextAttemptAt, 'another attempt is scheduled');
  assert.ok(
    new Date(status.nextAttemptAt).getTime() > Date.now(),
    'the next attempt is in the future',
  );
});

test('it never asks the CA before DNS resolves', async (t) => {
  // The ACME directory URL above is unreachable; reaching it would throw and land
  // in 'error'. Staying 'pending' proves the DNS check short-circuits first, which
  // is what keeps the account off Let's Encrypt's failed-validation limit.
  const { cm, cleanup } = manager('203.0.113.77');
  t.after(cleanup);
  await cm.ensure('another-unpointed-name.example.com');
  assert.equal(cm.status('another-unpointed-name.example.com').state, 'pending');
});

test('the wait backs off instead of hammering DNS', async (t) => {
  const { cm, cleanup } = manager('203.0.113.77');
  t.after(cleanup);

  await cm.ensure('backoff-check.example.com');
  const first = new Date(cm.status('backoff-check.example.com').nextAttemptAt).getTime() - Date.now();

  // Force the scheduled attempt to run again by re-entering issuance.
  await cm.ensure('backoff-check.example.com');
  const second = new Date(cm.status('backoff-check.example.com').nextAttemptAt).getTime() - Date.now();

  assert.ok(first > 0 && second > 0, 'both attempts are scheduled ahead');
  assert.ok(second >= first, `the delay should not shrink: ${first}ms then ${second}ms`);
  assert.ok(second <= 10 * 60 * 1000 + 1000, 'and it is capped at ten minutes');
});

test('forgetting a hostname cancels its pending retries', async (t) => {
  const { cm, cleanup } = manager('203.0.113.77');
  t.after(cleanup);
  await cm.ensure('going-away.example.com');
  assert.ok(cm.status('going-away.example.com').nextAttemptAt);
  cm.forget('going-away.example.com');
  assert.equal(cm.status('going-away.example.com').nextAttemptAt, null);
  assert.equal(cm.status('going-away.example.com').state, 'none');
});
