/**
 * BackupService: encrypted, quiesced backups of Chromium profile dirs.
 *
 * Lifecycle:
 * - create: stop the profile if running (a live profile dir cannot be
 *   copied safely) → tar+gzip with cache exclusions → AES-256-GCM →
 *   `<backupsDir>/<uuid>.mlbackup` (+ DB row) → per-profile retention.
 * - verify: decrypt, check the GCM tag, compare SHA-256, list members.
 * - restore: decrypt into a temp dir, then create a brand-new profile row
 *   and extract there. The source profile is never modified.
 * - delete: remove file + row.
 *
 * The key is resolved (and validated) before any work begins, so a missing
 * key fails closed with no partial state.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely, Selectable } from 'kysely';
import type { BackupsTable, DatabaseSchema } from '../db/schema.js';
import { createProfileIn, getClient, getProfile } from '../profiles/repository.js';
import { getState } from '../profiles/stateMachine.js';
import {
  BACKUP_ENCRYPTION,
  BackupCorruptError,
  decryptBackup,
  encryptBackup,
  resolveBackupKey,
  type KeySource,
} from './crypto.js';
import { createTar, extractTar, listTar, assertSafeArchiveMembers } from './tar.js';

export { BackupCorruptError } from './crypto.js';

export class BackupNotFoundError extends Error {
  constructor(backupId: string) {
    super(`Backup not found: ${backupId}`);
    this.name = 'BackupNotFoundError';
  }
}

export class BackupBusyError extends Error {
  constructor(profileId: string, state: string) {
    super(`Cannot back up profile ${profileId} while it is ${state}`);
    this.name = 'BackupBusyError';
  }
}

export interface PublicBackup {
  id: string;
  profileId: string;
  sizeBytes: number;
  sha256: string;
  encryption: string;
  createdAt: string;
}

export interface CreatedBackup extends PublicBackup {
  /** True when the service stopped a running profile to quiesce it. */
  stoppedForBackup: boolean;
}

export interface VerifyResult {
  ok: true;
  /** Number of tar members (without extracting). */
  entries: number;
  /** Whether the decrypted tarball's SHA-256 matches the DB record. */
  sha256Match: boolean;
}

/** Minimal profile control the backup service needs (the real ProfileManager in prod). */
export interface ProfilesHandle {
  stopProfile(profileId: string): Promise<void>;
}

export interface BackupServiceOptions extends KeySource {
  db: Kysely<DatabaseSchema>;
  /** Root dir for profile data; restore targets are created beneath it. */
  dataDir: string;
  /** Where .mlbackup files live. Defaults to `<dataDir>/backups`. */
  backupsDir?: string;
  /**
   * Backups kept per profile; older ones are deleted (file + row) on
   * create. Default 10. 0 = unlimited.
   */
  retention?: number;
  profiles: ProfilesHandle;
}

export const DEFAULT_BACKUP_RETENTION = 10;

function toPublic(row: Selectable<BackupsTable>): PublicBackup {
  return {
    id: row.id,
    profileId: row.profile_id,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    encryption: row.encryption,
    createdAt: row.created_at,
  };
}

export class BackupService {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly dataDir: string;
  private readonly backupsDir: string;
  private readonly keySource: KeySource;
  private readonly retention: number;
  private readonly profiles: ProfilesHandle;

  constructor(options: BackupServiceOptions) {
    const retention = options.retention ?? DEFAULT_BACKUP_RETENTION;
    if (!Number.isInteger(retention) || retention < 0) {
      throw new Error('backup retention must be a non-negative integer');
    }
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.backupsDir = options.backupsDir ?? join(options.dataDir, 'backups');
    this.keySource = {
      ...(options.keyHex !== undefined ? { keyHex: options.keyHex } : {}),
      ...(options.keyFile !== undefined ? { keyFile: options.keyFile } : {}),
    };
    this.retention = retention;
    this.profiles = options.profiles;
  }

  private ensureBackupsDir(): string {
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    return this.backupsDir;
  }

  private filePath(backupId: string): string {
    return join(this.ensureBackupsDir(), `${backupId}.mlbackup`);
  }

  private async backupRow(backupId: string): Promise<Selectable<BackupsTable>> {
    const row = await this.db
      .selectFrom('backups')
      .selectAll()
      .where('id', '=', backupId)
      .executeTakeFirst();
    if (!row) {
      throw new BackupNotFoundError(backupId);
    }
    return row;
  }

  /**
   * Back up a profile. Stops it first when running (quiesce); refuses when
   * it is mid-transition (launching/stopping). Returns whether a stop was
   * performed so callers can report it honestly.
   */
  async createBackup(profileId: string): Promise<CreatedBackup> {
    const profile = await getProfile(this.db, profileId);
    // Fail closed on key problems before touching the profile or disk.
    const key = resolveBackupKey(this.keySource);

    const state = await getState(this.db, profileId);
    let stoppedForBackup = false;
    if (state === 'running') {
      await this.profiles.stopProfile(profileId);
      stoppedForBackup = true;
    } else if (state === 'launching' || state === 'stopping') {
      throw new BackupBusyError(profileId, state);
    }

    const id = randomUUID();
    const dir = this.ensureBackupsDir();
    const tarTmp = join(dir, `.tmp-${id}.tar.gz`);
    try {
      await createTar(profile.user_data_dir, tarTmp);
      const tarBytes = readFileSync(tarTmp);
      const sha256 = createHash('sha256').update(tarBytes).digest('hex');
      const blob = encryptBackup(key, tarBytes);
      const outTmp = join(dir, `.tmp-${id}.mlbackup`);
      writeFileSync(outTmp, blob, { mode: 0o600 });
      renameSync(outTmp, this.filePath(id));

      const createdAt = new Date().toISOString();
      try {
        await this.db
          .insertInto('backups')
          .values({
            id,
            profile_id: profileId,
            file_name: `${id}.mlbackup`,
            size_bytes: blob.length,
            sha256,
            encryption: BACKUP_ENCRYPTION,
            created_at: createdAt,
          })
          .execute();
        await this.enforceRetention(profileId);
      } catch (error) {
        // The encrypted blob is already at its final path: remove it so a
        // failed insert never leaves an unreferenced file behind.
        rmSync(this.filePath(id), { force: true });
        throw error;
      }
      return {
        id,
        profileId,
        sizeBytes: blob.length,
        sha256,
        encryption: BACKUP_ENCRYPTION,
        createdAt,
        stoppedForBackup,
      };
    } finally {
      rmSync(tarTmp, { force: true });
    }
  }

