/**
 * Task 9 tests (written first): backup crypto, tar exclusions, and the
 * BackupService — create/verify/restore/delete, retention, key handling.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import {
  BackupCorruptError,
  BackupKeyMissingError,
  BackupKeyPermissionsError,
  decryptBackup,
  encryptBackup,
  resolveBackupKey,
} from './crypto.js';
import { createTar, extractTar, listTar, TAR_EXCLUDES } from './tar.js';
import { BackupNotFoundError, BackupService } from './service.js';

// ---------------------------------------------------------------- crypto

const TEST_KEY_HEX = randomBytes(32).toString('hex');

describe('backup crypto', () => {
  it('round-trips through AES-256-GCM', () => {
    const key = resolveBackupKey({ keyHex: TEST_KEY_HEX });
    expect(key).toHaveLength(32);
    const plaintext = Buffer.from('profile-bytes-'.repeat(1000));
    const blob = encryptBackup(key, plaintext);
    expect(blob.subarray(0, 6).toString('ascii')).toBe('MLBK01');
    expect(decryptBackup(key, blob)).toEqual(plaintext);
  });

  it('rejects tampered ciphertext, wrong key, and bad magic', () => {
    const key = resolveBackupKey({ keyHex: TEST_KEY_HEX });
    const blob = encryptBackup(key, Buffer.from('hello'));
    const tampered = Buffer.from(blob);
    const lastByte = tampered[tampered.length - 1];
    if (lastByte === undefined) throw new Error('unreachable: empty backup blob');
    tampered[tampered.length - 1] = lastByte ^ 0xff;
    expect(() => decryptBackup(key, tampered)).toThrow(BackupCorruptError);
    expect(() => decryptBackup(randomBytes(32), blob)).toThrow(BackupCorruptError);
    const badMagic = Buffer.from(blob);
    badMagic.write('XXXXXX', 0);
    expect(() => decryptBackup(key, badMagic)).toThrow(BackupCorruptError);
    expect(() => decryptBackup(key, Buffer.from('short'))).toThrow(BackupCorruptError);
  });

  it('rejects malformed key material', () => {
    expect(() => resolveBackupKey({ keyHex: 'zz' })).toThrow();
    expect(() => resolveBackupKey({ keyHex: 'abcd' })).toThrow();
    expect(() =>
      resolveBackupKey({ keyHex: TEST_KEY_HEX, keyFile: '/nonexistent' }),
    ).not.toThrow(); // explicit hex wins over the file
  });

  it('loads a key file only when it is owner-only (0600/0400)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-key-'));
    try {
      const good = join(dir, 'good.key');
      writeFileSync(good, `${TEST_KEY_HEX}\n`, { mode: 0o600 });
      expect(resolveBackupKey({ keyFile: good }).toString('hex')).toBe(TEST_KEY_HEX);

      const loose = join(dir, 'loose.key');
      writeFileSync(loose, TEST_KEY_HEX, { mode: 0o644 });
      expect(() => resolveBackupKey({ keyFile: loose })).toThrow(BackupKeyPermissionsError);

      expect(() => resolveBackupKey({ keyFile: join(dir, 'missing.key') })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws BackupKeyMissingError when no key is configured', () => {
    const savedKey = process.env.MULTILOGER_BACKUP_KEY;
    const savedFile = process.env.MULTILOGER_BACKUP_KEY_FILE;
    delete process.env.MULTILOGER_BACKUP_KEY;
    delete process.env.MULTILOGER_BACKUP_KEY_FILE;
    try {
      expect(() => resolveBackupKey()).toThrow(BackupKeyMissingError);
    } finally {
      if (savedKey !== undefined) process.env.MULTILOGER_BACKUP_KEY = savedKey;
      if (savedFile !== undefined) process.env.MULTILOGER_BACKUP_KEY_FILE = savedFile;
    }
  });

  it('prefers the environment variable over nothing and the file over env absence', () => {
    const savedKey = process.env.MULTILOGER_BACKUP_KEY;
    const savedFile = process.env.MULTILOGER_BACKUP_KEY_FILE;
    delete process.env.MULTILOGER_BACKUP_KEY_FILE;
    process.env.MULTILOGER_BACKUP_KEY = TEST_KEY_HEX;
    try {
      expect(resolveBackupKey().toString('hex')).toBe(TEST_KEY_HEX);
    } finally {
      if (savedKey !== undefined) {
        process.env.MULTILOGER_BACKUP_KEY = savedKey;
      } else {
        delete process.env.MULTILOGER_BACKUP_KEY;
      }
      if (savedFile !== undefined) process.env.MULTILOGER_BACKUP_KEY_FILE = savedFile;
    }
  });
});

// ---------------------------------------------------------------- tar

function makeProfileDir(base: string): string {
  const root = join(base, 'profile');
  mkdirSync(join(root, 'Default', 'Cache'), { recursive: true });
  mkdirSync(join(root, 'Default', 'Code Cache'), { recursive: true });
  writeFileSync(join(root, 'Default', 'Preferences'), '{"hello":"world"}');
  writeFileSync(join(root, 'Default', 'Cache', 'data_0'), 'junk'.repeat(1000));
  writeFileSync(join(root, 'Default', 'Code Cache', 'js', ), 'junk');
  writeFileSync(join(root, 'LOCK'), 'lock');
  writeFileSync(join(root, 'app.log'), 'logs');
  return root;
}

describe('tar with cache exclusions', () => {
  it('excludes caches/locks/logs but keeps real profile data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-tar-'));
    try {
      const profileDir = makeProfileDir(dir);
      const archive = join(dir, 'out.tar.gz');
      await createTar(profileDir, archive);
      const entries = await listTar(archive);
      const names = entries.join('\n');
      expect(names).toContain('Preferences');
      expect(names).not.toContain('Cache');
      expect(names).not.toContain('LOCK');
      expect(names).not.toContain('app.log');
      expect(TAR_EXCLUDES.length).toBeGreaterThan(0);

      const dest = join(dir, 'restored');
      await extractTar(archive, dest);
      expect(readFileSync(join(dest, 'Default', 'Preferences'), 'utf8')).toContain('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when the source dir is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-tar-'));
    try {
      await expect(createTar(join(dir, 'nope'), join(dir, 'o.tar.gz'))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- service

interface ServiceFixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  service: BackupService;
  profileId: string;
  clientId: string;
  stopped: string[];
}

async function setupService(options?: { retention?: number }): Promise<ServiceFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-bak-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const client = await createClient(db, { name: 'Acme' });
  const profileDir = makeProfileDir(dir);
  const profile = await createProfile(db, {
    clientId: client.id,
    name: 'p1',
    userDataDir: profileDir,
  });
  const stopped: string[] = [];
  const service = new BackupService({
    db,
    dataDir: dir,
    keyHex: TEST_KEY_HEX,
    ...(options?.retention !== undefined ? { retention: options.retention } : {}),
    profiles: {
      stopProfile: async (id: string) => {
        stopped.push(id);
        await db.updateTable('profiles').set({ state: 'stopped' }).where('id', '=', id).execute();
      },
    },
  });
  return { dir, db, service, profileId: profile.id, clientId: client.id, stopped };
}

describe('BackupService', () => {
  let fixture: ServiceFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await closeDatabase(fixture.db);
      rmSync(fixture.dir, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  it('creates an encrypted backup with a DB record', async () => {
    fixture = await setupService();
    const { service, profileId, dir } = fixture;
    const backup = await service.createBackup(profileId);
    expect(backup.profileId).toBe(profileId);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(backup.encryption).toBe('aes-256-gcm');
    expect(backup.stoppedForBackup).toBe(false);

    // The file on disk is opaque: magic + GCM, no plaintext tar markers.
    const raw = readFileSync(join(dir, 'backups', `${backup.id}.mlbackup`));
    expect(raw.subarray(0, 6).toString('ascii')).toBe('MLBK01');
    expect(raw.includes('hello')).toBe(false);

    const listed = await service.listBackups(profileId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(backup.id);
  });

  it('stops a running profile before backing up (quiesce)', async () => {
    fixture = await setupService();
    const { db, service, profileId, stopped } = fixture;
    await db.updateTable('profiles').set({ state: 'running' }).where('id', '=', profileId).execute();
    const backup = await service.createBackup(profileId);
    expect(backup.stoppedForBackup).toBe(true);
    expect(stopped).toEqual([profileId]);
  });

  it('refuses to back up a profile that is launching', async () => {
    fixture = await setupService();
    const { db, service, profileId } = fixture;
    await db.updateTable('profiles').set({ state: 'launching' }).where('id', '=', profileId).execute();
    await expect(service.createBackup(profileId)).rejects.toThrow(/launching|busy/i);
    expect(await service.listBackups(profileId)).toHaveLength(0);
  });

  it('fails closed when no key is configured, leaving no partial state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-bak-'));
    const db = openDatabase({ path: join(dir, 'test.db') });
    await migrateToLatest(db);
    const savedKey = process.env.MULTILOGER_BACKUP_KEY;
    const savedFile = process.env.MULTILOGER_BACKUP_KEY_FILE;
    delete process.env.MULTILOGER_BACKUP_KEY;
    delete process.env.MULTILOGER_BACKUP_KEY_FILE;
    try {
      const client = await createClient(db, { name: 'Acme' });
      const profileDir = makeProfileDir(dir);
      const profile = await createProfile(db, { clientId: client.id, name: 'p', userDataDir: profileDir });
      const service = new BackupService({
        db,
        dataDir: dir,
        profiles: { stopProfile: () => Promise.resolve() },
      });
      await expect(service.createBackup(profile.id)).rejects.toThrow(BackupKeyMissingError);
      expect(await service.listBackups(profile.id)).toHaveLength(0);
    } finally {
      if (savedKey !== undefined) process.env.MULTILOGER_BACKUP_KEY = savedKey;
      if (savedFile !== undefined) process.env.MULTILOGER_BACKUP_KEY_FILE = savedFile;
      await closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a backup by decrypting and listing its contents', async () => {
    fixture = await setupService();
    const { service, profileId } = fixture;
    const backup = await service.createBackup(profileId);
    const result = await service.verifyBackup(backup.id);
    expect(result.ok).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.sha256Match).toBe(true);
  });

  it('detects a tampered backup file on verify', async () => {
    fixture = await setupService();
    const { service, profileId, dir } = fixture;
    const backup = await service.createBackup(profileId);
    const path = join(dir, 'backups', `${backup.id}.mlbackup`);
    const raw = readFileSync(path);
    const lastByte = raw[raw.length - 1];
    if (lastByte === undefined) throw new Error('unreachable: empty backup file');
    raw[raw.length - 1] = lastByte ^ 0xff;
    writeFileSync(path, raw);
    await expect(service.verifyBackup(backup.id)).rejects.toThrow(BackupCorruptError);
  });

  it('restores into a brand-new profile without touching the source', async () => {
    fixture = await setupService();
    const { db, service, profileId, clientId } = fixture;
    const backup = await service.createBackup(profileId);
    const restored = await service.restoreBackup(backup.id, { name: 'restored-1' });
    expect(restored.id).not.toBe(profileId);
    expect(restored.clientId).toBe(clientId);
    expect(restored.name).toBe('restored-1');
    expect(restored.state).toBe('created');

    const prefs = readFileSync(join(restored.userDataDir, 'Default', 'Preferences'), 'utf8');
    expect(prefs).toContain('hello');
    // Cache junk did not come back.
    expect(() => statSync(join(restored.userDataDir, 'Default', 'Cache'))).toThrow();

    // Source profile row is untouched.
    const source = await db.selectFrom('profiles').selectAll().where('id', '=', profileId).executeTakeFirstOrThrow();
    expect(source.state).toBe('created');
  });

  it('restore rejects unknown backups and unknown clients', async () => {
    fixture = await setupService();
    const { service } = fixture;
    await expect(service.restoreBackup('nope', { name: 'x' })).rejects.toThrow(BackupNotFoundError);
    const backup = await service.createBackup(fixture.profileId);
    await expect(service.restoreBackup(backup.id, { name: 'x', clientId: 'nope' })).rejects.toThrow();
  });

  it('enforces per-profile retention, deleting oldest first', async () => {
    fixture = await setupService({ retention: 2 });
    const { db, service, profileId, dir } = fixture;
    const first = await service.createBackup(profileId);
    const second = await service.createBackup(profileId);
    const third = await service.createBackup(profileId);
    const listed = await service.listBackups(profileId);
    expect(listed.map((b) => b.id).sort()).toEqual([second.id, third.id].sort());
    expect(() => statSync(join(dir, 'backups', `${first.id}.mlbackup`))).toThrow();
    // The DB row is gone too.
    const rows = await db.selectFrom('backups').select('id').where('profile_id', '=', profileId).execute();
    expect(rows).toHaveLength(2);
  });

  it('deletes a backup file and its row', async () => {
    fixture = await setupService();
    const { service, profileId, dir } = fixture;
    const backup = await service.createBackup(profileId);
    await service.deleteBackup(backup.id);
    expect(await service.listBackups(profileId)).toHaveLength(0);
    expect(() => statSync(join(dir, 'backups', `${backup.id}.mlbackup`))).toThrow();
    await expect(service.verifyBackup(backup.id)).rejects.toThrow(BackupNotFoundError);
  });

  it('getBackup throws BackupNotFoundError for unknown ids', async () => {
    fixture = await setupService();
    await expect(fixture.service.getBackup('nope')).rejects.toThrow(BackupNotFoundError);
  });
});
