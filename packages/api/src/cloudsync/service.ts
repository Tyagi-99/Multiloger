/**
 * Encrypted S3-compatible backup sync (Phase 4b).
 *
 * Syncs the existing encrypted .mlbackup blobs to any S3-compatible
 * endpoint. The remote bytes are the SAME authenticated-encryption
 * envelope the local backups use — cloud sync never sees plaintext.
 *
 * Credentials come ONLY from the Phase 1 vault: the config row stores the
 * vault secret NAMES (access_key_secret, secret_key_secret), never values.
 * HTTPS is enforced unless the operator explicitly opts into insecure HTTP
 * (local MinIO/testing).
 *
 * RBAC: mutating operations require `backups:sync`; listing remote objects
 * requires `backups:read`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { getSecret, type KeySource } from '../vault/vault.js';
import { decryptBackup, resolveBackupKey } from '../backups/crypto.js';
import type { BackupService } from '../backups/service.js';
import { getProfile } from '../profiles/repository.js';
import { S3Client, S3Error } from './s3.js';

export class CloudSyncNotConfiguredError extends Error {
  constructor() {
    super('Cloud sync is not configured: PUT /v1/cloud-sync/config first');
  }
}

export class CloudSyncCredentialsError extends Error {
  constructor(detail: string) {
    super(`Cloud sync credentials unavailable: ${detail}`);
  }
}

export class CloudSyncIntegrityError extends Error {
  constructor(detail: string) {
    super(`Cloud sync integrity check failed: ${detail}`);
  }
}

/** The restore target client cannot be determined automatically. */
export class CloudSyncClientRequiredError extends Error {
  constructor(key: string) {
    super(`clientId is required: the source profile for ${key} no longer exists on this server`);
  }
}

export interface CloudSyncConfigInput {
  endpoint: string;
  bucket: string;
  region: string;
  /** Object key prefix; defaults to 'multiloger/'. */
  prefix?: string;
  /** Remote objects older than this (days) are pruned. Default 30. */
  retentionDays?: number;
  /** Vault secret name holding the S3 access key id. */
  accessKeySecretName: string;
  /** Vault secret name holding the S3 secret access key. */
  secretKeySecretName: string;
  /** Explicit opt-in for http:// endpoints (local MinIO/testing). */
  allowInsecureHttp?: boolean;
}

/** Config as returned by the API: secret NAMES only, never values. */
export interface PublicCloudSyncConfig {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  retentionDays: number;
  accessKeySecretName: string;
  secretKeySecretName: string;
  allowInsecureHttp: boolean;
  updatedAt: string;
}

export interface RemoteBackupObject {
  key: string;
  backupId: string | null;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface SyncResult {
  uploaded: string[];
  skipped: string[];
  failed: { backupId: string; error: string }[];
}

export interface PruneResult {
  deleted: string[];
}

const CONFIG_ID = 'default';

export interface CloudSyncServiceOptions {
  db: Kysely<DatabaseSchema>;
  backupService: BackupService;
  backupsDir: string;
  vaultPath: string;
  vaultSource?: KeySource;
  /** Key source for the backup encryption key (must match BackupService's). */
  backupKeySource?: KeySource;
}

export class CloudSyncService {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly backupService: BackupService;
  private readonly backupsDir: string;
  private readonly vaultPath: string;
  private readonly vaultSource: KeySource;
  private readonly backupKeySource: KeySource;

  constructor(options: CloudSyncServiceOptions) {
    this.db = options.db;
    this.backupService = options.backupService;
    this.backupsDir = options.backupsDir;
    this.vaultPath = options.vaultPath;
    this.vaultSource = options.vaultSource ?? {};
    this.backupKeySource = options.backupKeySource ?? {};
  }

  async getConfig(): Promise<PublicCloudSyncConfig | null> {
    const row = await this.db
      .selectFrom('cloud_sync_config')
      .selectAll()
      .where('id', '=', CONFIG_ID)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      endpoint: row.endpoint,
      bucket: row.bucket,
      region: row.region,
      prefix: row.prefix,
      retentionDays: row.retention,
      accessKeySecretName: row.access_key_secret,
      secretKeySecretName: row.secret_key_secret,
      allowInsecureHttp: row.allow_insecure === 1,
      updatedAt: row.updated_at,
    };
  }

