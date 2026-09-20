/**
 * Cloud sync end-to-end tests (Phase 4b) against a mock S3 HTTP server.
 *
 * The mock server independently re-verifies every request's SigV4
 * signature from the wire bytes (method, raw path, raw query, headers) —
 * a signature bug in the client fails here with 403 SignatureDoesNotMatch
 * instead of silently passing. It also covers: incremental sync, remote
 * listing, tampered-object rejection (recorded-hash mismatch AND
 * authenticated-decryption failure), key-prefix confinement, and
 * retention pruning.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { resolveVaultPath } from '../vault/index.js';
import { storeSecret } from '../vault/vault.js';
import { encryptBackup, resolveBackupKey } from '../backups/crypto.js';
import { BackupService } from '../backups/service.js';
import {
  CloudSyncClientRequiredError,
  CloudSyncCredentialsError,
  CloudSyncIntegrityError,
  CloudSyncNotConfiguredError,
  CloudSyncService,
} from './service.js';
import { S3Error } from './s3.js';

// ---------------------------------------------------------------------------
// Independent SigV4 verifier: transcribed from the spec, working from the
// raw wire bytes rather than the signer's constructed inputs.
// ---------------------------------------------------------------------------

const TEST_ACCESS_KEY = 'TESTACCESSKEYID';
const TEST_SECRET_KEY = 'TESTSECRETACCESSKEY';
const TEST_REGION = 'us-east-1';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Recompute the expected signature from the received request. */
function verifyS3Signature(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') {
    return false;
  }
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/\s]+)\/(\d{8})\/([^/\s]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!m) {
    return false;
  }
  const [, accessKey, dateStamp, region, signedHeaders, signature] = m;
  if (
    !accessKey ||
    !dateStamp ||
    !region ||
    !signedHeaders ||
    !signature ||
    accessKey !== TEST_ACCESS_KEY ||
    region !== TEST_REGION
  ) {
    return false;
  }
  const amzDate = req.headers['x-amz-date'];
  const contentHash = req.headers['x-amz-content-sha256'];
  if (typeof amzDate !== 'string' || typeof contentHash !== 'string') {
    return false;
  }
  if (!amzDate.startsWith(dateStamp)) {
    return false;
  }
  const rawTarget = req.url ?? '/';
  const qIndex = rawTarget.indexOf('?');
  const rawPath = qIndex === -1 ? rawTarget : rawTarget.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? '' : rawTarget.slice(qIndex + 1);
  const pairs: [string, string][] = rawQuery
    ? rawQuery.split('&').map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)] as [string, string];
      })
    : [];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQuery = pairs.map(([n, v]) => `${n}=${v}`).join('&');
  const canonicalHeaders =
    signedHeaders
      .split(';')
      .map((name) => {
        const value = req.headers[name];
        const text = Array.isArray(value) ? value.join(',') : (value ?? '');
        return `${name}:${text.trim().replace(/\s+/g, ' ')}`;
      })
      .join('\n') + '\n';
  const canonicalRequest = [
    req.method ?? 'GET',
    rawPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${TEST_SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const expected = hmac(kSigning, stringToSign);
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function s3ErrorXml(code: string, message: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error><Code>${code}</Code><Message>${message}</Message></Error>`
  );
}

interface StoredObject {
  bytes: Buffer;
  lastModified: string;
  etag: string;
}

/** Minimal S3-compatible mock: path-style, ListObjectsV2, signature-checked. */
class MockS3 {
  private server: Server | null = null;
  readonly objects = new Map<string, StoredObject>();
  port = 0;

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /** Corrupt a stored object in place (tamper simulation). */
  corrupt(key: string): void {
    const obj = this.objects.get(key);
    if (!obj) {
      throw new Error(`no such object: ${key}`);
    }
    const bytes = Buffer.from(obj.bytes);
    const index = Math.min(10, bytes.length - 1);
    const byte = bytes[index];
    if (byte === undefined) {
      throw new Error('cannot corrupt empty object');
    }
    bytes[index] = byte ^ 0xff;
    this.objects.set(key, { ...obj, bytes });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    if (!verifyS3Signature(req)) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(
        s3ErrorXml('SignatureDoesNotMatch', 'The request signature we calculated does not match'),
      );
      return;
    }
    // When the client signs a real payload hash, it must match the body.
    const contentHash = req.headers['x-amz-content-sha256'];
    if (
      typeof contentHash === 'string' &&
      contentHash !== 'UNSIGNED-PAYLOAD' &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.method !== 'DELETE' &&
      sha256Hex(body) !== contentHash
    ) {
      res.writeHead(400, { 'content-type': 'application/xml' });
      res.end(
        s3ErrorXml('BadDigest', 'The Content-SHA256 you specified did not match what we received'),
      );
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    const bucket = segments[0] ?? '';
    if (bucket !== 'test-bucket') {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(s3ErrorXml('NoSuchBucket', 'The specified bucket does not exist'));
      return;
    }
    const key = segments
      .slice(1)
      .map((s) => decodeURIComponent(s))
      .join('/');

    // ListObjectsV2: GET /<bucket>/?list-type=2&prefix=...
    if (key === '' && req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...this.objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, o]) =>
            `<Contents><Key>${k}</Key><Size>${String(o.bytes.length)}</Size>` +
            `<LastModified>${o.lastModified}</LastModified><ETag>"${o.etag}"</ETag></Contents>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === 'PUT') {
      const etag = sha256Hex(body).slice(0, 32);
      this.objects.set(key, {
        bytes: body,
        lastModified: new Date().toISOString(),
        etag,
      });
      res.writeHead(200, { etag: `"${etag}"` });
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const obj = this.objects.get(key);
      if (!obj) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(s3ErrorXml('NoSuchKey', 'The specified key does not exist'));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(obj.bytes.length),
        etag: `"${obj.etag}"`,
      });
      res.end(obj.bytes);
      return;
    }
    if (req.method === 'HEAD') {
      const obj = this.objects.get(key);
      if (!obj) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-length': String(obj.bytes.length),
        etag: `"${obj.etag}"`,
      });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      this.objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VAULT_KEY_HEX = randomBytes(32).toString('hex');
