import { randomBytes } from 'node:crypto';

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
