/**
 * API token cryptography.
 *
 * - Tokens look like `mlt_<32 base64url chars>` (24 bytes of entropy).
 * - Only a scrypt hash + per-token salt is stored; the plaintext is shown
 *   exactly once at creation and is never recoverable afterwards.
 * - Verification is constant-time over the derived key. A dummy scrypt run
 *   is performed when no candidate row exists so unknown prefixes don't
 *   fail observably faster (timing-based token existence probing).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, SCRYPT_OPTIONS, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

export const TOKEN_PREFIX = 'mlt_';
/** Characters of the token used as the DB lookup key ('mlt_' + 8 chars). */
export const TOKEN_LOOKUP_LENGTH = 12;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Interactive-login-grade scrypt cost: ~50ms per hash on this hardware. */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

export function generateTokenValue(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function tokenLookupPrefix(token: string): string {
  return token.slice(0, TOKEN_LOOKUP_LENGTH);
}

export function isTokenFormat(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) && token.length === TOKEN_PREFIX.length + 32;
}

export interface TokenHash {
  salt: string;
  hash: string;
}

export async function hashTokenSecret(plain: string): Promise<TokenHash> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES);
  return { salt: salt.toString('hex'), hash: key.toString('hex') };
}

export async function verifyTokenSecret(
  plain: string,
  saltHex: string,
  hashHex: string,
): Promise<boolean> {
  const key = await scryptAsync(plain, Buffer.from(saltHex, 'hex'), KEY_BYTES);
  const expected = Buffer.from(hashHex, 'hex');
  if (key.length !== expected.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(key, expected);
}

/** Dummy hash burned when no candidate row exists, to blunt timing probes. */
export async function burnDummyVerification(): Promise<void> {
  await hashTokenSecret(`dummy-${randomBytes(8).toString('hex')}`);
}

/** Extract a bearer token from an Authorization header. Never logs the value. */
export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9\-_]+)$/.exec(authorization.trim());
  return match?.[1] ?? null;
}