const BACKUP_KEY_HEX = randomBytes(32).toString('hex');

interface Fixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  backupsDir: string;
  service: CloudSyncService;
  backupService: BackupService;
  mock: MockS3;
  clientId: string;
  endpoint: string;
  keySource: { keyHex: string };
}

let fixture: Fixture | undefined;

afterEach(async () => {
  if (fixture) {
    await fixture.mock.stop();
    await closeDatabase(fixture.db);
    rmSync(fixture.dir, { recursive: true, force: true });
    fixture = undefined;
  }
});

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-cloudsync-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const client = await createClient(db, { name: 'Acme' });

  const vaultPath = resolveVaultPath(dir);
  storeSecret(vaultPath, 's3-access-key-id', TEST_ACCESS_KEY, { keyHex: VAULT_KEY_HEX });
  storeSecret(vaultPath, 's3-secret-access-key', TEST_SECRET_KEY, { keyHex: VAULT_KEY_HEX });

  const keySource = { keyHex: BACKUP_KEY_HEX };
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const backupService = new BackupService({
    db,
    dataDir: dir,
    backupsDir,
    keyHex: BACKUP_KEY_HEX,
    profiles: { stopProfile: () => Promise.resolve() },
  });
  const service = new CloudSyncService({
    db,
    backupService,
    backupsDir,
    vaultPath,
    vaultSource: { keyHex: VAULT_KEY_HEX },
    backupKeySource: keySource,
  });

  const mock = new MockS3();
  await mock.start();
  fixture = {
    dir,
    db,
    backupsDir,
    service,
    backupService,
    mock,
    clientId: client.id,
    endpoint: `http://127.0.0.1:${String(mock.port)}`,
    keySource,
  };
  return fixture;
}

/** Write a local encrypted backup blob + DB row (bypasses BackupService.create). */
async function makeLocalBackup(
  fx: Fixture,
  plaintext: string,
): Promise<{ id: string; bytes: Buffer }> {
  const id = randomUUID();
  const key = resolveBackupKey(fx.keySource);
  const bytes = encryptBackup(key, Buffer.from(plaintext));
  writeFileSync(join(fx.backupsDir, `${id}.mlbackup`), bytes, { mode: 0o600 });
  await fx.db
    .insertInto('backups')
    .values({
      id,
      profile_id: 'profile-1',
      file_name: `${id}.mlbackup`,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
      encryption: 'aes-256-gcm',
      created_at: new Date().toISOString(),
    })
    .execute();
  return { id, bytes };
}

