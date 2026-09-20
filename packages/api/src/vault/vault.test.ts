/**
 * Vault tests (written first): encrypted per-profile secret store.
 * Covers round-trip, 0600 creation, loose-permission refusal, key handling,
 * tamper detection, backup-magic rejection, and name/value validation.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptAesGcm } from '../crypto/aes-gcm.js';
import {
  deleteSecret,
  getSecret,
  listSecretNames,
  resolveVaultPath,
  storeSecret,
  VAULT_MAGIC,
  VaultCorruptError,
  VaultError,
  VaultKeyError,
  VaultKeyMissingError,
  VaultPermissionsError,
} from './vault.js';

// ------------------------------------------------------------------ helpers

const KEY_HEX = randomBytes(32).toString('hex');
const OTHER_KEY_HEX = randomBytes(32).toString('hex');

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-vault-test-'));
  createdDirs.push(dir);
  return dir;
}

const createdDirs: string[] = [];

function vaultPathIn(dir: string): string {
  return join(dir, 'vault.mlvault');
}

const ENV_VARS = ['MULTILOGER_VAULT_KEY', 'MULTILOGER_VAULT_KEY_FILE', 'MULTILOGER_VAULT_PATH'];

function stashEnv(): Record<string, string | undefined> {
  const stash: Record<string, string | undefined> = {};
  for (const v of ENV_VARS) {
    stash[v] = process.env[v];
    Reflect.deleteProperty(process.env, v);
  }
  return stash;
}

function restoreEnv(stash: Record<string, string | undefined>): void {
  for (const v of ENV_VARS) {
    Reflect.deleteProperty(process.env, v);
    const value = stash[v];
    if (value !== undefined) {
      process.env[v] = value;
    }
  }
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = stashEnv();
  createdDirs.length = 0;
});

afterEach(() => {
  restoreEnv(savedEnv);
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdDirs.length = 0;
});

describe('vault round-trip', () => {
  it('stores, gets, lists, and deletes secrets', () => {
    const dir = freshDir();
    const path = vaultPathIn(dir);
    storeSecret(path, 'proxy-user', 'u$er:pass', { keyHex: KEY_HEX });
    storeSecret(path, 'proxy-token', 'tok-abc-123', { keyHex: KEY_HEX });

    expect(getSecret(path, 'proxy-user', { keyHex: KEY_HEX })).toBe('u$er:pass');
    expect(getSecret(path, 'proxy-token', { keyHex: KEY_HEX })).toBe('tok-abc-123');

    const names = listSecretNames(path, { keyHex: KEY_HEX });
    expect(names.sort()).toEqual(['proxy-token', 'proxy-user']);
    // names only — values must never leak through listing
    expect(JSON.stringify(names)).not.toContain('tok-abc-123');
    expect(JSON.stringify(names)).not.toContain('u$er:pass');

    expect(deleteSecret(path, 'proxy-user', { keyHex: KEY_HEX })).toBe(true);
    expect(getSecret(path, 'proxy-user', { keyHex: KEY_HEX })).toBeUndefined();
    expect(deleteSecret(path, 'proxy-user', { keyHex: KEY_HEX })).toBe(false);
    expect(listSecretNames(path, { keyHex: KEY_HEX })).toEqual(['proxy-token']);
  });

  it('creates the vault file with mode 0600', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('magic header is MLVLT01', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    expect(readFileSync(path).subarray(0, 6).toString('ascii')).toBe(VAULT_MAGIC);
    expect(VAULT_MAGIC).toBe('MLVLT1');
  });

  it('missing file on read is an empty vault, not an error', () => {
    const path = vaultPathIn(freshDir());
    expect(existsSync(path)).toBe(false);
    expect(getSecret(path, 'anything', { keyHex: KEY_HEX })).toBeUndefined();
    expect(listSecretNames(path, { keyHex: KEY_HEX })).toEqual([]);
    expect(deleteSecret(path, 'anything', { keyHex: KEY_HEX })).toBe(false);
  });

  it('round-trips unicode and long values', () => {
    const path = vaultPathIn(freshDir());
    const big = '🔑'.repeat(2000);
    storeSecret(path, 'long', big, { keyHex: KEY_HEX });
    expect(getSecret(path, 'long', { keyHex: KEY_HEX })).toBe(big);
  });

  it('never logs secret values when the vault errors', () => {
    const path = vaultPathIn(freshDir());
    const secret = 'super-secret-value-xyz-9';
    storeSecret(path, 'k', secret, { keyHex: KEY_HEX });
    try {
      getSecret(path, 'k', { keyHex: OTHER_KEY_HEX });
      expect.unreachable('wrong key must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VaultCorruptError);
      expect(String(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('vault permissions (fail closed)', () => {
  it('refuses to read a group/other-readable vault file', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    chmodSync(path, 0o644);
    expect(() => getSecret(path, 'k', { keyHex: KEY_HEX })).toThrow(VaultPermissionsError);
    expect(() => listSecretNames(path, { keyHex: KEY_HEX })).toThrow(VaultPermissionsError);
  });

  it('refuses to write over a loose existing vault file', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    chmodSync(path, 0o640);
    expect(() => { storeSecret(path, 'k2', 'v2', { keyHex: KEY_HEX }); }).toThrow(VaultPermissionsError);
    expect(() => deleteSecret(path, 'k', { keyHex: KEY_HEX })).toThrow(VaultPermissionsError);
  });

  it('writes over a tight existing file keep 0600 (chmod after write)', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    chmodSync(path, 0o600);
    storeSecret(path, 'k2', 'v2', { keyHex: KEY_HEX });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('vault corruption and magic', () => {
  it('wrong key throws VaultCorruptError', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    expect(() => getSecret(path, 'k', { keyHex: OTHER_KEY_HEX })).toThrow(VaultCorruptError);
  });

  it('tampered bytes throw VaultCorruptError', () => {
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    const blob = Buffer.from(readFileSync(path));
    const last = blob[blob.length - 1];
    if (last === undefined) throw new Error('unreachable: empty vault blob');
    blob[blob.length - 1] = last ^ 0xff;
    writeFileSync(path, blob, { mode: 0o600 });
    expect(() => getSecret(path, 'k', { keyHex: KEY_HEX })).toThrow(VaultCorruptError);
  });

  it('a backup file (MLBK01) opened as a vault throws VaultCorruptError', () => {
    const path = vaultPathIn(freshDir());
    const key = Buffer.from(KEY_HEX, 'hex');
    writeFileSync(path, encryptAesGcm(key, 'MLBK01', Buffer.from('{"k":"v"}')), { mode: 0o600 });
    expect(() => getSecret(path, 'k', { keyHex: KEY_HEX })).toThrow(VaultCorruptError);
  });

  it('non-JSON plaintext throws VaultCorruptError, not a SyntaxError', () => {
    const path = vaultPathIn(freshDir());
    const key = Buffer.from(KEY_HEX, 'hex');
    writeFileSync(path, encryptAesGcm(key, VAULT_MAGIC, Buffer.from('not json at all')), {
      mode: 0o600,
    });
    expect(() => getSecret(path, 'k', { keyHex: KEY_HEX })).toThrow(VaultCorruptError);
  });
});

describe('vault key resolution', () => {
  it('missing key throws VaultKeyMissingError', () => {
    const path = vaultPathIn(freshDir());
    // writes need a key even when creating a new vault
    expect(() => { storeSecret(path, 'k', 'v'); }).toThrow(VaultKeyMissingError);
    // reads of an existing vault need a key
    storeSecret(path, 'k', 'v', { keyHex: KEY_HEX });
    expect(() => getSecret(path, 'k')).toThrow(VaultKeyMissingError);
    expect(() => listSecretNames(path)).toThrow(VaultKeyMissingError);
    // but a missing file is an empty vault — no key needed, not an error
    const missing = vaultPathIn(freshDir());
    expect(getSecret(missing, 'k')).toBeUndefined();
  });

  it('malformed key throws VaultKeyError', () => {
    const path = vaultPathIn(freshDir());
    expect(() => { storeSecret(path, 'k', 'v', { keyHex: 'zz' }); }).toThrow(VaultKeyError);
  });

  it('reads the key from env vars', () => {
    process.env.MULTILOGER_VAULT_KEY = KEY_HEX;
    const path = vaultPathIn(freshDir());
    storeSecret(path, 'k', 'v');
    expect(getSecret(path, 'k')).toBe('v');
  });
});

describe('vault name and value validation', () => {
  const badNames = ['', 'has space', 'has/slash', 'has:colon', 'é', 'a'.repeat(101)];
  it.each(badNames)('rejects invalid name %j', (name) => {
    const path = vaultPathIn(freshDir());
    expect(() => { storeSecret(path, name, 'v', { keyHex: KEY_HEX }); }).toThrow(VaultError);
    expect(() => getSecret(path, name, { keyHex: KEY_HEX })).toThrow(VaultError);
    expect(() => deleteSecret(path, name, { keyHex: KEY_HEX })).toThrow(VaultError);
  });

  it('accepts letters, digits, _ . - up to 100 chars', () => {
    const path = vaultPathIn(freshDir());
    const name = 'aZ09_.-'.repeat(14); // 84 chars
    storeSecret(path, name, 'v', { keyHex: KEY_HEX });
    expect(getSecret(path, name, { keyHex: KEY_HEX })).toBe('v');
    const maxed = 'n'.repeat(100);
    storeSecret(path, maxed, 'v', { keyHex: KEY_HEX });
    expect(getSecret(path, maxed, { keyHex: KEY_HEX })).toBe('v');
  });

  it('rejects empty and overlong values', () => {
    const path = vaultPathIn(freshDir());
    expect(() => { storeSecret(path, 'k', '', { keyHex: KEY_HEX }); }).toThrow(VaultError);
    expect(() => { storeSecret(path, 'k', 'x'.repeat(8193), { keyHex: KEY_HEX }); }).toThrow(VaultError);
    // exactly 8192 is allowed
    storeSecret(path, 'k', 'x'.repeat(8192), { keyHex: KEY_HEX });
    expect(getSecret(path, 'k', { keyHex: KEY_HEX })).toHaveLength(8192);
  });
});

describe('resolveVaultPath', () => {
  it('defaults to dataDir/vault.mlvault', () => {
    expect(resolveVaultPath('/data/profiles/abc')).toBe(join('/data/profiles/abc', 'vault.mlvault'));
  });

  it('honors MULTILOGER_VAULT_PATH', () => {
    process.env.MULTILOGER_VAULT_PATH = '/tmp/custom.vault';
    expect(resolveVaultPath('/data/profiles/abc')).toBe('/tmp/custom.vault');
  });
});
