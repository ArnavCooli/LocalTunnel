import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

/** Short, URL-safe, prefixed identifier: `svc_9f2c1a…`. */
export function newId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Exponential backoff with full jitter, as used by the agent's reconnect loop:
 * 1s, 2s, 4s, 8s, 16s, then capped at 30s.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 30_000,
  ) {}

  next(): number {
    const exponential = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    // Full jitter, but never below a quarter of the interval, so the UI countdown
    // stays honest rather than occasionally showing "retrying in 0s".
    const jittered = exponential * (0.25 + Math.random() * 0.75);
    return Math.round(jittered);
  }

  get attempts(): number {
    return this.attempt;
  }

  reset(): void {
    this.attempt = 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Hostnames we accept as public service hostnames. */
export function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(hostname.toLowerCase());
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/**
 * Tie two duplexes together for their whole lifetime without losing data.
 *
 * Both ends of a proxied connection are already piped to each other; this is
 * about how they *end*. A server that answers and immediately closes leaves the
 * tail of its response in the other side's buffer — possibly parked behind flow
 * control — so tearing that side down on 'close' silently truncates the
 * response. Each side is therefore ended, not destroyed, when its partner
 * finishes; only an error tears the pair down at once. `onClosed` runs exactly
 * once, when both sides are done, for accounting the caller has to do.
 */
export function linkDuplexPair(a: Duplex, b: Duplex, onClosed?: () => void): void {
  let done = false;
  const settle = (): void => {
    if (done) return;
    if (!a.destroyed || !b.destroyed) return;
    done = true;
    onClosed?.();
  };

  const hardClose = (): void => {
    if (!a.destroyed) a.destroy();
    if (!b.destroyed) b.destroy();
    settle();
  };

  const finish = (target: Duplex): void => {
    if (target.destroyed) return;
    if (target.writableEnded || !target.writable) {
      if (target.writableFinished) target.destroy();
      else target.once('finish', () => target.destroy());
      return;
    }
    target.end();
    target.once('finish', () => target.destroy());
  };

  a.on('error', hardClose);
  b.on('error', hardClose);
  a.on('close', () => {
    finish(b);
    settle();
  });
  b.on('close', () => {
    finish(a);
    settle();
  });
}
