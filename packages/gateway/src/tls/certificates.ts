import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import acme from 'acme-client';
import type { GatewayConfig } from '../main/config.js';
import type { Logger } from '../main/log.js';
import { certificateExpiry, selfSignedWebCertificate } from '../auth/ca.js';

export type CertificateState = 'none' | 'pending' | 'valid' | 'error';

export interface CertificateStatus {
  hostname: string;
  state: CertificateState;
  expiresAt: string | null;
  autoRenew: boolean;
  error: string | null;
  issuer: string;
}

interface Entry {
  hostname: string;
  certPem: string;
  keyPem: string;
  context: SecureContext;
  expiresAt: Date | null;
}

const RENEW_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Issues and renews the public web certificates.
 *
 * Certificates come from a standard ACME certificate authority (Let's Encrypt by
 * default). TLS is terminated here on the user's own VPS — never at a third-party
 * proxy.
 */
export class CertificateManager {
  private entries = new Map<string, Entry>();
  private states = new Map<string, { state: CertificateState; error: string | null }>();
  private challenges = new Map<string, string>();
  private inFlight = new Map<string, Promise<void>>();
  private client: acme.Client | null = null;
  private dir: string;

  constructor(
    private readonly config: GatewayConfig,
    private readonly log: Logger,
  ) {
    this.dir = join(config.dataDir, 'acme');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  async init(hostnames: string[]): Promise<void> {
    for (const hostname of hostnames) this.loadFromDisk(hostname);
    setInterval(() => void this.renewExpiring(), RENEW_CHECK_INTERVAL_MS).unref();
    // Anything not already on disk gets requested in the background; the gateway
    // must come up and start serving even if the CA is unreachable right now.
    for (const hostname of hostnames) {
      if (!this.entries.has(hostname)) void this.ensure(hostname);
    }
  }

  /** SNI hook for the public TLS listener. */
  contextFor(servername: string): SecureContext | null {
    const entry = this.entries.get(servername.toLowerCase());
    return entry ? entry.context : null;
  }

  has(hostname: string): boolean {
    return this.entries.has(hostname.toLowerCase());
  }

  status(hostname: string): CertificateStatus {
    const key = hostname.toLowerCase();
    const entry = this.entries.get(key);
    const state = this.states.get(key);
    return {
      hostname: key,
      state: entry ? 'valid' : (state?.state ?? 'none'),
      expiresAt: entry?.expiresAt ? entry.expiresAt.toISOString() : null,
      autoRenew: this.config.tls.mode === 'acme',
      error: state?.error ?? null,
      issuer: this.config.tls.mode === 'acme' ? "Let's Encrypt" : 'LocalTunnel (self-signed)',
    };
  }

  allStatuses(): CertificateStatus[] {
    const names = new Set([...this.entries.keys(), ...this.states.keys()]);
    return [...names].map((name) => this.status(name));
  }

  /** Serve an http-01 challenge response, or null when the path is not a challenge. */
  challengeResponse(path: string): string | null {
    const prefix = '/.well-known/acme-challenge/';
    if (!path.startsWith(prefix)) return null;
    return this.challenges.get(path.slice(prefix.length)) ?? null;
  }

  /** Make sure a certificate exists for a hostname, issuing one if necessary. */
  async ensure(hostname: string): Promise<void> {
    const key = hostname.toLowerCase();
    if (this.entries.has(key)) return;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = this.issue(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  forget(hostname: string): void {
    const key = hostname.toLowerCase();
    this.entries.delete(key);
    this.states.delete(key);
  }

  private paths(hostname: string): { cert: string; key: string } {
    const safe = hostname.replace(/[^a-z0-9.-]/gi, '_');
    return { cert: join(this.dir, `${safe}.crt`), key: join(this.dir, `${safe}.key`) };
  }

  private loadFromDisk(hostname: string): boolean {
    const key = hostname.toLowerCase();
    const { cert, key: keyPath } = this.paths(key);
    if (!existsSync(cert) || !existsSync(keyPath)) return false;
    try {
      const certPem = readFileSync(cert, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      this.install(key, certPem, keyPem);
      return true;
    } catch (err) {
      this.log.warn('could not load cached certificate', { hostname: key, error: String(err) });
      return false;
    }
  }

  private install(hostname: string, certPem: string, keyPem: string): void {
    const entry: Entry = {
      hostname,
      certPem,
      keyPem,
      context: createSecureContext({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' }),
      expiresAt: certificateExpiry(certPem),
    };
    this.entries.set(hostname, entry);
    this.states.set(hostname, { state: 'valid', error: null });
    const { cert, key } = this.paths(hostname);
    try {
      writeFileSync(cert, certPem, { mode: 0o600 });
      writeFileSync(key, keyPem, { mode: 0o600 });
    } catch (err) {
      this.log.warn('could not cache certificate', { hostname, error: String(err) });
    }
  }

  private async issue(hostname: string): Promise<void> {
    this.states.set(hostname, { state: 'pending', error: null });

    if (this.config.tls.mode === 'selfsigned') {
      const material = selfSignedWebCertificate(hostname);
      this.install(hostname, material.certPem, material.keyPem);
      this.log.info('issued self-signed certificate', { hostname });
      return;
    }

    try {
      const client = await this.acmeClient();
      const [key, csr] = await acme.crypto.createCsr({ commonName: hostname });
      const certPem = await client.auto({
        csr,
        email: this.config.tls.contactEmail ?? undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type === 'http-01') this.challenges.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
          this.challenges.delete(challenge.token);
        },
      });
      this.install(hostname, certPem.toString(), key.toString());
      this.log.info('issued certificate', { hostname, issuer: "Let's Encrypt" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.states.set(hostname, { state: 'error', error: humanizeAcmeError(message) });
      this.log.error('certificate issuance failed', { hostname, error: message });
    }
  }

  private async acmeClient(): Promise<acme.Client> {
    if (this.client) return this.client;
    const accountKeyPath = join(this.dir, 'account.key');
    let accountKey: Buffer;
    if (existsSync(accountKeyPath)) {
      accountKey = readFileSync(accountKeyPath);
    } else {
      accountKey = await acme.crypto.createPrivateKey();
      writeFileSync(accountKeyPath, accountKey, { mode: 0o600 });
    }
    this.client = new acme.Client({
      directoryUrl: this.config.tls.acmeDirectoryUrl,
      accountKey,
    });
    return this.client;
  }

  private async renewExpiring(): Promise<void> {
    const threshold = Date.now() + this.config.tls.renewBeforeDays * 86400_000;
    for (const entry of [...this.entries.values()]) {
      if (!entry.expiresAt || entry.expiresAt.getTime() > threshold) continue;
      this.log.info('renewing certificate', {
        hostname: entry.hostname,
        expiresAt: entry.expiresAt.toISOString(),
      });
      this.entries.delete(entry.hostname);
      await this.ensure(entry.hostname);
      // If renewal failed, keep serving the old certificate rather than nothing.
      if (!this.entries.has(entry.hostname)) {
        this.entries.set(entry.hostname, entry);
      }
    }
  }
}

/** Turn the CA's wording into something a non-expert can act on. */
function humanizeAcmeError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('dns') || lower.includes('nxdomain')) {
    return 'The domain does not resolve yet. Check that its A record points at this gateway, then retry.';
  }
  if (lower.includes('connection') || lower.includes('timeout') || lower.includes('unauthorized')) {
    return "Let's Encrypt could not reach this gateway on port 80. Check that TCP 80 is open in your provider's firewall.";
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return "Let's Encrypt rate limit reached for this domain. Try again in an hour.";
  }
  return message;
}
