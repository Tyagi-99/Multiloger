/**
 * Backup encryption: AES-256-GCM via node:crypto.
 *
 * File layout: MAGIC(6) | IV(12) | TAG(16) | CIPHERTEXT. GCM authentication
 * means any tampering (or a wrong key) fails loudly on decrypt — there is
 * no separate checksum to get out of sync.
 *
 * Key resolution order: explicit keyHex > MULTILOGER_BACKUP_KEY >
 * explicit keyFile > MULTILOGER_BACKUP_KEY_FILE. A key file must be
 * owner-only (no group/other permission bits); anything looser is refused
 * rather than warned about, because a world-readable key file silently
 * voids the encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const BACKUP_MAGIC = 'MLBK01';
export const BACKUP_ENCRYPTION = 'aes-256-gcm';

const MAGIC_LEN = 6;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_BYTES = 32;
const HEADER_LEN = MAGIC_LEN + IV_LEN + TAG_LEN;

export class BackupKeyMissingError extends Error {
  constructor() {
    super(
      'No backup key configured. Set MULTILOGER_BACKUP_KEY (64 hex chars) or ' +
        'MULTILOGER_BACKUP_KEY_FILE (path to a 0600 file holding 64 hex chars).',
    );
    this.name = 'BackupKeyMissingError';
  }
}

export class BackupKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupKeyError';
  }
}

export class BackupKeyPermissionsError extends Error {
  constructor(path: string, mode: number) {
    super(
      `Backup key file ${path} has mode ${mode.toString(8)}: group/other ` +
        'permission bits must be clear (chmod 600). Refusing to use a widely ' +
        'readable key.',
    );
    this.name = 'BackupKeyPermissionsError';
  }
}

export class BackupCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCorruptError';
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
    throw new BackupKeyError(`${what} must be exactly 64 hex characters (32 bytes)`);
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
    throw new BackupKeyError(`Backup key file is not readable: ${path}`);
  }
  if (!isFile) {
    throw new BackupKeyError(`Backup key file is not a regular file: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new BackupKeyPermissionsError(path, mode);
  }
  return parseKeyHex(readFileSync(path, 'utf8'), `Backup key file ${path}`);
}

/** Resolve the 32-byte backup key. Throws BackupKeyMissingError when none is configured. */
export function resolveBackupKey(source: KeySource = {}): Buffer {
  const hex = source.keyHex ?? process.env.MULTILOGER_BACKUP_KEY;
  if (hex !== undefined) {
    return parseKeyHex(hex, 'Backup key');
  }
  const file = source.keyFile ?? process.env.MULTILOGER_BACKUP_KEY_FILE;
  if (file !== undefined) {
    return readKeyFile(file);
  }
  throw new BackupKeyMissingError();
}

export function encryptBackup(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new BackupKeyError(`Backup key must be ${String(KEY_BYTES)} bytes`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'ascii'), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackup(key: Buffer, blob: Buffer): Buffer {
  if (blob.length <= HEADER_LEN) {
    throw new BackupCorruptError('Backup file is too short to be a valid backup');
  }
  if (blob.subarray(0, MAGIC_LEN).toString('ascii') !== BACKUP_MAGIC) {
    throw new BackupCorruptError('Backup file has an unrecognized magic header');
  }
  const iv = blob.subarray(MAGIC_LEN, MAGIC_LEN + IV_LEN);
  const tag = blob.subarray(MAGIC_LEN + IV_LEN, HEADER_LEN);
  const ciphertext = blob.subarray(HEADER_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupCorruptError('Backup decryption failed: wrong key or tampered data');
  }
}
