/**
 * Session history: one row per profile launch. Records when a profile was
 * launched, with what PID/CDP port, and how the session ended — the basis
 * for "last used" displays and crash forensics.
 */

import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DatabaseSchema } from '../db/schema.js';

export type SessionExitReason = 'stopped' | 'crashed' | 'error';

export interface SessionRecord {
  id: string;
  profile_id: string;
  started_at: string;
  ended_at: string | null;
  exit_reason: SessionExitReason | null;
  pid: number | null;
  cdp_port: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Insert a session row when a profile launch succeeds. */
export async function startSession(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  pid: number,
  cdpPort: number,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('sessions')
    .values({
      id,
      profile_id: profileId,
      started_at: nowIso(),
      ended_at: null,
      exit_reason: null,
      pid,
      cdp_port: cdpPort,
    })
    .execute();
  return id;
}

/** Close a session row when the browser stops or crashes. */
export async function endSession(
  db: Kysely<DatabaseSchema>,
  sessionId: string,
  exitReason: SessionExitReason,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ ended_at: nowIso(), exit_reason: exitReason })
    .where('id', '=', sessionId)
    .execute();
}

/** Fetch the most recent session for a profile, if any. */
export async function getLastSession(
  db: Kysely<DatabaseSchema>,
  profileId: string,
): Promise<SessionRecord | undefined> {
  const row = await db
    .selectFrom('sessions')
    .selectAll()
    .where('profile_id', '=', profileId)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    profile_id: row.profile_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    exit_reason: row.exit_reason as SessionExitReason | null,
    pid: row.pid,
    cdp_port: row.cdp_port,
  };
}
