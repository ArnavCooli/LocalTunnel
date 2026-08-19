import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which SSH host keys LocalTunnel has seen before.
 *
 * The SSH session is the root of everything else: the gateway's admin token and
 * the certificate fingerprint that every later connection is pinned against are
 * both learned over it. Accepting whatever key answers, every time, means an
 * attacker on the path can hand the app its own gateway and the app will pin it —
 * so the key is recorded the first time and required to match after that.
 *
 * This is trust on first use, the same model `ssh` itself uses with
 * `StrictHostKeyChecking=accept-new`, and it is what the terminal client gets for
 * free by shelling out to `ssh`. The window is the first connection to a given
 * server; every one after that is protected.
 */

export interface HostKeyVerdict {
  /** Nothing was recorded for this server before — the key has now been pinned. */
  firstUse: boolean;
  /** Colon-separated SHA-256 fingerprint of the key that was presented. */
  fingerprint: string;
}

export class HostKeyChangedError extends Error {
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The SSH host key for ${host} has changed since LocalTunnel last connected to it. ` +
        'If you rebuilt or replaced this server, remove the gateway from LocalTunnel and add it ' +
        'again. If you did not, stop: something is answering in its place.',
    );
    this.name = 'HostKeyChangedError';
  }
}

/**
 * The fingerprint in the form OpenSSH prints it: `SHA256:` plus unpadded base64.
 *
 * Deliberately the same notation as `ssh-keyscan` and `ssh-keygen -lf`, so a
 * user who wants to check the key LocalTunnel pinned can compare the two
 * strings directly instead of converting between formats.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

interface KnownHostsFile {
  version: number;
  hosts: Record<string, { fingerprint: string; firstSeenAt: string }>;
}

const EMPTY: KnownHostsFile = { version: 1, hosts: {} };

export class KnownHosts {
  private readonly path: string;
  private file: KnownHostsFile;

  constructor(dir: string) {
    this.path = join(dir, 'known-hosts.json');
    mkdirSync(dirname(this.path), { recursive: true });
    this.file = this.read();
  }

  private read(): KnownHostsFile {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as KnownHostsFile;
      return { ...structuredClone(EMPTY), ...parsed, hosts: parsed.hosts ?? {} };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private static key(host: string, port: number): string {
    return `${host.toLowerCase()}:${port}`;
  }

  /**
   * Check a presented host key, recording it if this server is new.
   *
   * Throws `HostKeyChangedError` when a different key has been recorded before —
   * refusing to connect is the point, so this must never be softened into a
   * warning.
   */
  verify(host: string, port: number, key: Buffer): HostKeyVerdict {
    const fingerprint = hostKeyFingerprint(key);
    const id = KnownHosts.key(host, port);
    const known = this.file.hosts[id];

    if (!known) {
      this.file.hosts[id] = { fingerprint, firstSeenAt: new Date().toISOString() };
      this.write();
      return { firstUse: true, fingerprint };
    }
    if (known.fingerprint !== fingerprint) {
      throw new HostKeyChangedError(host, known.fingerprint, fingerprint);
    }
    return { firstUse: false, fingerprint };
  }

  /** Forget a server, so the next connection pins whatever answers. */
  forget(host: string, port: number): void {
    delete this.file.hosts[KnownHosts.key(host, port)];
    this.write();
  }

  fingerprintFor(host: string, port: number): string | null {
    return this.file.hosts[KnownHosts.key(host, port)]?.fingerprint ?? null;
  }
}
