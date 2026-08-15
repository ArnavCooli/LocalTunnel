/**
 * Abuse controls for a public-facing service. Everything here is in-memory and
 * per-process: the gateway is a single process, and a limiter that needs a database
 * is a limiter that fails open when the database is down.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    // Keep the map from growing without bound on a busy or attacked gateway.
    setInterval(() => this.sweep(), Math.max(windowMs, 60_000)).unref();
  }

  /** Returns true when the caller is within its allowance. */
  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  /** Record a failure and report whether the key is now locked out. */
  fail(key: string, now = Date.now()): boolean {
    this.allow(key, now);
    return !this.remaining(key, now);
  }

  remaining(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return true;
    return bucket.count <= this.limit;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/** Concurrent-connection accounting, globally and per source IP. */
export class ConnectionCounter {
  private perIp = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerIp: number,
    private readonly maxTotal: number,
  ) {}

  tryAcquire(ip: string): { ok: true } | { ok: false; reason: 'per_ip' | 'total' } {
    if (this.total >= this.maxTotal) return { ok: false, reason: 'total' };
    const current = this.perIp.get(ip) ?? 0;
    if (current >= this.maxPerIp) return { ok: false, reason: 'per_ip' };
    this.perIp.set(ip, current + 1);
    this.total += 1;
    return { ok: true };
  }

  release(ip: string): void {
    const current = this.perIp.get(ip) ?? 0;
    if (current <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, current - 1);
    if (this.total > 0) this.total -= 1;
  }

  get active(): number {
    return this.total;
  }
}
