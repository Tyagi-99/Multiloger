/**
 * Token-bucket rate limiter (in-memory, per process).
 *
 * Two limiters are used by the server: a generous one keyed by
 * authenticated token id, and a strict one keyed by client IP for
 * anonymous traffic (including failed-auth attempts, which blunts
 * token brute-forcing).
 *
 * This is per-process state: in a multi-process deployment each process
 * enforces its own budget. The MVP runs a single API process, so this
 * is exact there; a shared limiter is a documented scale-out item.
 */

export interface RateLimitOptions {
  /** Burst capacity. */
  capacity: number;
  /** Sustained refill rate, tokens per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

const STALE_BUCKET_MS = 10 * 60 * 1000;

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  /** Consume one token. Returns true when the request may proceed. */
  take(key: string, nowMs: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.capacity, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsedSec * this.options.refillPerSecond);
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) {
      this.maybeSweep(nowMs);
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until one token is available (for the Retry-After header). */
  retryAfterSeconds(key: string, nowMs: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return 0;
    }
    const elapsedSec = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
    const available = Math.min(this.options.capacity, bucket.tokens + elapsedSec * this.options.refillPerSecond);
    if (available >= 1) {
      return 0;
    }
    return Math.ceil((1 - available) / this.options.refillPerSecond);
  }

  /** Number of tracked keys (exposed for tests/monitoring). */
  get size(): number {
    return this.buckets.size;
  }

  private maybeSweep(nowMs: number): void {
    // Sweep probabilistically to amortize cost; stale buckets are harmless.
    if (Math.random() > 0.01 || this.buckets.size < 1000) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAtMs > STALE_BUCKET_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
