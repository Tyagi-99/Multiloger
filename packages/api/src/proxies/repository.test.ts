import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { InvalidProxyError } from '../browser/flags.js';
import {
  assignProxyToProfile,
  createProxy,
  deleteProxy,
  getAssignedProxy,
  getProxy,
  InvalidSecretRefError,
  listProxies,
  ProxyNotFoundError,
  setProxyRequired,
  toPublicProxy,
  unassignProxyFromProfile,
  updateProxy,
} from './repository.js';

async function setup(): Promise<{ dir: string; db: Kysely<DatabaseSchema>; clientId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-proxy-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const clientId = (await createClient(db, { name: 'Acme' })).id;
  return { dir, db, clientId };
}

describe('proxy repository', () => {
  let ctx: { dir: string; db: Kysely<DatabaseSchema>; clientId: string } | undefined;

  afterEach(async () => {
    if (ctx) {
      await closeDatabase(ctx.db);
      rmSync(ctx.dir, { recursive: true, force: true });
      ctx = undefined;
    }
  });

  it('creates, reads, updates, and deletes a proxy', async () => {
    ctx = await setup();
    const { db } = ctx;

    const created = await createProxy(db, {
      name: 'dc-1',
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
    });
    expect(created.id).toBeTruthy();
    expect(created.username).toBeNull();

    expect((await getProxy(db, created.id)).name).toBe('dc-1');
    expect(await listProxies(db)).toHaveLength(1);

    const updated = await updateProxy(db, created.id, { port: 8081, notes: 'rotated' });
    expect(updated.port).toBe(8081);
    expect(updated.notes).toBe('rotated');

    await deleteProxy(db, created.id);
    await expect(getProxy(db, created.id)).rejects.toThrow(ProxyNotFoundError);
    expect(await listProxies(db)).toHaveLength(0);
  });

  it('rejects invalid endpoints with the same errors as the flag builder', async () => {
    ctx = await setup();
    const { db } = ctx;
    await expect(
      createProxy(db, { name: 'bad', scheme: 'http', host: 'evil --flag', port: 8080 }),
    ).rejects.toThrow(InvalidProxyError);
    await expect(
      createProxy(db, { name: 'bad', scheme: 'http', host: 'proxy.example.com', port: 99999 }),
    ).rejects.toThrow(InvalidProxyError);
    await expect(
      createProxy(db, {
        name: 'bad',
        scheme: 'gopher' as 'http',
        host: 'proxy.example.com',
        port: 8080,
      }),
    ).rejects.toThrow();
  });

  it('rejects plaintext password references — env: refs only', async () => {
    ctx = await setup();
    const { db } = ctx;
    await expect(
      createProxy(db, {
        name: 'p1',
        scheme: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        passwordSecretRef: 's3cr3t-plaintext',
      }),
    ).rejects.toThrow(InvalidSecretRefError);

    const ok = await createProxy(db, {
      name: 'p1',
      scheme: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
    });
    expect(ok.password_secret_ref).toBe('env:TEST_PROXY_PASSWORD');
  });

  it('assigns, reads back, reassigns, and unassigns proxies per profile', async () => {
    ctx = await setup();
    const { db, clientId, dir } = ctx;
    const profile = await createProfile(db, {
      clientId,
      name: 'p1',
      userDataDir: join(dir, 'profiles', 'p1'),
    });
    const a = await createProxy(db, { name: 'a', scheme: 'http', host: 'a.example.com', port: 8080 });
    const b = await createProxy(db, { name: 'b', scheme: 'http', host: 'b.example.com', port: 8080 });

    expect(await getAssignedProxy(db, profile.id)).toBeUndefined();

    await assignProxyToProfile(db, profile.id, a.id);
    expect((await getAssignedProxy(db, profile.id))?.id).toBe(a.id);

    await assignProxyToProfile(db, profile.id, b.id);
    expect((await getAssignedProxy(db, profile.id))?.id).toBe(b.id);

    await unassignProxyFromProfile(db, profile.id);
    expect(await getAssignedProxy(db, profile.id)).toBeUndefined();
  });

  it('refuses to delete a proxy that is assigned to a profile', async () => {
    ctx = await setup();
    const { db, clientId, dir } = ctx;
    const profile = await createProfile(db, {
      clientId,
      name: 'p1',
      userDataDir: join(dir, 'profiles', 'p1'),
    });
    const proxy = await createProxy(db, {
      name: 'a',
      scheme: 'http',
      host: 'a.example.com',
      port: 8080,
    });
    await assignProxyToProfile(db, profile.id, proxy.id);
    await expect(deleteProxy(db, proxy.id)).rejects.toThrow(/assigned to a profile/);
  });

  it('toggles proxy_required', async () => {
    ctx = await setup();
    const { db, clientId, dir } = ctx;
    const profile = await createProfile(db, {
      clientId,
      name: 'p1',
      userDataDir: join(dir, 'profiles', 'p1'),
    });
    const row = async (): Promise<number> =>
      (
        await db.selectFrom('profiles').select(['proxy_required']).where('id', '=', profile.id).executeTakeFirstOrThrow()
      ).proxy_required;

    expect(await row()).toBe(0);
    await setProxyRequired(db, profile.id, true);
    expect(await row()).toBe(1);
    await setProxyRequired(db, profile.id, false);
    expect(await row()).toBe(0);
  });

  it('the public shape never carries the credential reference', async () => {
    ctx = await setup();
    const { db } = ctx;
    const created = await createProxy(db, {
      name: 'cred',
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'user',
      passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
    });
    const pub = toPublicProxy(created);
    expect(pub.has_credentials).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('TEST_PROXY_PASSWORD');
    expect(JSON.stringify(pub)).not.toContain('password_secret_ref');
    expect('password_secret_ref' in pub).toBe(false);
  });
});
