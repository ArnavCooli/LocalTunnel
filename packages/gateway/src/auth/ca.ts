import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';

/**
 * The gateway's internal certificate authority.
 *
 * It exists so that every agent can be given a unique, revocable identity without
 * any shared secret ever being embedded in an agent build. It signs nothing that is
 * trusted by the public internet — public web certificates come from ACME.
 */

export interface CaMaterial {
  certPem: string;
  keyPem: string;
}

export interface IssuedCertificate {
  certPem: string;
  serial: string;
  expiresAt: string;
}

const CLIENT_CERT_DAYS = 730;
const CA_DAYS = 3650;
const IDENTITY_DAYS = 3650;

function serial(): string {
  /*
   * A certificate serial is a DER INTEGER, and OpenSSL enforces two rules on it:
   * it must not look negative, and it must be minimally encoded. node-forge
   * writes these bytes verbatim, so padding with a nibble ("0" + 32 hex digits)
   * produced a leading 0x00 byte — harmless in front of a high-bit byte, but an
   * illegal double-zero padding whenever the first random byte happened to be
   * 0x00. That is roughly one certificate in 256, and the certificate it made
   * could not be loaded at all: `createSecureContext` threw ERR_OSSL_ASN1_
   * ILLEGAL_PADDING and the hostname was left without TLS. Clearing the top bit
   * instead keeps the integer positive with no padding byte at all.
   */
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) || 0x01;
  return bytes.toString('hex');
}

function nameAttrs(commonName: string): forge.pki.CertificateField[] {
  return [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'LocalTunnel' },
  ];
}

export function ensureCa(dir: string): CaMaterial {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certPath = join(dir, 'ca.crt');
  const keyPath = join(dir, 'ca.key');

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 86400_000);
  const subject = nameAttrs('LocalTunnel Gateway CA');
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
    { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const material: CaMaterial = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  writeFileSync(certPath, material.certPem, { mode: 0o600 });
  writeFileSync(keyPath, material.keyPem, { mode: 0o600 });
  return material;
}

/**
 * Sign an agent's certificate signing request.
 *
 * The subject is replaced with the machine id the gateway allocated, so an agent
 * cannot choose its own identity by crafting a CSR.
 */
export function issueClientCertificate(
  ca: CaMaterial,
  csrPem: string,
  machineId: string,
): IssuedCertificate {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) {
    throw new Error('certificate signing request has an invalid self-signature');
  }
  if (!csr.publicKey) {
    throw new Error('certificate signing request contains no public key');
  }
  const publicKey = csr.publicKey as forge.pki.rsa.PublicKey;
  if (publicKey.n.bitLength() < 2048) {
    throw new Error('agent key must be at least 2048 bits');
  }

  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + CLIENT_CERT_DAYS * 86400_000);
  cert.setSubject(nameAttrs(machineId));
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    serial: cert.serialNumber,
    expiresAt: cert.validity.notAfter.toISOString(),
  };
}

/**
 * The certificate the gateway presents on the tunnel/enrol/admin ALPNs. Agents and
 * the desktop app pin its fingerprint (captured over SSH at install time) rather
 * than trusting a public CA, so this never needs a domain name.
 */
export function ensureIdentityCertificate(dir: string, ca: CaMaterial, publicIp: string): CaMaterial {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certPath = join(dir, 'identity.crt');
  const keyPath = join(dir, 'identity.key');

  if (existsSync(certPath) && existsSync(keyPath)) {
    const existing = {
      certPem: readFileSync(certPath, 'utf8'),
      keyPem: readFileSync(keyPath, 'utf8'),
    };
    // Reissue if the VPS's public IP changed, otherwise agents would fail SAN checks.
    if (certificateCoversIp(existing.certPem, publicIp)) return existing;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + IDENTITY_DAYS * 86400_000);
  cert.setSubject(nameAttrs('LocalTunnel Gateway'));
  cert.setIssuer(caCert.subject.attributes);

  // node-forge's altName shape: type 2 is a DNS name, type 7 an IP address.
  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (publicIp && publicIp !== '127.0.0.1') altNames.push({ type: 7, ip: publicIp });

  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const material: CaMaterial = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  writeFileSync(certPath, material.certPem, { mode: 0o600 });
  writeFileSync(keyPath, material.keyPem, { mode: 0o600 });
  return material;
}

function certificateCoversIp(certPem: string, ip: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const ext = cert.getExtension('subjectAltName') as { altNames?: { type: number; ip?: string }[] } | null;
    if (!ext?.altNames) return false;
    if (ip === '127.0.0.1') return true;
    return ext.altNames.some((alt) => alt.type === 7 && alt.ip === ip);
  } catch {
    return false;
  }
}

/**
 * A stand-in web certificate for `tls.mode: "selfsigned"` — used by the integration
 * tests and by gateways that do not have a domain pointed at them yet. Visitors will
 * see a browser warning; ACME mode is the real path.
 */
export function selfSignedWebCertificate(hostname: string): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 397 * 86400_000);
  const subject = nameAttrs(hostname);
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Colon-separated uppercase SHA-256 fingerprint, the form agents pin. */
export function certificateFingerprint(certPem: string): string {
  const der = forge.asn1
    .toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem)))
    .getBytes();
  const hash = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase();
  return hash.match(/.{2}/g)!.join(':');
}

export function certificateCommonName(certPem: string): string | null {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const field = cert.subject.getField('CN');
    return field ? String(field.value) : null;
  } catch {
    return null;
  }
}

export function certificateExpiry(certPem: string): Date | null {
  try {
    return forge.pki.certificateFromPem(certPem).validity.notAfter;
  } catch {
    return null;
  }
}