  async listBackups(profileId: string): Promise<PublicBackup[]> {
    await getProfile(this.db, profileId);
    const rows = await this.db
      .selectFrom('backups')
      .selectAll()
      .where('profile_id', '=', profileId)
      .orderBy('seq', 'desc')
      .execute();
    return rows.map(toPublic);
  }

  async getBackup(backupId: string): Promise<PublicBackup> {
    return toPublic(await this.backupRow(backupId));
  }

  /**
   * Verify without restoring: decrypt (GCM tag check), compare SHA-256
   * against the DB record, and list tar members. Throws BackupCorruptError
   * when the file is missing, undecryptable, or tampered.
   */
  async verifyBackup(backupId: string): Promise<VerifyResult> {
    const row = await this.backupRow(backupId);
    const key = resolveBackupKey(this.keySource);
    const path = this.filePath(backupId);
    if (!existsSync(path)) {
      throw new BackupCorruptError(`Backup file is missing: ${path}`);
    }
    const tarBytes = decryptBackup(key, readFileSync(path));
    const sha256Match = createHash('sha256').update(tarBytes).digest('hex') === row.sha256;

    const tmpDir = mkdtempSync(join(tmpdir(), 'multiloger-verify-'));
    try {
      const tmpTar = join(tmpDir, 'backup.tar.gz');
      writeFileSync(tmpTar, tarBytes);
      const entries = await listTar(tmpTar);
      return { ok: true, entries: entries.length, sha256Match };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Restore a backup into a brand-new profile (new id, fresh lock state,
   * no proxy assignment carried over). The source profile is untouched — and
   * it does not even need to exist: backup rows intentionally carry no
   * foreign key to profiles, so backups survive profile deletion. In that
   * case an explicit clientId is required.
   */
  async restoreBackup(
    backupId: string,
    input: { name: string; clientId?: string },
  ): Promise<{ id: string; clientId: string; name: string; state: string; userDataDir: string }> {
    const row = await this.backupRow(backupId);
    const name = input.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new Error('Profile name must be 1-200 characters');
    }
    const source = await getProfile(this.db, row.profile_id).catch(() => null);
    const clientId = input.clientId ?? source?.client_id ?? null;
    if (clientId === null) {
      throw new Error('clientId is required: the source profile no longer exists');
    }
    await getClient(this.db, clientId);
    const key = resolveBackupKey(this.keySource);

    const path = this.filePath(backupId);
    if (!existsSync(path)) {
      throw new BackupCorruptError(`Backup file is missing: ${path}`);
    }
    const tarBytes = decryptBackup(key, readFileSync(path));

    const profile = await createProfileIn(this.db, this.dataDir, { clientId, name });
    const tmpDir = mkdtempSync(join(tmpdir(), 'multiloger-restore-'));
    try {
      const tmpTar = join(tmpDir, 'backup.tar.gz');
      writeFileSync(tmpTar, tarBytes);
      // Defense in depth: a planted/corrupt archive must never write outside
      // the new profile's directory.
      assertSafeArchiveMembers(await listTar(tmpTar));
      await extractTar(tmpTar, profile.user_data_dir);
    } catch (error) {
      // Best-effort rollback: don't leave a half-restored profile behind.
      await this.db
        .deleteFrom('profiles')
        .where('id', '=', profile.id)
        .execute()
        .catch(() => undefined);
      rmSync(profile.user_data_dir, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    return {
      id: profile.id,
      clientId: profile.client_id,
      name: profile.name,
      state: profile.state,
      userDataDir: profile.user_data_dir,
    };
  }

  async deleteBackup(backupId: string): Promise<void> {
    await this.backupRow(backupId);
    // DB row first: a crash between the two leaves at worst an unreferenced
    // file (invisible, harmless), never a row pointing at a missing file.
    await this.db.deleteFrom('backups').where('id', '=', backupId).execute();
    rmSync(this.filePath(backupId), { force: true });
  }

  /** Keep the newest `retention` backups per profile; delete the rest. */
  private async enforceRetention(profileId: string): Promise<void> {
    if (this.retention === 0) {
      return;
    }
    const rows = await this.db
      .selectFrom('backups')
      .select('id')
      .where('profile_id', '=', profileId)
      .orderBy('seq', 'desc')
      .execute();
    for (const extra of rows.slice(this.retention)) {
      await this.db.deleteFrom('backups').where('id', '=', extra.id).execute();
      rmSync(this.filePath(extra.id), { force: true });
    }
  }
}
