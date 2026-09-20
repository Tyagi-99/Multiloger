import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from './rateLimit.js';

describe('TokenBucketLimiter', () => {
  it('allows capacity requests, then denies until refill', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1 });
    const now = 1_000_000;
    expect(limiter.take('k', now)).toBe(true);
    expect(limiter.take('k', now)).toBe(true);
    expect(limiter.take('k', now)).toBe(true);
    expect(limiter.take('k', now)).toBe(false);
    // One second later one token refilled.
    expect(limiter.take('k', now + 1000)).toBe(true);
    expect(limiter.take('k', now + 1000)).toBe(false);
    // Full refill after a long idle.
    expect(limiter.take('k', now + 60_000)).toBe(true);
    expect(limiter.take('k', now + 60_000)).toBe(true);
  });

  it('reports retry-after honestly', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.5 });
    const now = 2_000_000;
    expect(limiter.take('k', now)).toBe(true);
    expect(limiter.take('k', now)).toBe(false);
    expect(limiter.retryAfterSeconds('k', now)).toBe(2);
    expect(limiter.retryAfterSeconds('fresh', now)).toBe(0);
  });

  it('isolates buckets per key', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.size).toBe(2);
  });
});
