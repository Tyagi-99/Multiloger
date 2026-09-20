/**
 * Password hashing for team members (Phase 3).
 *
 * Pure-JS KDF: scrypt from node:crypto (no native bcrypt — it cannot build
 * on this project's supported toolchains). Stored format:
 *
 *   scrypt$<N>$<r>$<p>$<saltHex>$<keyHex>
 *
 * The parameters are embedded so they can be raised later without breaking
 * old hashes. Verification is constant-time over the derived key.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './router.js';

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Interactive-login-grade scrypt cost: ~50ms per hash on this hardware. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

function scryptAsync(password: string, salt: Buffer, keylen: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N: n, r, p }, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

export function validatePasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at most ${String(MAX_PASSWORD_LENGTH)} characters`);
  }
}

/** Hash a password. Throws ValidationError when the policy is violated. */
export async function hashPassword(password: string): Promise<string> {
  validatePasswordPolicy(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt.toString('hex')}$${key.toString('hex')}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) {
    return null;
  }
  const salt = Buffer.from(parts[4] ?? '', 'hex');
  const key = Buffer.from(parts[5] ?? '', 'hex');
  if (salt.length === 0 || key.length === 0) {
    return null;
  }
  return { n, r, p, salt, key };
}

/** Constant-time password verification. False for malformed stored hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) {
    return false;
  }
  const key = await scryptAsync(password, parsed.salt, parsed.key.length, parsed.n, parsed.r, parsed.p);
  if (key.length !== parsed.key.length) {
    return false;
  }
  return timingSafeEqual(key, parsed.key);
}
