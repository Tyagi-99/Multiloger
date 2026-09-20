/**
 * Minimal profile/client repository. The API layer (Task 7) builds on this;
 * the state machine and lock modules stay persistence-agnostic apart from
 * the `profiles` table shape.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, ProfilesTable } from '../db/schema.js';
import { ProfileNotFoundError } from './lock.js';

export interface CreateProfileInput {
  clientId: string;
  name: string;
  userDataDir: string;
}

export async function createProfile(
  db: Kysely<DatabaseSchema>,
  input: CreateProfileInput,
): Promise<ProfilesTable> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto('profiles')
    .values({
      id,
      client_id: input.clientId,
      name: input.name,
      state: 'created',
      locked_by: null,
      locked_at: null,
      user_data_dir: input.userDataDir,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return getProfile(db, id);
}

export async function getProfile(
  db: Kysely<DatabaseSchema>,
  profileId: string,
): Promise<ProfilesTable> {
  const row = await db
    .selectFrom('profiles')
    .selectAll()
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (!row) {
    throw new ProfileNotFoundError(profileId);
  }
  return row;
}

export async function listProfiles(db: Kysely<DatabaseSchema>): Promise<ProfilesTable[]> {
  return db.selectFrom('profiles').selectAll().orderBy('created_at', 'asc').execute();
}

export interface CreateClientInput {
  name: string;
  notes?: string;
}

export async function createClient(
  db: Kysely<DatabaseSchema>,
  input: CreateClientInput,
): Promise<{ id: string; name: string }> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto('clients')
    .values({
      id,
      name: input.name,
      notes: input.notes ?? null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { id, name: input.name };
}
