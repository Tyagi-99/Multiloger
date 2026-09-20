/**
 * Single-owner profile locking, stored in the DB row (`locked_by`,
 * `locked_at`) so locks survive server restarts.
 *
 * - `acquireLock` is ONE atomic UPDATE: it succeeds only when the profile is
 *   unlocked or the existing lock is older than `ttlMs` (stale). Two
 *   concurrent acquirers → exactly one wins, decided by SQLite.
 * - `heartbeat` refreshes `locked_at`; long operations must call it
 *   periodically so their lock is not reaped as stale.
 * - `reapStaleLocks` clears locks older than the TTL (used at boot and by
 *   the crash reaper).
 *
 * Staleness compares ISO-8601 UTC strings lexicographically, which is
 * correct because `toISOString()` is zero-padded and monotonic in UTC.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { profileEvents } from './events.js';

export class ProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Profile not found: ${profileId}`);
    this.name = 'ProfileNotFoundError';
  }
}

/** Opaque owner token identifying whoever holds a lock. */
export function newOwnerToken(): string {
  return randomUUID();
}

function cutoffIso(ttlMs: number): string {
  return new Date(Date.now() - ttlMs).toISOString();
}

/**
 * Try to take the lock. Returns true when this owner now holds it.
 * Steals the lock when the previous holder's `locked_at` is older than ttlMs.
 */
export async function acquireLock(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .updateTable('profiles')
    .set({ locked_by: owner, locked_at: now, updated_at: now })
    .where('id', '=', profileId)
    .where((eb) =>
      eb.or([
        eb('locked_by', 'is', null),
        eb('locked_at', 'is', null),
        eb('locked_at', '<', cutoffIso(ttlMs)),
      ]),
    )
    .executeTakeFirst();

  const acquired = result.numUpdatedRows > 0n;
  if (acquired) {
    profileEvents.emit({ type: 'profile.lock-acquired', profileId, owner, at: now });
  }
  return acquired;
}

/** Release the lock; only the owning token can release it. */
export async function releaseLock(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  owner: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .updateTable('profiles')
    .set({ locked_by: null, locked_at: null, updated_at: now })
    .where('id', '=', profileId)
    .where('locked_by', '=', owner)
    .executeTakeFirst();

  const released = result.numUpdatedRows > 0n;
  if (released) {
    profileEvents.emit({ type: 'profile.lock-released', profileId, owner, at: now });
  }
  return released;
}

/** Refresh `locked_at`; returns false when this owner does not hold the lock. */
export async function heartbeatLock(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  owner: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .updateTable('profiles')
    .set({ locked_at: now, updated_at: now })
    .where('id', '=', profileId)
    .where('locked_by', '=', owner)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Clear every lock older than ttlMs. Returns the number of locks reaped. */
export async function reapStaleLocks(db: Kysely<DatabaseSchema>, ttlMs: number): Promise<number> {
  const now = new Date().toISOString();
  const result = await db
    .updateTable('profiles')
    .set({ locked_by: null, locked_at: null, updated_at: now })
    .where('locked_by', 'is not', null)
    .where('locked_at', '<', cutoffIso(ttlMs))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export interface LockInfo {
  owner: string | null;
  lockedAt: string | null;
  /** True when a lock is held AND younger than ttlMs. */
  active: boolean;
}

export async function getLockInfo(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  ttlMs: number,
): Promise<LockInfo> {
  const row = await db
    .selectFrom('profiles')
    .select(['locked_by', 'locked_at'])
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (!row) {
    throw new ProfileNotFoundError(profileId);
  }
  const active =
    row.locked_by !== null && row.locked_at !== null && row.locked_at >= cutoffIso(ttlMs);
  return { owner: row.locked_by, lockedAt: row.locked_at, active };
}
