/**
 * The update checker reads a public release document. That document is remote
 * input: a compromised account, a proxy, or simply a malformed tag can put
 * anything in it, and the result is compared, stored and shown to the user.
 */
const test = require('node:test');
const assert = require('node:assert');

const { isNewer, parseVersion, toPlainText, RELEASES_PAGE } = require('../dist/services/updates.js');

test('versions are parsed only when they really are versions', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion(' v10.0.4 '), [10, 0, 4]);
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);

  for (const bad of [
    '',
    'latest',
    '1.2',
    '1.2.3.4',
    'v1.2.3; rm -rf /',
    '<script>alert(1)</script>',
    '1.2.3\nSet-Cookie: x',
    '../../etc/passwd',
    '99999999.0.0',
    'javascript:alert(1)',
  ]) {
    assert.equal(parseVersion(bad), null, `"${bad}" must not parse as a version`);
  }
});

test('only a strictly higher version counts as an update', () => {
  assert.equal(isNewer('1.1.0', '1.0.0'), true);
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('2.0.0', '1.9.9'), true);

  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.9.0', '1.0.0'), false, 'a downgrade is not an update');
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  // Unparseable on either side means "no update", never "yes".
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', 'garbage'), false);
});

test('version comparison is numeric, not lexicographic', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
});

test('release notes are reduced to plain text', () => {
  assert.equal(toPlainText(''), null);
  assert.equal(toPlainText(null), null);
  assert.equal(toPlainText(123), null);
  assert.equal(toPlainText('  '), null);

  // Control characters that could rewrite a terminal or a log line are removed;
  // newlines and tabs, which are legitimate formatting, are kept.
  assert.equal(toPlainText(`a${String.fromCharCode(7)}b${String.fromCharCode(27)}c`), 'abc');
  assert.equal(toPlainText('line one\nline two'), 'line one\nline two');
  assert.equal(toPlainText('a\r\nb'), 'a\nb');
  assert.equal(toPlainText('col\tumn'), 'col\tumn');

  // Markup is preserved as text rather than stripped: it is rendered into a
  // text node, so it must read as what it is, not be silently rewritten.
  assert.equal(toPlainText('<b>hi</b>'), '<b>hi</b>');

  // Bounded, so the renderer cannot be handed a megabyte of "notes".
  assert.equal(toPlainText('x'.repeat(100_000)).length, 4000);
});

test('the release page is a constant, not taken from any response', () => {
  assert.equal(RELEASES_PAGE, 'https://github.com/arnavko11/LocalTunnel/releases');
  assert.ok(RELEASES_PAGE.startsWith('https://github.com/'));
});