async function configure(fx: Fixture, overrides: Record<string, unknown> = {}): Promise<void> {
  await fx.service.saveConfig({
    endpoint: fx.endpoint,
    bucket: 'test-bucket',
    region: TEST_REGION,
    prefix: 'multiloger/',
    retentionDays: 30,
    accessKeySecretName: 's3-access-key-id',
    secretKeySecretName: 's3-secret-access-key',
    allowInsecureHttp: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud sync config', () => {
  it('rejects http endpoints without the explicit insecure opt-in', async () => {
    const fx = await setup();
    await expect(
      fx.service.saveConfig({
        endpoint: fx.endpoint,
        bucket: 'test-bucket',
        region: TEST_REGION,
        accessKeySecretName: 's3-access-key-id',
        secretKeySecretName: 's3-secret-access-key',
      }),
    ).rejects.toThrow(S3Error);
  });

  it('rejects missing vault secrets without leaking values', async () => {
    const fx = await setup();
    await expect(
      fx.service.saveConfig({
        endpoint: fx.endpoint,
        bucket: 'test-bucket',
        region: TEST_REGION,
        accessKeySecretName: 'nope-missing',
        secretKeySecretName: 's3-secret-access-key',
        allowInsecureHttp: true,
      }),
    ).rejects.toThrow(CloudSyncCredentialsError);
  });

  it('returns secret names, never secret values', async () => {
    const fx = await setup();
    await configure(fx);
    const config = await fx.service.getConfig();
    expect(config).not.toBeNull();
    const dumped = JSON.stringify(config);
    expect(dumped).toContain('s3-access-key-id');
    expect(dumped).not.toContain(TEST_SECRET_KEY);
    expect(dumped).not.toContain(TEST_ACCESS_KEY);
  });

  it('throws when not configured', async () => {
    const fx = await setup();
    await expect(fx.service.getConfig()).resolves.toBeNull();
    await expect(fx.service.syncNow()).rejects.toThrow(CloudSyncNotConfiguredError);
    await expect(fx.service.listRemote()).rejects.toThrow(CloudSyncNotConfiguredError);
  });
});

describe('syncNow', () => {
  it('uploads new backups and skips unchanged ones', async () => {
    const fx = await setup();
    await configure(fx);
    const { id, bytes } = await makeLocalBackup(fx, 'tar-plaintext-1');

    const first = await fx.service.syncNow();
    expect(first.uploaded).toEqual([id]);
    expect(first.failed).toEqual([]);
    const remote = fx.mock.objects.get(`multiloger/${id}.mlbackup`);
    if (!remote) {
      throw new Error('expected the object to be uploaded');
    }
    expect(remote.bytes.equals(bytes)).toBe(true);

    const second = await fx.service.syncNow();
    expect(second.uploaded).toEqual([]);
    expect(second.skipped).toEqual([id]);
  });

  it('re-uploads when the local file changes', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'v1');
    await fx.service.syncNow();
    // Simulate a changed local file (same id, new bytes).
    const key = resolveBackupKey(fx.keySource);
    const bytes2 = encryptBackup(key, Buffer.from('v2'));
    writeFileSync(join(fx.backupsDir, `${id}.mlbackup`), bytes2);
    const result = await fx.service.syncNow();
    expect(result.uploaded).toEqual([id]);
    const remote = fx.mock.objects.get(`multiloger/${id}.mlbackup`);
    if (!remote) {
      throw new Error('expected the object to be re-uploaded');
    }
    expect(remote.bytes.equals(bytes2)).toBe(true);
  });

  it('reports missing local files as failures, not crashes', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'x');
    // Delete the file but keep the DB row.
    rmSync(join(fx.backupsDir, `${id}.mlbackup`));
    const result = await fx.service.syncNow();
    expect(result.failed).toHaveLength(1);
    const [failure] = result.failed;
    if (!failure) {
      throw new Error('expected one failure');
    }
    expect(failure.backupId).toBe(id);
  });
});

describe('listRemote', () => {
  it('lists uploaded objects with metadata', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'data');
    await fx.service.syncNow();
    const objects = await fx.service.listRemote();
    expect(objects).toHaveLength(1);
    const [object] = objects;
    if (!object) {
      throw new Error('expected one object');
    }
    expect(object.key).toBe(`multiloger/${id}.mlbackup`);
    expect(object.backupId).toBe(id);
    expect(object.size).toBeGreaterThan(0);
  });
});

