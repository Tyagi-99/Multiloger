import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { getState, transitionState } from '../profiles/stateMachine.js';
import { pidAlive } from '../profiles/manager.js';
import { killBrowserGroup, launchChromium } from './launcher.js';
import { findManagedChromiumProcesses, killOrphanBrowsers, reconcileOnBoot } from './reaper.js';

interface Fixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  clientId: string;
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-reaper-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const clientId = (await createClient(db, { name: 'Acme' })).id;
  return { dir, db, clientId };
}

describe('startup reaper', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture) {
      // Belt and braces: nothing launched in these tests may survive.
      killOrphanBrowsers(fixture.dir, new Set());
      await closeDatabase(fixture.db);
      rmSync(fixture.dir, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  it('marks a stale running profile with a dead PID as crashed and clears its lock', async () => {
    fixture = await setup();
    const { db, dir, clientId } = fixture;
    const profile = await createProfile(db, {
      clientId,
      name: 'stale',
      userDataDir: join(dir, 'profiles', 'stale'),
    });
    await transitionState(db, profile.id, 'launching');
    await transitionState(db, profile.id, 'running');
    await db
      .updateTable('profiles')
      .set({
        last_pid: 999999999,
        locked_by: 'dead-owner',
        locked_at: new Date(Date.now() - 600_000).toISOString(),
      })
      .where('id', '=', profile.id)
      .execute();

    const result = await reconcileOnBoot(db, dir, 30_000);

    expect(result.markedCrashed).toContain(profile.id);
    expect(await getState(db, profile.id)).toBe('crashed');
    const row = await db
      .selectFrom('profiles')
      .select(['locked_by', 'last_pid'])
      .where('id', '=', profile.id)
      .executeTakeFirstOrThrow();
    expect(row.locked_by).toBeNull();
    expect(row.last_pid).toBeNull();
    expect(result.staleLocksReaped).toBe(1);
  });

  it('kills an unmanaged live browser and marks its launching profile crashed', async () => {
    fixture = await setup();
    const { db, dir, clientId } = fixture;
    const profile = await createProfile(db, {
      clientId,
      name: 'abandoned',
      userDataDir: join(dir, 'profiles', 'abandoned'),
    });
    // Raw launch, deliberately NOT registered with any manager (simulates a
    // manager that died right after spawning the browser).
    const browser = await launchChromium({
      userDataDir: join(dir, 'profiles', 'abandoned'),
      headless: true,
    });
    await transitionState(db, profile.id, 'launching');
    await db
      .updateTable('profiles')
      .set({ last_pid: browser.pid, last_cdp_port: browser.port })
      .where('id', '=', profile.id)
      .execute();
    expect(pidAlive(browser.pid)).toBe(true);

    const result = await reconcileOnBoot(db, dir, 30_000);

    expect(result.markedCrashed).toContain(profile.id);
    expect(await getState(db, profile.id)).toBe('crashed');
    // Give SIGKILL a moment, then the group must be gone.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(pidAlive(browser.pid)).toBe(false);
  }, 60_000);

  it('finds and kills orphan Chromium processes under the data dir', async () => {
    fixture = await setup();
    const { dir } = fixture;
    const userDataDir = join(dir, 'profiles', 'orphan');
    const browser = await launchChromium({ userDataDir, headless: true });
    try {
      const found = findManagedChromiumProcesses(dir);
      expect(found.some((p) => p.pid === browser.pid)).toBe(true);
      expect(found.find((p) => p.pid === browser.pid)?.userDataDir).toBe(userDataDir);

      const killed = killOrphanBrowsers(dir, new Set());
      expect(killed).toBeGreaterThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(pidAlive(browser.pid)).toBe(false);
    } finally {
      killBrowserGroup(browser.pid, 'SIGKILL');
    }
  }, 60_000);

  it('respects the keep set when killing orphans', async () => {
    fixture = await setup();
    const { dir } = fixture;
    const userDataDir = join(dir, 'profiles', 'kept');
    const browser = await launchChromium({ userDataDir, headless: true });
    try {
      const killed = killOrphanBrowsers(dir, new Set([userDataDir]));
      expect(killed).toBe(0);
      expect(pidAlive(browser.pid)).toBe(true);
    } finally {
      killBrowserGroup(browser.pid, 'SIGKILL');
    }
  }, 60_000);

  it('ignores Chromium processes outside the data dir', async () => {
    fixture = await setup();
    const { dir } = fixture;
    const outside = mkdtempSync(join(tmpdir(), 'multiloger-outside-'));
    const browser = await launchChromium({ userDataDir: join(outside, 'p'), headless: true });
    try {
      const found = findManagedChromiumProcesses(dir);
      expect(found.some((p) => p.pid === browser.pid)).toBe(false);
      const killed = killOrphanBrowsers(dir, new Set());
      expect(pidAlive(browser.pid)).toBe(true);
      expect(killed).toBe(0);
    } finally {
      killBrowserGroup(browser.pid, 'SIGKILL');
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
