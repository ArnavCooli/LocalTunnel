const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecureContext } = require('node:tls');
const forge = require('node-forge');

const { selfSignedWebCertificate, certificateFingerprint } = require('../dist/auth/ca.js');

/**
 * A certificate serial is a DER INTEGER: it must not look negative, and it must
 * carry no redundant leading zero byte. Padding it with a nibble used to produce
 * exactly that whenever the first random byte came out 0x00 — roughly one
 * certificate in 256, and that certificate could not be loaded at all
 * (ERR_OSSL_ASN1_ILLEGAL_PADDING), leaving the hostname without TLS.
 */
test('generated certificate serials are valid, minimally encoded DER integers', () => {
  for (let i = 0; i < 25; i++) {
    const material = selfSignedWebCertificate('serial.example');
    const serial = forge.pki.certificateFromPem(material.certPem).serialNumber;

    assert.match(serial, /^[0-9a-f]+$/, 'serial is hex');
    assert.equal(serial.length % 2, 0, `serial is a whole number of bytes: ${serial}`);
    assert.ok(!serial.startsWith('00'), `serial has no padding byte: ${serial}`);
    assert.ok(parseInt(serial.slice(0, 2), 16) < 0x80, `serial is positive: ${serial}`);

    // The encoding rules exist because OpenSSL enforces them.
    createSecureContext({ cert: material.certPem, key: material.keyPem, minVersion: 'TLSv1.2' });
    assert.match(certificateFingerprint(material.certPem), /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  }
});
