/**
 * Minimal profile/client repository. The API layer (Task 7) builds on this;
 * the state machine and lock modules stay persistence-agnostic apart from
 * the `profiles` table shape.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
      proxy_required: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return getProfile(db, id);
}

/** Create a profile whose user-data dir is `join(dataDir, <new id>)`. */
export async function createProfileIn(
  db: Kysely<DatabaseSchema>,
  dataDir: string,
  input: { clientId: string; name: string; proxyRequired?: boolean },
): Promise<ProfilesTable> {
  const trimmed = input.name.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new Error('Profile name must be 1-200 characters');
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto('profiles')
    .values({
      id,
      client_id: input.clientId,
      name: trimmed,
      state: 'created',
      locked_by: null,
      locked_at: null,
      user_data_dir: join(dataDir, id),
      proxy_required: input.proxyRequired === true ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return getProfile(db, id);
}

export interface UpdateProfileInput {
  name?: string;
  proxyRequired?: boolean;
}

/** Update mutable profile fields. Throws ProfileNotFoundError when missing. */
export async function updateProfile(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  input: UpdateProfileInput,
): Promise<ProfilesTable> {
  await getProfile(db, profileId);
  const patch: Partial<ProfilesTable> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new Error('Profile name must be 1-200 characters');
    }
    patch.name = trimmed;
  }
  if (input.proxyRequired !== undefined) {
    patch.proxy_required = input.proxyRequired ? 1 : 0;
  }
  await db.updateTable('profiles').set(patch).where('id', '=', profileId).execute();
  return getProfile(db, profileId);
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

export class ClientNotFoundError extends Error {
  constructor(public readonly clientId: string) {
    super(`Client not found: ${clientId}`);
    this.name = 'ClientNotFoundError';
  }
}

export async function listClients(
  db: Kysely<DatabaseSchema>,
): Promise<{ id: string; name: string; notes: string | null; created_at: string }[]> {
  return db
    .selectFrom('clients')
    .select(['id', 'name', 'notes', 'created_at'])
    .orderBy('created_at', 'asc')
    .execute();
}

export async function getClient(
  db: Kysely<DatabaseSchema>,
  clientId: string,
): Promise<{ id: string; name: string; notes: string | null; created_at: string }> {
  const row = await db
    .selectFrom('clients')
    .select(['id', 'name', 'notes', 'created_at'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!row) {
    throw new ClientNotFoundError(clientId);
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
