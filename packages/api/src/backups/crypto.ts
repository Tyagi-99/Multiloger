/**
 * Backup encryption: AES-256-GCM via the shared crypto core
 * (../crypto/aes-gcm.js). File layout: MAGIC(6) | IV(12) | TAG(16) |
 * CIPHERTEXT. GCM authentication means any tampering (or a wrong key)
 * fails loudly on decrypt — there is no separate checksum to get out of
 * sync.
 *
 * Key resolution order: explicit keyHex > MULTILOGER_BACKUP_KEY >
 * explicit keyFile > MULTILOGER_BACKUP_KEY_FILE. A key file must be
 * owner-only (no group/other permission bits); anything looser is refused
 * rather than warned about, because a world-readable key file silently
 * voids the encryption.
 */

import {
  CryptoCorruptError,
  CryptoKeyError,
  CryptoKeyMissingError,
  CryptoKeyPermissionsError,
  decryptAesGcm,
  encryptAesGcm,
  resolveKey,
  type KeySource,
} from '../crypto/aes-gcm.js';

export const BACKUP_MAGIC = 'MLBK01';
export const BACKUP_ENCRYPTION = 'aes-256-gcm';

export class BackupKeyMissingError extends CryptoKeyMissingError {
  constructor() {
    super('MULTILOGER_BACKUP_KEY', 'MULTILOGER_BACKUP_KEY_FILE');
    this.name = 'BackupKeyMissingError';
  }
}

export class BackupKeyError extends CryptoKeyError {
  constructor(message: string) {
    super(message.replace(/^Encryption key/, 'Backup key').replace(/^Key file/, 'Backup key file'));
    this.name = 'BackupKeyError';
  }
}

export class BackupKeyPermissionsError extends CryptoKeyPermissionsError {
  constructor(path: string, mode: number) {
    super(path, mode);
    this.name = 'BackupKeyPermissionsError';
  }
}

export class BackupCorruptError extends CryptoCorruptError {
  constructor(message: string) {
    super(
      message
        .replace(/^Encrypted file/, 'Backup file')
        .replace(/^Decryption failed/, 'Backup decryption failed'),
    );
    this.name = 'BackupCorruptError';
  }
}

export type { KeySource };

/** Resolve the 32-byte backup key. Throws BackupKeyMissingError when none is configured. */
export function resolveBackupKey(source: KeySource = {}): Buffer {
  try {
    return resolveKey(source, 'MULTILOGER_BACKUP_KEY', 'MULTILOGER_BACKUP_KEY_FILE');
  } catch (error) {
    if (error instanceof CryptoKeyMissingError) {
      throw new BackupKeyMissingError();
    }
    if (error instanceof CryptoKeyPermissionsError) {
      const match = /Key file (.+) has mode/.exec(error.message);
      throw new BackupKeyPermissionsError(match?.[1] ?? 'unknown', 0);
    }
    if (error instanceof CryptoKeyError) {
      throw new BackupKeyError(error.message);
    }
    throw error;
  }
}

export function encryptBackup(key: Buffer, plaintext: Buffer): Buffer {
  try {
    return encryptAesGcm(key, BACKUP_MAGIC, plaintext);
  } catch (error) {
    if (error instanceof CryptoKeyError) {
      throw new BackupKeyError(error.message);
    }
    throw error;
  }
}

export function decryptBackup(key: Buffer, blob: Buffer): Buffer {
  try {
    return decryptAesGcm(key, BACKUP_MAGIC, blob);
  } catch (error) {
    if (error instanceof CryptoCorruptError) {
      throw new BackupCorruptError(error.message);
    }
    throw error;
  }
}