  async saveConfig(input: CloudSyncConfigInput): Promise<PublicCloudSyncConfig> {
    const endpoint = input.endpoint.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new S3Error(0, `Invalid cloud sync endpoint: ${input.endpoint}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new S3Error(0, `Unsupported endpoint protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === 'http:' && !input.allowInsecureHttp) {
      throw new S3Error(
        0,
        'Refusing insecure http:// endpoint: use https:// or set allowInsecureHttp explicitly',
      );
    }
    const bucket = input.bucket.trim();
    if (!bucket) {
      throw new S3Error(0, 'Bucket is required');
    }
    const region = input.region.trim() || 'us-east-1';
    let prefix = (input.prefix ?? 'multiloger/').trim();
    if (prefix && !prefix.endsWith('/')) {
      prefix += '/';
    }
    const retentionDays = input.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new S3Error(0, 'retentionDays must be an integer >= 1');
    }
    const accessKeySecretName = input.accessKeySecretName.trim();
    const secretKeySecretName = input.secretKeySecretName.trim();
    if (!accessKeySecretName || !secretKeySecretName) {
      throw new S3Error(0, 'Vault secret names for both credentials are required');
    }

    // Fail fast: both vault secrets must exist. Values are never stored here.
    const missing: string[] = [];
    for (const name of [accessKeySecretName, secretKeySecretName]) {
      let value: string | undefined;
      try {
        value = getSecret(this.vaultPath, name, this.vaultSource);
      } catch {
        value = undefined;
      }
      if (!value) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new CloudSyncCredentialsError(
        `vault secret(s) not found: ${missing.join(', ')}. Store them first (multiloger vault set).`,
      );
    }

