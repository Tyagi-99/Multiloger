/**
 * Encrypted proxy-credential vault: per-profile secrets (proxy usernames,
 * passwords, tokens) stored in a single AES-256-GCM file. File layout
 * (shared with backups): MAGIC(6) | IV(12) | TAG(16) | CIPHERTEXT, where
 * the ciphertext is a JSON object `{ [name]: value }` and the magic is
 * 'MLVLT1' — so a backup file (MLBK01) can never be mistaken for a vault.
 *
 * Synchronous on purpose: vault I/O is infrequent (profile launch/stop),
 * matching the backup crypto style.
 *
 * Key resolution order: explicit keyHex > MULTILOGER_VAULT_KEY >
 * explicit keyFile > MULTILOGER_VAULT_KEY_FILE.
 *
 * Fail-closed permissions: the vault file must be owner-only (no
 * group/other permission bits) at all times. A loose existing file is
 * refused on read AND write; new files are created 0600 (chmod after
 * write as well, since writeFileSync's mode only applies on creation).
 *
 * Secret values are NEVER logged by this module.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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

export const VAULT_MAGIC = 'MLVLT1';
export const VAULT_FILE_MODE = 0o600;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_SECRET_VALUE_LENGTH = 8192;

export class VaultKeyMissingError extends CryptoKeyMissingError {
  constructor() {
    super('MULTILOGER_VAULT_KEY', 'MULTILOGER_VAULT_KEY_FILE');
    this.name = 'VaultKeyMissingError';
  }
}

export class VaultKeyError extends CryptoKeyError {
  constructor(message: string) {
    super(
      message
        .replace(/^Encryption key/, 'Vault key')
        .replace(/^Key file/, 'Vault key file'),
    );
    this.name = 'VaultKeyError';
  }
}

export class VaultKeyPermissionsError extends CryptoKeyPermissionsError {
  constructor(path: string, mode: number) {
    super(path, mode);
    this.name = 'VaultKeyPermissionsError';
  }
}

export class VaultPermissionsError extends Error {
  constructor(path: string, mode: number) {
    super(
      `Vault file ${path} has mode ${mode.toString(8)}: group/other ` +
        'permission bits must be clear (chmod 600). Refusing to read or ' +
        'write a widely readable vault.',
    );
    this.name = 'VaultPermissionsError';
  }
}

export class VaultCorruptError extends CryptoCorruptError {
  constructor(message: string) {
    super(
      message
        .replace(/^Encrypted file/, 'Vault file')
        .replace(/^Decryption failed/, 'Vault decryption failed'),
    );
    this.name = 'VaultCorruptError';
  }
}

/** Thrown for invalid secret names/values (never carries the value itself). */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export type { KeySource };

/** Resolve the 32-byte vault key. Throws VaultKeyMissingError when none is configured. */
export function resolveVaultKey(source: KeySource = {}): Buffer {
  try {
    return resolveKey(source, 'MULTILOGER_VAULT_KEY', 'MULTILOGER_VAULT_KEY_FILE');
  } catch (error) {
    if (error instanceof CryptoKeyMissingError) {
      throw new VaultKeyMissingError();
    }
    if (error instanceof CryptoKeyPermissionsError) {
      const match = /Key file (.+) has mode/.exec(error.message);
      throw new VaultKeyPermissionsError(match?.[1] ?? 'unknown', 0);
    }
    if (error instanceof CryptoKeyError) {
      throw new VaultKeyError(error.message);
    }
    throw error;
  }
}

/** Where the vault file lives for a data dir; overridable via MULTILOGER_VAULT_PATH. */
export function resolveVaultPath(dataDir: string): string {
  return process.env.MULTILOGER_VAULT_PATH ?? join(dataDir, 'vault.mlvault');
}

function assertTightPermissions(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new VaultPermissionsError(path, 0);
  }
  if ((mode & 0o077) !== 0) {
    throw new VaultPermissionsError(path, mode);
  }
}

function validateName(name: string): void {
  if (typeof name !== 'string' || !SECRET_NAME_PATTERN.test(name)) {
    throw new VaultError(
      'Invalid secret name: must be 1-100 chars of A-Z, a-z, 0-9, underscore, dot, or hyphen',
    );
  }
}

function validateValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultError('Invalid secret value: must be a non-empty string');
  }
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    throw new VaultError(
      `Invalid secret value: must be at most ${String(MAX_SECRET_VALUE_LENGTH)} characters`,
    );
  }
}

type VaultMap = Record<string, string>;

function isVaultMap(value: unknown): value is VaultMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === 'string');
}

/** Read and decrypt the vault. Missing file = empty vault. */
function readVault(vaultPath: string, source: KeySource): VaultMap {
  if (!existsSync(vaultPath)) {
    return {};
  }
  assertTightPermissions(vaultPath);
  const blob = readFileSync(vaultPath);
  const key = resolveVaultKey(source);
  let plaintext: Buffer;
  try {
    plaintext = decryptAesGcm(key, VAULT_MAGIC, blob);
  } catch (error) {
    if (error instanceof CryptoCorruptError) {
      throw new VaultCorruptError(error.message);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new VaultCorruptError('Vault file payload is not valid JSON');
  }
  if (!isVaultMap(parsed)) {
    throw new VaultCorruptError('Vault file payload is not a name->value object');
  }
  return parsed;
}

/** Encrypt and write the vault. Refuses to write over a loose existing file. */
function writeVault(vaultPath: string, source: KeySource, map: VaultMap): void {
  if (existsSync(vaultPath)) {
    assertTightPermissions(vaultPath);
  }
  const key = resolveVaultKey(source);
  let blob: Buffer;
  try {
    blob = encryptAesGcm(key, VAULT_MAGIC, Buffer.from(JSON.stringify(map), 'utf8'));
  } catch (error) {
    if (error instanceof CryptoKeyError) {
      throw new VaultKeyError(error.message);
    }
    throw error;
  }
  writeFileSync(vaultPath, blob, { mode: VAULT_FILE_MODE });
  // mode above only applies on file creation; enforce regardless.
  chmodSync(vaultPath, VAULT_FILE_MODE);
}

/** Store (or overwrite) a secret in the vault. */
export function storeSecret(
  vaultPath: string,
  name: string,
  value: string,
  source: KeySource = {},
): void {
  validateName(name);
  validateValue(value);
  const map = readVault(vaultPath, source);
  map[name] = value;
  writeVault(vaultPath, source, map);
}

/** Read a secret; undefined when the vault or the name does not exist. */
export function getSecret(
  vaultPath: string,
  name: string,
  source: KeySource = {},
): string | undefined {
  validateName(name);
  const map = readVault(vaultPath, source);
  return map[name];
}

/** Delete a secret; true when it existed. */
export function deleteSecret(
  vaultPath: string,
  name: string,
  source: KeySource = {},
): boolean {
  validateName(name);
  const map = readVault(vaultPath, source);
  if (!(name in map)) {
    return false;
  }
  const rest: VaultMap = Object.fromEntries(
    Object.entries(map).filter(([key]) => key !== name),
  );
  writeVault(vaultPath, source, rest);
  return true;
}

/** Names of stored secrets. Never returns values. */
export function listSecretNames(vaultPath: string, source: KeySource = {}): string[] {
  return Object.keys(readVault(vaultPath, source));
}
