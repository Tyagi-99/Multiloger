/**
 * Shared AES-256-GCM envelope used by the backup module and the secret
 * vault. One layout for every encrypted file:
 *
 *   MAGIC(6) | IV(12) | TAG(16) | CIPHERTEXT
 *
 * GCM authentication means any tampering (or a wrong key) fails loudly on
 * decrypt — there is no separate checksum to get out of sync. Each consumer
 * picks its own 6-char ASCII magic so a backup can never be mistaken for a
 * vault file and vice versa.
 *
 * Key resolution order: explicit keyHex > <KEY_VAR> env > explicit keyFile >
 * <KEY_FILE_VAR> env. A key file must be owner-only (no group/other
 * permission bits); anything looser is refused rather than warned about,
 * because a world-readable key file silently voids the encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const MAGIC_LEN = 6;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_BYTES = 32;
const HEADER_LEN = MAGIC_LEN + IV_LEN + TAG_LEN;

export class CryptoKeyMissingError extends Error {
  constructor(
    readonly keyVar: string,
    readonly keyFileVar: string,
  ) {
    super(
      `No encryption key configured. Set ${keyVar} (64 hex chars) or ` +
        `${keyFileVar} (path to a 0600 file holding 64 hex chars).`,
    );
    this.name = 'CryptoKeyMissingError';
  }
}

export class CryptoKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoKeyError';
  }
}

export class CryptoKeyPermissionsError extends Error {
  constructor(path: string, mode: number) {
    super(
      `Key file ${path} has mode ${mode.toString(8)}: group/other permission ` +
        'bits must be clear (chmod 600). Refusing to use a widely readable key.',
    );
    this.name = 'CryptoKeyPermissionsError';
  }
}

export class CryptoCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoCorruptError';
  }
}

export interface KeySource {
  /** 64 hex chars (32 bytes). Highest precedence. */
  keyHex?: string;
  /** Path to a file holding 64 hex chars; must be owner-only. */
  keyFile?: string;
}

function parseKeyHex(hex: string, what: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new CryptoKeyError(`${what} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(clean, 'hex');
}

function readKeyFile(path: string): Buffer {
  let isFile = false;
  let mode = 0;
  try {
    const stats = statSync(path);
    isFile = stats.isFile();
    mode = stats.mode & 0o777;
  } catch {
    throw new CryptoKeyError(`Key file is not readable: ${path}`);
  }
  if (!isFile) {
    throw new CryptoKeyError(`Key file is not a regular file: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new CryptoKeyPermissionsError(path, mode);
  }
  return parseKeyHex(readFileSync(path, 'utf8'), `Key file ${path}`);
}

function checkMagic(magic: string, what: string): void {
  if (!/^[\x20-\x7e]{6}$/.test(magic)) {
    throw new CryptoKeyError(`${what} magic must be exactly 6 printable ASCII characters`);
  }
}

/** Resolve the 32-byte key. Throws CryptoKeyMissingError when none is configured. */
export function resolveKey(
  source: KeySource = {},
  keyVar: string,
  keyFileVar: string,
): Buffer {
  const hex = source.keyHex ?? process.env[keyVar];
  if (hex !== undefined) {
    return parseKeyHex(hex, 'Encryption key');
  }
  const file = source.keyFile ?? process.env[keyFileVar];
  if (file !== undefined) {
    return readKeyFile(file);
  }
  throw new CryptoKeyMissingError(keyVar, keyFileVar);
}

export function encryptAesGcm(key: Buffer, magic: string, plaintext: Buffer): Buffer {
  checkMagic(magic, 'Encrypt');
  if (key.length !== KEY_BYTES) {
    throw new CryptoKeyError(`Encryption key must be ${String(KEY_BYTES)} bytes`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from(magic, 'ascii'), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptAesGcm(key: Buffer, magic: string, blob: Buffer): Buffer {
  checkMagic(magic, 'Decrypt');
  if (blob.length <= HEADER_LEN) {
    throw new CryptoCorruptError('Encrypted file is too short to be valid');
  }
  if (blob.subarray(0, MAGIC_LEN).toString('ascii') !== magic) {
    throw new CryptoCorruptError('Encrypted file has an unrecognized magic header');
  }
  const iv = blob.subarray(MAGIC_LEN, MAGIC_LEN + IV_LEN);
  const tag = blob.subarray(MAGIC_LEN + IV_LEN, HEADER_LEN);
  const ciphertext = blob.subarray(HEADER_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CryptoCorruptError('Decryption failed: wrong key or tampered data');
  }
}