    const now = new Date().toISOString();
    await this.db
      .insertInto('cloud_sync_config')
      .values({
        id: CONFIG_ID,
        endpoint,
        bucket,
        region,
        prefix,
        access_key_secret: accessKeySecretName,
        secret_key_secret: secretKeySecretName,
        retention: retentionDays,
        allow_insecure: input.allowInsecureHttp === true ? 1 : 0,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          endpoint,
          bucket,
          region,
          prefix,
          access_key_secret: accessKeySecretName,
          secret_key_secret: secretKeySecretName,
          retention: retentionDays,
          allow_insecure: input.allowInsecureHttp === true ? 1 : 0,
          updated_at: now,
        }),
      )
      .execute();

    const config = await this.getConfig();
    if (!config) {
      throw new Error('Failed to read back cloud sync config');
    }
    return config;
  }

  private async buildClient(): Promise<{ client: S3Client; prefix: string }> {
    const config = await this.getConfig();
    if (!config) {
      throw new CloudSyncNotConfiguredError();
    }
    const accessKeyId = getSecret(this.vaultPath, config.accessKeySecretName, this.vaultSource);
    const secretAccessKey = getSecret(this.vaultPath, config.secretKeySecretName, this.vaultSource);
    if (!accessKeyId || !secretAccessKey) {
      throw new CloudSyncCredentialsError(
        `vault secret(s) missing: ${config.accessKeySecretName}, ${config.secretKeySecretName}`,
      );
    }
    return {
      client: new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId,
        secretAccessKey,
        allowInsecureHttp: config.allowInsecureHttp,
      }),
      prefix: config.prefix,
    };
  }

  private objectKey(prefix: string, backupId: string): string {
    return `${prefix}${backupId}.mlbackup`;
  }

  private backupIdOfKey(prefix: string, key: string): string | null {
    if (!key.startsWith(prefix) || !key.endsWith('.mlbackup')) {
      return null;
    }
    const stem = key.slice(prefix.length, -'.mlbackup'.length);
    if (!stem || stem.includes('/')) {
      return null;
    }
    return stem;
  }

  /** Upload every local backup that is missing or changed remotely. */
  async syncNow(): Promise<SyncResult> {
    const { client, prefix } = await this.buildClient();
    const rows = await this.db.selectFrom('backups').select(['id', 'size_bytes']).execute();
    const result: SyncResult = { uploaded: [], skipped: [], failed: [] };

    for (const row of rows) {
      const filePath = join(this.backupsDir, `${row.id}.mlbackup`);
      if (!existsSync(filePath)) {
        result.failed.push({ backupId: row.id, error: 'local backup file is missing' });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(filePath);
      } catch (error) {
        result.failed.push({
          backupId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const recorded = await this.db
        .selectFrom('cloud_sync_objects')
        .select(['size_bytes', 'sha256'])
        .where('backup_id', '=', row.id)
        .executeTakeFirst();
      const unchanged = recorded?.size_bytes === bytes.length && recorded.sha256 === sha256;
      if (unchanged) {
        result.skipped.push(row.id);
        continue;
      }
      const key = this.objectKey(prefix, row.id);
      try {
        const { etag } = await client.putObject(key, bytes);
        await this.db
          .insertInto('cloud_sync_objects')
          .values({
            backup_id: row.id,
            object_key: key,
            etag,
            size_bytes: bytes.length,
            sha256,
            uploaded_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.column('backup_id').doUpdateSet({
              object_key: key,
              etag,
              size_bytes: bytes.length,
              sha256,
              uploaded_at: new Date().toISOString(),
            }),
          )
          .execute();
        result.uploaded.push(row.id);
      } catch (error) {
        result.failed.push({
          backupId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async listRemote(): Promise<RemoteBackupObject[]> {
    const { client, prefix } = await this.buildClient();
    const objects = await client.listObjects(prefix);
    return objects.map((o) => ({
      key: o.key,
      backupId: this.backupIdOfKey(prefix, o.key),
      size: o.size,
      lastModified: o.lastModified,
      etag: o.etag,
    }));
  }

  /**
   * Download a remote object, verify its hash against the recorded upload
   * hash (when we uploaded it), then import it as a local backup and run
   * the standard restore path — which decrypts the AES-GCM envelope and
   * rejects any tampered blob.
   */
  async restoreRemote(
    key: string,
    input: { name: string; clientId?: string },
  ): Promise<{ backupId: string; profileId: string }> {
    const { client, prefix } = await this.buildClient();
    const backupId = this.backupIdOfKey(prefix, key);
    if (!backupId) {
      throw new S3Error(0, `Refusing to restore unexpected object key: ${key}`);
    }
    const bytes = await client.getObject(key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const recorded = await this.db
      .selectFrom('cloud_sync_objects')
      .select('sha256')
      .where('object_key', '=', key)
      .executeTakeFirst();
    if (recorded?.sha256 && recorded.sha256 !== sha256) {
      throw new CloudSyncIntegrityError(
        `downloaded object ${key} does not match the recorded hash — refusing to restore a tampered backup`,
      );
    }

    // Decrypt now: proves the AES-GCM envelope is intact and yields the
    // plaintext hash the local backups table expects.
    const backupKey = resolveBackupKey(this.backupKeySource);
    let plaintext: Buffer;
    try {
      plaintext = decryptBackup(backupKey, bytes);
    } catch (error) {
      throw new CloudSyncIntegrityError(
        `downloaded object ${key} failed authenticated decryption: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const plaintextSha256 = createHash('sha256').update(plaintext).digest('hex');

    // Resolve the true source profile when this server made the backup;
    // otherwise the restore target client must be given explicitly.
    const localOriginal = await this.db
      .selectFrom('backups')
      .select('profile_id')
      .where('id', '=', backupId)
      .executeTakeFirst();
    if (input.clientId === undefined) {
      const sourceProfileId = localOriginal?.profile_id ?? backupId;
      const source = await getProfile(this.db, sourceProfileId).catch(() => null);
      if (!source) {
        throw new CloudSyncClientRequiredError(key);
      }
    }

    const newId = randomUUID();
    const filePath = join(this.backupsDir, `${newId}.mlbackup`);
    writeFileSync(filePath, bytes, { mode: 0o600 });
    chmodSync(filePath, 0o600);
    await this.db
      .insertInto('backups')
      .values({
        id: newId,
        profile_id: localOriginal?.profile_id ?? backupId,
        file_name: `${backupId}.mlbackup`,
        size_bytes: bytes.length,
        sha256: plaintextSha256,
        encryption: 'aes-256-gcm',
        created_at: new Date().toISOString(),
      })
      .execute();

    let restored: { id: string };
    try {
      restored = await this.backupService.restoreBackup(newId, {
        name: input.name,
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      });
    } catch (error) {
      // Roll back the imported file and row: a failed restore must not
      // leave orphan debris in the local backups store.
      await this.db
        .deleteFrom('backups')
        .where('id', '=', newId)
        .execute()
        .catch(() => {
          /* best-effort cleanup */
        });
      rmSync(filePath, { force: true });
      throw error;
    }
    return { backupId: newId, profileId: restored.id };
  }

  /** Delete remote objects older than the configured retention. */
  async pruneRemote(now = Date.now()): Promise<PruneResult> {
    const { client, prefix } = await this.buildClient();
    const config = await this.getConfig();
    if (!config) {
      throw new CloudSyncNotConfiguredError();
    }
    const cutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
    const objects = await client.listObjects(prefix);
    const deleted: string[] = [];
    for (const o of objects) {
      const modified = o.lastModified ? Date.parse(o.lastModified) : NaN;
      if (!Number.isFinite(modified) || modified >= cutoff) {
        continue;
      }
      await client.deleteObject(o.key);
      await this.db.deleteFrom('cloud_sync_objects').where('object_key', '=', o.key).execute();
      deleted.push(o.key);
    }
    return { deleted };
  }
}
