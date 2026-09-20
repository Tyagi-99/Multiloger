import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import type { DatabaseSchema } from '../db/schema.js';
import { getState, transitionState } from './stateMachine.js';
import {
  acquireLock,
  getLockInfo,
  heartbeatLock,
  newOwnerToken,
  ProfileNotFoundError,
  reapStaleLocks,
  releaseLock,
} from './lock.js';
import { IllegalTransitionError } from './states.js';
import { profileEvents, type ProfileDomainEvent } from './events.js';
import { createClient, createProfile } from './repository.js';

async function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-profiles-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const client = await createClient(db, { name: 'Acme' });
  const profile = await createProfile(db, {
    clientId: client.id,
    name: 'p1',
    userDataDir: join(dir, 'p1'),
  });
  return { dir, db, profile };
}

describe('stateMachine', () => {
  let dir = '';
  let db: Kysely<DatabaseSchema> | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists legal transitions and emits events', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    const { profile } = setup;
    expect(await getState(db, profile.id)).toBe('created');

    const seen: ProfileDomainEvent[] = [];
    const off = profileEvents.on((e) => {
      seen.push(e);
    });

    await transitionState(db, profile.id, 'launching');
    await transitionState(db, profile.id, 'running');
    expect(await getState(db, profile.id)).toBe('running');

    const changes = seen.filter((e) => e.type === 'profile.state-changed');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ profileId: profile.id, from: 'created', to: 'launching' });
    expect(changes[1]).toMatchObject({ from: 'launching', to: 'running' });
    off();
  });

  it('throws IllegalTransitionError on illegal moves and leaves state untouched', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    await expect(transitionState(db, setup.profile.id, 'running')).rejects.toThrow(
      IllegalTransitionError,
    );
    expect(await getState(db, setup.profile.id)).toBe('created');
  });

  it('throws ProfileNotFoundError for unknown profiles', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    await expect(transitionState(db, 'nope', 'launching')).rejects.toThrow(ProfileNotFoundError);
    await expect(getState(db, 'nope')).rejects.toThrow(ProfileNotFoundError);
  });
});

describe('profile locks', () => {
  let dir = '';
  let db: Kysely<DatabaseSchema> | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants the lock to exactly one of two contenders', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    const [a, b] = await Promise.all([
      acquireLock(db, setup.profile.id, newOwnerToken(), 30_000),
      acquireLock(db, setup.profile.id, newOwnerToken(), 30_000),
    ]);
    expect(Number(a) + Number(b)).toBe(1);
  });

  it('lets a stale lock be stolen and reaped', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    const { profile } = setup;
    const ownerA = newOwnerToken();
    expect(await acquireLock(db, profile.id, ownerA, 30_000)).toBe(true);

    // Fresh lock: contender loses.
    expect(await acquireLock(db, profile.id, newOwnerToken(), 30_000)).toBe(false);

    // Backdate the lock so it looks stale, then stealing works.
    const stale = new Date(Date.now() - 60_000).toISOString();
    await db
      .updateTable('profiles')
      .set({ locked_at: stale })
      .where('id', '=', profile.id)
      .execute();

    const ownerB = newOwnerToken();
    expect(await acquireLock(db, profile.id, ownerB, 30_000)).toBe(true);
    // Old owner's release no longer works.
    expect(await releaseLock(db, profile.id, ownerA)).toBe(false);

    // Reap path: backdate again and reap.
    await db
      .updateTable('profiles')
      .set({ locked_at: stale })
      .where('id', '=', profile.id)
      .execute();
    expect(await reapStaleLocks(db, 30_000)).toBe(1);
    const info = await getLockInfo(db, profile.id, 30_000);
    expect(info.active).toBe(false);
    expect(info.owner).toBeNull();
  });

  it('heartbeat keeps a lock alive; release requires the owner token', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    const { profile } = setup;
    const owner = newOwnerToken();
    await acquireLock(db, profile.id, owner, 30_000);
    expect(await heartbeatLock(db, profile.id, owner)).toBe(true);
    expect(await heartbeatLock(db, profile.id, newOwnerToken())).toBe(false);

    expect(await releaseLock(db, profile.id, newOwnerToken())).toBe(false);
    expect(await releaseLock(db, profile.id, owner)).toBe(true);
    // Second release is a no-op.
    expect(await releaseLock(db, profile.id, owner)).toBe(false);

    const info = await getLockInfo(db, profile.id, 30_000);
    expect(info).toEqual({ owner: null, lockedAt: null, active: false });
  });

  it('emits lock events', async () => {
    const setup = await setupDb();
    dir = setup.dir;
    db = setup.db;
    const seen: ProfileDomainEvent[] = [];
    const off = profileEvents.on((e) => {
      seen.push(e);
    });
    const owner = newOwnerToken();
    await acquireLock(db, setup.profile.id, owner, 30_000);
    await releaseLock(db, setup.profile.id, owner);
    off();
    expect(seen.map((e) => e.type)).toEqual(['profile.lock-acquired', 'profile.lock-released']);
  });
});
