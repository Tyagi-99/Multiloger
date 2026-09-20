/**
 * State machine enforcement point.
 *
 * `transitionState` is the ONLY sanctioned way to change a profile's
 * lifecycle state: it reads the current state and writes the new one inside
 * a single transaction, validates against the transition table, and emits a
 * domain event. Any other write path to `profiles.state` is a bug.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { assertTransition, parseProfileState, type ProfileState } from './states.js';
import { ProfileNotFoundError } from './lock.js';
import { profileEvents } from './events.js';

export async function getState(
  db: Kysely<DatabaseSchema>,
  profileId: string,
): Promise<ProfileState> {
  const row = await db
    .selectFrom('profiles')
    .select('state')
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (!row) {
    throw new ProfileNotFoundError(profileId);
  }
  return parseProfileState(row.state);
}

/**
 * Move a profile to `to`. Throws IllegalTransitionError for illegal moves
 * and ProfileNotFoundError for unknown ids. The transition is persisted and
 * a `profile.state-changed` event is emitted, atomically.
 */
export async function transitionState(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  to: ProfileState,
): Promise<ProfileState> {
  const now = new Date().toISOString();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('profiles')
      .select('state')
      .where('id', '=', profileId)
      .executeTakeFirst();
    if (!row) {
      throw new ProfileNotFoundError(profileId);
    }
    const from = parseProfileState(row.state);
    assertTransition(from, to);

    await trx
      .updateTable('profiles')
      .set({ state: to, updated_at: now })
      .where('id', '=', profileId)
      .execute();

    profileEvents.emit({ type: 'profile.state-changed', profileId, from, to, at: now });
    return to;
  });
}
