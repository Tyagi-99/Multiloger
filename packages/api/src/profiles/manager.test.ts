import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from './repository.js';
import { getState } from './stateMachine.js';
import { acquireLock, getLockInfo, newOwnerToken, ProfileNotFoundError } from './lock.js';
import { getLastSession } from './sessions.js';
import { killBrowserGroup, pingCdp } from '../browser/launcher.js';
import { AlreadyRunningError, ProfileBusyError, ProfileManager, pidAlive } from './manager.js';

interface Fixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  manager: ProfileManager;
  profileId: string;
  clientId: string;
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-mgr-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const client = await createClient(db, { name: 'Acme' });
  const profile = await createProfile(db, {
    clientId: client.id,
    name: 'p1',
    userDataDir: join(dir, 'profiles', 'p1'),
  });
  const manager = new ProfileManager(db, { dataDir: dir, lockTtlMs: 3000 });
  manager.start();
  return { dir, db, manager, profileId: profile.id, clientId: client.id };
}

describe('ProfileManager lifecycle (live Chromium)', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.manager.shutdown();
      await closeDatabase(fixture.db);
      rmSync(fixture.dir, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  async function waitForUnlock(db: Kysely<DatabaseSchema>, id: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (!(await getLockInfo(db, id, 3000)).active) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out waiting for the lock to be released');
  }

  async function waitForState(
    db: Kysely<DatabaseSchema>,
    id: string,
    state: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if ((await getState(db, id)) === state) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for state ${state}; now ${await getState(db, id)}`);
  }

  it('launches to running with CDP reachable, lock held, session recorded', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    const launched = await manager.launchProfile(profileId);
    try {
      expect(await getState(db, profileId)).toBe('running');
      expect(await pingCdp(launched.cdpUrl, 3000)).toBe(true);

      // Lock is held by the manager.
      expect((await getLockInfo(db, profileId, 3000)).active).toBe(true);

      const session = await getLastSession(db, profileId);
      expect(session?.pid).toBe(launched.pid);
      expect(session?.ended_at).toBeNull();
    } finally {
      await manager.stopProfile(profileId);
    }
  }, 60_000);

  it('rejects a second launch while running', async () => {
    fixture = await setup();
    const { manager, profileId } = fixture;
    await manager.launchProfile(profileId);
    try {
      await expect(manager.launchProfile(profileId)).rejects.toThrow(AlreadyRunningError);
    } finally {
      await manager.stopProfile(profileId);
    }
  }, 60_000);

  it('rejects launch when another owner holds the lock', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    // Simulate a lock held by someone else without going through launch.
    const other = newOwnerToken();
    expect(await acquireLock(db, profileId, other, 30_000)).toBe(true);
    await expect(manager.launchProfile(profileId)).rejects.toThrow(ProfileBusyError);
  });

  it('stops gracefully: process gone, state stopped, lock released, session closed', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    const launched = await manager.launchProfile(profileId);
    await manager.stopProfile(profileId);

    expect(await getState(db, profileId)).toBe('stopped');
    expect(pidAlive(launched.pid)).toBe(false);
    // Lock released.
    expect((await getLockInfo(db, profileId, 3000)).active).toBe(false);

    const session = await getLastSession(db, profileId);
    expect(session?.exit_reason).toBe('stopped');
    expect(session?.ended_at).not.toBeNull();
  }, 60_000);

  it('stop is idempotent on a stopped or never-launched profile', async () => {
    fixture = await setup();
    const { db, manager, profileId, clientId, dir } = fixture;
    await manager.launchProfile(profileId);
    await manager.stopProfile(profileId);
    await manager.stopProfile(profileId);
    expect(await getState(db, profileId)).toBe('stopped');

    const neverLaunched = await createProfile(db, {
      clientId,
      name: 'p2',
      userDataDir: join(dir, 'profiles', 'p2'),
    });
    await manager.stopProfile(neverLaunched.id);
    expect(await getState(db, neverLaunched.id)).toBe('created');
  }, 60_000);

  it('restarts: new browser, running again', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    const first = await manager.launchProfile(profileId);
    const second = await manager.restartProfile(profileId);
    try {
      expect(second.pid).not.toBe(first.pid);
      expect(await getState(db, profileId)).toBe('running');
      expect(await pingCdp(second.cdpUrl, 3000)).toBe(true);
    } finally {
      await manager.stopProfile(profileId);
    }
  }, 90_000);

  it('marks crashed and releases the lock when the browser is SIGKILLed', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    const launched = await manager.launchProfile(profileId);
    // Simulate an external crash: kill the group out from under the manager.
    killBrowserGroup(launched.pid, 'SIGKILL');

    await waitForState(db, profileId, 'crashed');
    await waitForUnlock(db, profileId);
    expect(manager.isLive(profileId)).toBe(false);
    expect((await getLockInfo(db, profileId, 3000)).active).toBe(false);

    const session = await getLastSession(db, profileId);
    expect(session?.exit_reason).toBe('crashed');

    // Acknowledging the crash moves it to stopped.
    await manager.stopProfile(profileId);
    expect(await getState(db, profileId)).toBe('stopped');
  }, 60_000);

  it('heartbeats the lock so a long session never loses it', async () => {
    fixture = await setup();
    const { db, manager, profileId } = fixture;
    await manager.launchProfile(profileId);
    try {
      // TTL is 3s, heartbeat runs every 1s: after 4.5s the lock must still
      // be held by the manager.
      await new Promise((resolve) => setTimeout(resolve, 4500));
      expect((await getLockInfo(db, profileId, 3000)).active).toBe(true);
      expect(await getState(db, profileId)).toBe('running');
    } finally {
      await manager.stopProfile(profileId);
    }
  }, 60_000);

  it('throws ProfileNotFoundError for an unknown profile', async () => {
    fixture = await setup();
    await expect(fixture.manager.launchProfile('nope')).rejects.toThrow(ProfileNotFoundError);
  });
});
