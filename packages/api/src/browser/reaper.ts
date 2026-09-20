/**
 * Startup reaper: reconciles profile states left behind by a dead manager
 * and kills unmanaged Chromium processes.
 *
 * Runs once at API boot, before any new launch:
 *  1. Reap stale locks (TTL-based).
 *  2. For profiles stuck in launching/running/stopping: check the recorded
 *     PID. A live PID means an unmanaged browser survived the crash — kill
 *     its process group (no manager owns it, so keeping it running would
 *     violate the single-control-plane rule) and mark the profile crashed.
 *     A dead PID means the browser is gone — mark crashed (was launching or
 *     running) or stopped (was stopping).
 *  3. Kill any remaining Chromium process whose --user-data-dir sits under
 *     our data dir. At boot nothing is live, so all of them are orphans.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { killBrowserGroup } from './launcher.js';
import { pidAlive } from '../profiles/manager.js';
import { getState, transitionState } from '../profiles/stateMachine.js';
import { IllegalTransitionError } from '../profiles/states.js';
import { reapStaleLocks } from '../profiles/lock.js';

export interface ReconcileResult {
  staleLocksReaped: number;
  markedCrashed: string[];
  markedStopped: string[];
  orphansKilled: number;
}

export interface FoundChromiumProcess {
  pid: number;
  userDataDir: string;
}

const USER_DATA_DIR_FLAG = '--user-data-dir=';

/**
 * Find Chromium processes via /proc (Linux). Returns every process whose
 * command line carries --user-data-dir=<dir> with <dir> under `dataDir`.
 * No external binaries needed; Linux-only by design (documented).
 */
export function findManagedChromiumProcesses(dataDir: string): FoundChromiumProcess[] {
  const root = resolve(dataDir);
  const found: FoundChromiumProcess[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // Process exited (or not ours to read) — skip.
    }
    const args = cmdline.split('\0');
    const flag = args.find((arg) => arg.startsWith(USER_DATA_DIR_FLAG));
    if (!flag) {
      continue;
    }
    const userDataDir = resolve(flag.slice(USER_DATA_DIR_FLAG.length));
    if (userDataDir === root || userDataDir.startsWith(`${root}/`)) {
      found.push({ pid, userDataDir });
    }
  }
  return found;
}

/**
 * Kill Chromium processes under `dataDir` whose user-data dir is not in
 * `keepUserDataDirs`. Returns the number of process groups killed.
 */
export function killOrphanBrowsers(dataDir: string, keepUserDataDirs: Set<string>): number {
  let killed = 0;
  for (const proc of findManagedChromiumProcesses(dataDir)) {
    if (keepUserDataDirs.has(proc.userDataDir)) {
      continue;
    }
    killBrowserGroup(proc.pid, 'SIGKILL');
    killed += 1;
  }
  return killed;
}

/** The reaper is the authority at boot: drop any lock, no TTL check. */
async function forceUnlock(db: Kysely<DatabaseSchema>, profileId: string): Promise<void> {
  await db
    .updateTable('profiles')
    .set({ locked_by: null, locked_at: null, last_pid: null, last_cdp_port: null })
    .where('id', '=', profileId)
    .execute();
}

async function settleStuckProfile(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  result: ReconcileResult,
): Promise<void> {
  const state = await getState(db, profileId);
  if (state !== 'launching' && state !== 'running' && state !== 'stopping') {
    return;
  }

  const row = await db
    .selectFrom('profiles')
    .select(['last_pid'])
    .where('id', '=', profileId)
    .executeTakeFirstOrThrow();
  const pid = row.last_pid;

  if (pid !== null && pidAlive(pid)) {
    // Unmanaged browser survived the crash — kill it; nobody owns it.
    killBrowserGroup(pid, 'SIGKILL');
  }

  // The browser is gone (or we just killed it): settle the state.
  try {
    if (state === 'stopping') {
      await transitionState(db, profileId, 'stopped');
      result.markedStopped.push(profileId);
    } else {
      await transitionState(db, profileId, 'crashed');
      result.markedCrashed.push(profileId);
    }
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
  }
  await forceUnlock(db, profileId);
}

export async function reconcileOnBoot(
  db: Kysely<DatabaseSchema>,
  dataDir: string,
  lockTtlMs: number,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    staleLocksReaped: 0,
    markedCrashed: [],
    markedStopped: [],
    orphansKilled: 0,
  };

  result.staleLocksReaped = await reapStaleLocks(db, lockTtlMs);

  const stuck = await db
    .selectFrom('profiles')
    .select(['id'])
    .where('state', 'in', ['launching', 'running', 'stopping'])
    .execute();
  for (const row of stuck) {
    await settleStuckProfile(db, row.id, result);
  }

  // Nothing is live at boot: every Chromium under dataDir is an orphan.
  result.orphansKilled = killOrphanBrowsers(dataDir, new Set());

  return result;
}
