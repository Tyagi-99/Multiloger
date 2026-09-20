/**
 * Task 8 tests: FIFO launch queue, disk watermark, idle shutdown,
 * manager integration (live Chromium), and HTTP 503 mappings.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { getState } from '../profiles/stateMachine.js';
import { ProfileManager } from '../profiles/manager.js';
import { pingCdp } from '../browser/launcher.js';
import { profileEvents, type ProfileDomainEvent } from '../profiles/events.js';
import {
  assertDiskWatermark,
  InsufficientDiskSpaceError,
  nearestExistingAncestor,
  parseDfOutput,
} from './disk.js';
import {
  DEFAULT_MAX_CONCURRENT,
  ResourceManager,
} from './manager.js';
import { LaunchQueue, LaunchQueueTimeoutError } from './queue.js';
import { toHttpError } from '../server/errors.js';

// ---------------------------------------------------------------- helpers

function collectEvents(): { events: ProfileDomainEvent[]; stop: () => void } {
  const events: ProfileDomainEvent[] = [];
  const stop = profileEvents.on((event) => {
    events.push(event);
  });
  return { events, stop };
}

function ofType(events: ProfileDomainEvent[], type: ProfileDomainEvent['type']): ProfileDomainEvent[] {
  return events.filter((event) => event.type === type);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- LaunchQueue

describe('LaunchQueue', () => {
  it('is FIFO: the head is dequeued first', () => {
    const queue = new LaunchQueue(1000);
    // Keep every waiter handled: clear() below rejects the leftover.
    void queue.enqueue('a').catch(() => undefined);
    void queue.enqueue('b').catch(() => undefined);
    void queue.enqueue('c').catch(() => undefined);
    expect(queue.queuedIds()).toEqual(['a', 'b', 'c']);
    expect(queue.positionOf('b')).toBe(2);
    expect(queue.positionOf('missing')).toBe(0);
    expect(queue.dequeue()?.profileId).toBe('a');
    expect(queue.dequeue()?.profileId).toBe('b');
    expect(queue.length).toBe(1);
    queue.clear(new Error('closed'));
    expect(queue.length).toBe(0);
  });

  it('re-enqueueing the same id returns the original waiter', async () => {
    const queue = new LaunchQueue(1000);
    const first = queue.enqueue('a');
    const second = queue.enqueue('a');
    expect(queue.length).toBe(1);
    queue.dequeue()?.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('times out with LaunchQueueTimeoutError and removes the waiter', async () => {
    const queue = new LaunchQueue(80);
    const events: string[] = [];
    const pending = queue
      .enqueue('a')
      .then(
        () => events.push('resolved'),
        (error: unknown) => events.push((error as Error).name),
      );
    await pending;
    expect(events).toEqual(['LaunchQueueTimeoutError']);
    expect(queue.length).toBe(0);
    expect(queue.positionOf('a')).toBe(0);
  });

  it('clear() rejects every waiter', async () => {
    const queue = new LaunchQueue(5000);
    const pending = queue.enqueue('a');
    queue.clear(new Error('shutting down'));
    await expect(pending).rejects.toThrow('shutting down');
  });
});

// ---------------------------------------------------------------- disk

describe('parseDfOutput', () => {
  const sample = `Filesystem     1K-blocks     Used Available Use% Mounted on
overlay        104857600    12345 104845255   1% /
`;

  it('parses free and total bytes from df -k output', () => {
    const space = parseDfOutput(sample);
    expect(space.freeBytes).toBe(104845255 * 1024);
    expect(space.totalBytes).toBe(104857600 * 1024);
  });

  it('throws on garbage, header-only, and negative numbers', () => {
    expect(() => parseDfOutput('not df output at all')).toThrow();
    expect(() => parseDfOutput('Filesystem 1K-blocks Used Available Use% Mounted on\n')).toThrow();
    expect(() => parseDfOutput('')).toThrow();
    expect(() =>
      parseDfOutput('Filesystem 1K-blocks Used Available Use% Mounted on\noverlay -1 0 -5 1% /\n'),
    ).toThrow();
  });
});

describe('nearestExistingAncestor', () => {
  it('returns the path itself when it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-anc-'));
    try {
      expect(nearestExistingAncestor(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks up past missing segments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-anc-'));
    try {
      expect(nearestExistingAncestor(join(dir, 'nope', 'deeper'))).toBe(dir);
      expect(nearestExistingAncestor('/definitely-not-here-xyz')).toBe('/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertDiskWatermark', () => {
  it('is a no-op when the watermark is disabled', async () => {
    await expect(assertDiskWatermark('/nonexistent-path-xyz', 0)).resolves.toBeUndefined();
  });

  it('measures the nearest existing ancestor for not-yet-created dirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-disk-'));
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const nested = join(dir, 'not-created-yet', 'deeper');
      // No fail-open warning: the ancestor's real free space is measured.
      await expect(assertDiskWatermark(nested, 1)).resolves.toBeUndefined();
      expect(warnings).toEqual([]);
      await expect(assertDiskWatermark(nested, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
        InsufficientDiskSpaceError,
      );
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open with a warning when df cannot run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-disk-'));
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    const originalPath = process.env.PATH;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    process.env.PATH = '/nonexistent-bin-dir-multiloger';
    try {
      // 'df' is unresolvable -> fail-open.
      await expect(assertDiskWatermark(dir, 1024)).resolves.toBeUndefined();
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws InsufficientDiskSpaceError when free space is below the watermark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-disk-'));
    try {
      await expect(assertDiskWatermark(dir, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
        InsufficientDiskSpaceError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- ResourceManager

describe('ResourceManager slots', () => {
  it('rejects a non-positive cap', () => {
    expect(() => new ResourceManager({ dataDir: tmpdir(), maxConcurrent: 0 })).toThrow();
  });

  it('admits up to the cap immediately and queues the rest FIFO', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      queueTimeoutMs: 5000,
      checkDiskBeforeLaunch: false,
    });
    const { events, stop } = collectEvents();
    try {
      await resources.acquire('a');
      const bPending = resources.acquire('b');
      const cPending = resources.acquire('c');
      await waitFor(() => resources.status.queued.length === 2, 2000, 'b and c to queue');
      expect(resources.status).toMatchObject({ running: 1, queued: ['b', 'c'] });

      const queued = ofType(events, 'profile.launch-queued');
      expect(queued.map((event) => (event as { profileId: string }).profileId)).toEqual(['b', 'c']);
      expect((queued[0] as { position: number }).position).toBe(1);
      expect((queued[1] as { position: number }).position).toBe(2);

      resources.release('a');
      await bPending;
      expect(resources.status).toMatchObject({ running: 1, queued: ['c'] });

      resources.release('b');
      await cPending;
      expect(resources.status).toMatchObject({ running: 1, queued: [] });

      const admitted = ofType(events, 'profile.launch-admitted');
      expect(admitted).toHaveLength(2);
      expect(typeof (admitted[0] as { waitedMs: number }).waitedMs).toBe('number');

      resources.release('c');
      expect(resources.status.running).toBe(0);
    } finally {
      stop();
      resources.close();
    }
  });

  it('a freed slot transfers to the queue head and cannot be stolen', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      queueTimeoutMs: 5000,
      checkDiskBeforeLaunch: false,
    });
    try {
      await resources.acquire('a');
      const bPending = resources.acquire('b');
      await waitFor(() => resources.status.queued.length === 1, 2000, 'b to queue');
      // A fresh acquire must queue behind b even though a release is imminent.
      const dPending = resources.acquire('d');
      await waitFor(() => resources.status.queued.length === 2, 2000, 'd to queue');
      expect(resources.status.queued).toEqual(['b', 'd']);

      resources.release('a');
      await bPending;
      expect(resources.status.queued).toEqual(['d']);

      resources.release('b');
      await dPending;
      resources.release('d');
      expect(resources.status.running).toBe(0);
    } finally {
      resources.close();
    }
  });

  it('acquire is idempotent and release of an unknown id is a no-op', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      checkDiskBeforeLaunch: false,
    });
    try {
      await resources.acquire('a');
      await resources.acquire('a');
      expect(resources.status.running).toBe(1);
      resources.release('nope');
      expect(resources.status.running).toBe(1);
      resources.release('a');
      expect(resources.status.running).toBe(0);
    } finally {
      resources.close();
    }
  });

  it('queue timeout rejects with LaunchQueueTimeoutError and emits an event', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      queueTimeoutMs: 120,
      checkDiskBeforeLaunch: false,
    });
    const { events, stop } = collectEvents();
    try {
      await resources.acquire('a');
      await expect(resources.acquire('b')).rejects.toThrow(LaunchQueueTimeoutError);
      expect(resources.status).toMatchObject({ running: 1, queued: [] });
      const timeouts = ofType(events, 'profile.launch-queue-timeout');
      expect(timeouts).toHaveLength(1);
      expect((timeouts[0] as { timeoutMs: number }).timeoutMs).toBe(120);
      resources.release('a');
    } finally {
      stop();
      resources.close();
    }
  });

  it('disk watermark failure refuses the launch before queueing', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
    });
    try {
      await expect(resources.acquire('a')).rejects.toThrow(InsufficientDiskSpaceError);
      expect(resources.status).toMatchObject({ running: 0, queued: [] });
    } finally {
      resources.close();
    }
  });

  it('close() rejects queued waiters and refuses new acquires', async () => {
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      maxConcurrent: 1,
      queueTimeoutMs: 5000,
      checkDiskBeforeLaunch: false,
    });
    try {
      await resources.acquire('a');
      const pending = resources.acquire('b');
      await waitFor(() => resources.status.queued.length === 1, 2000, 'b to queue');
      resources.close();
      await expect(pending).rejects.toThrow('ResourceManager is closed');
      await expect(resources.acquire('c')).rejects.toThrow('ResourceManager is closed');
    } finally {
      resources.close();
    }
  });
});

describe('ResourceManager idle shutdown', () => {
  it('is disabled by default (no timer, no callback)', async () => {
    let calls = 0;
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      checkDiskBeforeLaunch: false,
      onIdleProfile: () => {
        calls += 1;
      },
    });
    try {
      await resources.acquire('a');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls).toBe(0);
      expect(resources.status.idleShutdownMs).toBe(0);
      resources.release('a');
    } finally {
      resources.close();
    }
  });

  it('calls onIdleProfile after the idle period and skips released profiles', async () => {
    const seen: { profileId: string; idleMs: number }[] = [];
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      checkDiskBeforeLaunch: false,
      idleShutdownMs: 100,
      onIdleProfile: (profileId, idleMs) => {
        seen.push({ profileId, idleMs });
      },
    });
    try {
      await resources.acquire('a');
      await resources.acquire('b');
      resources.release('b'); // released before the first tick: must be skipped
      await waitFor(() => seen.length >= 1, 3000, 'idle callback for a');
      expect(seen[0]?.profileId).toBe('a');
      expect(seen[0]?.idleMs).toBeGreaterThanOrEqual(100);
      expect(seen.every((call) => call.profileId !== 'b')).toBe(true);
      resources.release('a');
    } finally {
      resources.close();
    }
  });

  it('noteActivity resets the idle clock', async () => {
    const seen: string[] = [];
    const resources = new ResourceManager({
      dataDir: tmpdir(),
      checkDiskBeforeLaunch: false,
      idleShutdownMs: 100,
      onIdleProfile: (profileId) => {
        seen.push(profileId);
      },
    });
    try {
      await resources.acquire('a');
      // Keep touching before each 1s reaper tick; idle must never reach 100ms*10.
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        resources.noteActivity('a');
      }
      expect(seen).toEqual([]);
      resources.release('a');
    } finally {
      resources.close();
    }
  });
});

// ---------------------------------------------------------------- HTTP mappings

describe('resource error HTTP mappings', () => {
  it('queue timeout and disk shortage map to 503', () => {
    const timeout = toHttpError(new LaunchQueueTimeoutError('p1', 500));
    expect(timeout.status).toBe(503);
    expect(timeout.body.error.code).toBe('LAUNCH_QUEUE_TIMEOUT');

    const disk = toHttpError(new InsufficientDiskSpaceError(10, 20));
    expect(disk.status).toBe(503);
    expect(disk.body.error.code).toBe('INSUFFICIENT_DISK_SPACE');
  });
});

// ---------------------------------------------------------------- manager integration

interface ManagerFixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  manager: ProfileManager;
  resources: ResourceManager;
  profileA: string;
  profileB: string;
}

async function setupManager(options?: {
  maxConcurrent?: number;
  queueTimeoutMs?: number;
}): Promise<ManagerFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-res-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const client = await createClient(db, { name: 'Acme' });
  const profileA = await createProfile(db, {
    clientId: client.id,
    name: 'a',
    userDataDir: join(dir, 'profiles', 'a'),
  });
  const profileB = await createProfile(db, {
    clientId: client.id,
    name: 'b',
    userDataDir: join(dir, 'profiles', 'b'),
  });
  const resources = new ResourceManager({
    dataDir: dir,
    maxConcurrent: options?.maxConcurrent ?? 1,
    queueTimeoutMs: options?.queueTimeoutMs ?? 15_000,
    // Queue mechanics are under test here, not the watermark (unit-tested
    // above); the tmpfs tmpdir on CI VMs is often below the 1 GiB default.
    checkDiskBeforeLaunch: false,
  });
  const manager = new ProfileManager(db, { dataDir: dir, lockTtlMs: 3000, resources });
  manager.start();
  return { dir, db, manager, resources, profileA: profileA.id, profileB: profileB.id };
}

describe('ProfileManager + ResourceManager (live Chromium)', () => {
  let fixture: ManagerFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      fixture.resources.close();
      await fixture.manager.shutdown();
      await closeDatabase(fixture.db);
      rmSync(fixture.dir, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  it('queues the second launch at cap=1, admits it when the first stops', async () => {
    fixture = await setupManager();
    const { db, manager, resources, profileA, profileB } = fixture;
    const { events, stop } = collectEvents();
    try {
      await manager.launchProfile(profileA);
      expect(await getState(db, profileA)).toBe('running');

      let bLaunched = false;
      const bLaunch = manager.launchProfile(profileB).then((result) => {
        bLaunched = true;
        return result;
      });
      await waitFor(
        () => ofType(events, 'profile.launch-queued').length === 1,
        5000,
        'launch-queued event for B',
      );
      expect(resources.status).toMatchObject({ running: 1, queued: [profileB] });
      expect(bLaunched).toBe(false);

      const queued = ofType(events, 'profile.launch-queued')[0] as unknown as {
        position: number;
      };
      expect(queued.position).toBe(1);

      await manager.stopProfile(profileA);
      const launched = await bLaunch;
      expect(bLaunched).toBe(true);
      expect(await getState(db, profileB)).toBe('running');
      expect(await pingCdp(launched.cdpUrl, 3000)).toBe(true);
      expect(resources.status).toMatchObject({ running: 1, queued: [] });

      const admitted = ofType(events, 'profile.launch-admitted');
      expect(admitted).toHaveLength(1);

      await manager.stopProfile(profileB);
      expect(resources.status.running).toBe(0);
    } finally {
      stop();
    }
  });

  it('queue timeout fails the launch without leaking the slot', async () => {
    fixture = await setupManager({ queueTimeoutMs: 600 });
    const { db, manager, resources, profileA, profileB } = fixture;
    const { events, stop } = collectEvents();
    try {
      await manager.launchProfile(profileA);
      await expect(manager.launchProfile(profileB)).rejects.toThrow(LaunchQueueTimeoutError);
      // B never got past admission: state untouched, slot not leaked.
      expect(await getState(db, profileB)).toBe('created');
      expect(resources.status).toMatchObject({ running: 1, queued: [] });
      expect(ofType(events, 'profile.launch-queue-timeout')).toHaveLength(1);

      await manager.stopProfile(profileA);
      expect(resources.status.running).toBe(0);
    } finally {
      stop();
    }
  });

  it('a failed launch releases its slot', async () => {
    fixture = await setupManager({ maxConcurrent: 2 });
    const { manager, resources } = fixture;
    await expect(manager.launchProfile('nonexistent-profile')).rejects.toThrow();
    expect(resources.status).toMatchObject({ running: 0, queued: [] });
  });

  it('stopping a crashed profile releases its slot for the queue', async () => {
    fixture = await setupManager();
    const { db, manager, resources, profileA, profileB } = fixture;
    try {
      const launched = await manager.launchProfile(profileA);
      // Simulate a crash: kill the browser out from under the manager.
      const { killBrowserGroup } = await import('../browser/launcher.js');
      killBrowserGroup(launched.pid, 'SIGKILL');
      await waitFor(() => getState(db, profileA).then((s) => s === 'crashed'), 8000, 'crash');
      expect(resources.status.running).toBe(0);

      const relaunched = await manager.launchProfile(profileB);
      expect(await getState(db, profileB)).toBe('running');
      await manager.stopProfile(profileB);
      expect(relaunched.pid).toBeGreaterThan(0);
    } finally {
      // nothing extra
    }
  });
});

describe('ResourceManager defaults', () => {
  it('defaults to a conservative cap', () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
  });
});
