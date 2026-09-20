import { describe, expect, it } from 'vitest';
import {
  generateTokenValue,
  hashTokenSecret,
  isTokenFormat,
  parseBearerToken,
  tokenLookupPrefix,
  verifyTokenSecret,
} from './auth.js';

describe('token cryptography', () => {
  it('generates mlt_-prefixed tokens with 24 bytes of entropy', () => {
    const a = generateTokenValue();
    const b = generateTokenValue();
    expect(a).toMatch(/^mlt_[A-Za-z0-9\-_]{32}$/);
    expect(a).not.toBe(b);
    expect(isTokenFormat(a)).toBe(true);
    expect(isTokenFormat('Bearer mlt_x')).toBe(false);
    expect(isTokenFormat('mlt_short')).toBe(false);
  });

  it('hashes and verifies secrets', async () => {
    const secret = generateTokenValue();
    const { salt, hash } = await hashTokenSecret(secret);
    expect(salt).not.toBe(secret);
    expect(hash).not.toContain(secret.slice(4, 12));
    expect(await verifyTokenSecret(secret, salt, hash)).toBe(true);
    expect(await verifyTokenSecret(`${secret}x`, salt, hash)).toBe(false);
  });

  it('derives a 12-char lookup prefix', () => {
    expect(tokenLookupPrefix('mlt_abcdefghijklmnop')).toBe('mlt_abcdefgh');
    expect(tokenLookupPrefix('mlt_abcdefgh').length).toBe(12);
  });

  it('parses bearer headers strictly', () => {
    expect(parseBearerToken('Bearer mlt_abc123')).toBe('mlt_abc123');
    expect(parseBearerToken(undefined)).toBe(null);
    expect(parseBearerToken('Basic dXNlcjpwYXNz')).toBe(null);
    expect(parseBearerToken('Bearer')).toBe(null);
    // Spaces would break the token; reject rather than trim into validity.
    expect(parseBearerToken('Bearer  mlt_abc')).toBe(null);
  });
});
