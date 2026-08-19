import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, arch } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

/**
 * The agent's identity: an RSA keypair generated on this machine, whose private key
 * never leaves it, plus the certificate the gateway issued during enrolment.
 *
 * There is no shared secret and no password anywhere in this file.
 */

export interface Credentials {
  gatewayId: string;
  gatewayHost: string;
  gatewayPort: number;
  /** SHA-256 fingerprint of the gateway's identity certificate, captured at install. */
  gatewayFingerprint: string;
  machineId: string;
  certPem: string;
  caPem: string;
  expiresAt: string;
}

export function agentDataDir(): string {
  const override = process.env.LOCALTUNNEL_AGENT_DIR;
  if (override) return override;
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'LocalTunnel');
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'LocalTunnel');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'localtunnel');
  }
}

export class Identity {
  private readonly dir: string;
  private readonly keyPath: string;
  private readonly credentialsPath: string;
  private readonly controlKeyPath: string;

  constructor(dir = agentDataDir()) {
    this.dir = dir;
    this.keyPath = join(dir, 'agent.key');
    this.credentialsPath = join(dir, 'credentials.json');
    this.controlKeyPath = join(dir, 'control.key');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * The secret that authorises a local client to drive this agent.
   *
   * Talking to the agent means being able to enrol this computer with a gateway,
   * start and stop tunnels, and wipe its identity — so the IPC socket needs an
   * answer to "which local process is this?", not just "is it local?". The secret
   * lives beside the private key in a 0700 directory, so reading it already means
   * having the user's own file access. Generated on first use and reused after.
   */
  controlSecret(): string {
    try {
      const existing = readFileSync(this.controlKeyPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {
      /* not created yet */
    }
    const secret = randomBytes(32).toString('base64url');
    writeFileSync(this.controlKeyPath, `${secret}\n`, { mode: 0o600 });
    return secret;
  }

  get dataDir(): string {
    return this.dir;
  }

  hasKey(): boolean {
    return existsSync(this.keyPath);
  }

  /** Generate the keypair once; reuse it across re-enrolments. */
  privateKeyPem(): string {
    if (existsSync(this.keyPath)) return readFileSync(this.keyPath, 'utf8');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const pem = forge.pki.privateKeyToPem(keys.privateKey);
    writeFileSync(this.keyPath, pem, { mode: 0o600 });
    return pem;
  }

  /** A CSR for this machine. The gateway overrides the subject with a machine id. */
  createCsr(): string {
    const privateKey = forge.pki.privateKeyFromPem(this.privateKeyPem());
    const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = publicKey;
    csr.setSubject([{ name: 'commonName', value: hostname() }]);
    csr.sign(privateKey, forge.md.sha256.create());
    return forge.pki.certificationRequestToPem(csr);
  }

  credentials(): Credentials | null {
    try {
      return JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as Credentials;
    } catch {
      return null;
    }
  }

  saveCredentials(credentials: Credentials): void {
    writeFileSync(this.credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }

  /** Called when a machine is revoked: the credential is useless, so remove it. */
  clearCredentials(): void {
    try {
      unlinkSync(this.credentialsPath);
    } catch {
      /* already gone */
    }
  }

  /**
   * Forget this machine entirely, private key included. After this the computer has
   * no identity at all and enrolling again produces a brand-new machine.
   */
  reset(): void {
    this.clearCredentials();
    for (const path of [this.keyPath, this.controlKeyPath]) {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
  }

  describe(): { hostname: string; os: string; arch: string } {
    return { hostname: hostname(), os: platform(), arch: arch() };
  }
}

/** Constant-time comparison for the agent's local control secret. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read (creating if necessary) the local control secret for an agent directory.
 *
 * The desktop app and the terminal client both need it to talk to the agent, and
 * both already run as the user who owns that directory — which is exactly the
 * property the secret is standing in for.
 */
export function controlSecret(dir = agentDataDir()): string {
  return new Identity(dir).controlSecret();
}