describe('restoreRemote', () => {
  it('downloads, verifies, and restores into a new profile', async () => {
    const fx = await setup();
    await configure(fx);
    // A restorable blob needs a real tar; use BackupService to make one.
    const profileDir = join(fx.dir, 'profiles', 'p1');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'hello.txt'), 'hello');
    const profile = await createProfile(fx.db, {
      clientId: fx.clientId,
      name: 'orig',
      userDataDir: profileDir,
    });
    const created = await fx.backupService.createBackup(profile.id);
    const syncResult = await fx.service.syncNow();
    expect(syncResult.uploaded).toContain(created.id);

    const restored = await fx.service.restoreRemote(`multiloger/${created.id}.mlbackup`, {
      name: 'restored-profile',
      clientId: fx.clientId,
    });
    expect(restored.profileId).not.toBe(profile.id);
    const restoredProfile = await fx.db
      .selectFrom('profiles')
      .selectAll()
      .where('id', '=', restored.profileId)
      .executeTakeFirst();
    if (!restoredProfile) {
      throw new Error('expected the restored profile to exist');
    }
    expect(restoredProfile.name).toBe('restored-profile');
    expect(readFileSync(join(restoredProfile.user_data_dir, 'hello.txt'), 'utf8')).toBe('hello');
  });

  it('rejects a tampered object that no longer matches the recorded hash', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'tamper-me');
    await fx.service.syncNow();
    fx.mock.corrupt(`multiloger/${id}.mlbackup`);
    await expect(
      fx.service.restoreRemote(`multiloger/${id}.mlbackup`, { name: 'evil' }),
    ).rejects.toThrow(CloudSyncIntegrityError);
  });

  it('rejects a tampered object via authenticated decryption when no hash is recorded', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'tamper-me-2');
    await fx.service.syncNow();
    // Forget the upload record: integrity must still hold via AES-GCM.
    await fx.db.deleteFrom('cloud_sync_objects').where('backup_id', '=', id).execute();
    fx.mock.corrupt(`multiloger/${id}.mlbackup`);
    await expect(
      fx.service.restoreRemote(`multiloger/${id}.mlbackup`, { name: 'evil' }),
    ).rejects.toThrow(/authenticated decryption/);
  });

  it('refuses keys outside the configured prefix', async () => {
    const fx = await setup();
    await configure(fx);
    await expect(
      fx.service.restoreRemote('other/prefix/evil.mlbackup', { name: 'evil' }),
    ).rejects.toThrow(S3Error);
    await expect(
      fx.service.restoreRemote('multiloger/../escape.mlbackup', { name: 'evil' }),
    ).rejects.toThrow(S3Error);
  });

  it('requires clientId when the source profile no longer exists locally', async () => {
    const fx = await setup();
    await configure(fx);
    // makeLocalBackup writes a backups row pointing at a fake profile id,
    // simulating a remote object from another server.
    const { id } = await makeLocalBackup(fx, 'orphan');
    await fx.service.syncNow();
    await expect(
      fx.service.restoreRemote(`multiloger/${id}.mlbackup`, { name: 'x' }),
    ).rejects.toThrow(CloudSyncClientRequiredError);
  });

  it('rolls back the imported file and row when the restore fails', async () => {
    const fx = await setup();
    await configure(fx);
    const { id } = await makeLocalBackup(fx, 'rollback');
    await fx.service.syncNow();

    const rowsBefore = await fx.db.selectFrom('backups').select('id').execute();
    const filesBefore = new Set(readdirSync(fx.backupsDir));

    // A blank name passes the route layer only in theory; here it forces
    // restoreBackup to throw AFTER the file and row were imported.
    await expect(
      fx.service.restoreRemote(`multiloger/${id}.mlbackup`, {
        name: '   ',
        clientId: fx.clientId,
      }),
    ).rejects.toThrow(/1-200 characters/);

    const rowsAfter = await fx.db.selectFrom('backups').select('id').execute();
    expect(rowsAfter.map((r) => r.id).sort()).toEqual(rowsBefore.map((r) => r.id).sort());
    expect(new Set(readdirSync(fx.backupsDir))).toEqual(filesBefore);
  });
});

describe('pruneRemote', () => {
  it('deletes objects older than retention and keeps newer ones', async () => {
    const fx = await setup();
    await configure(fx, { retentionDays: 30 });
    const oldBackup = await makeLocalBackup(fx, 'old');
    const newBackup = await makeLocalBackup(fx, 'new');
    await fx.service.syncNow();
    // Age the first object 60 days on the mock server.
    const stored = fx.mock.objects.get(`multiloger/${oldBackup.id}.mlbackup`);
    if (!stored) {
      throw new Error('expected the old object to be uploaded');
    }
    fx.mock.objects.set(`multiloger/${oldBackup.id}.mlbackup`, {
      ...stored,
      lastModified: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await fx.service.pruneRemote();
    expect(result.deleted).toEqual([`multiloger/${oldBackup.id}.mlbackup`]);
    expect(fx.mock.objects.has(`multiloger/${newBackup.id}.mlbackup`)).toBe(true);
    const remaining = await fx.service.listRemote();
    expect(remaining.map((o) => o.key)).toEqual([`multiloger/${newBackup.id}.mlbackup`]);
  });
});
