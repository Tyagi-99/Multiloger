/**
 * Team-member persistence (Phase 3).
 *
 * Pure database functions — HTTP mapping lives in team-routes.ts.
 * Passwords are always stored as scrypt hashes (see passwords.ts); this
 * module never sees a plaintext password except at creation.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { hashPassword } from './passwords.js';
import { ValidationError } from './router.js';

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}

export class RoleNotFoundError extends Error {
  constructor(public readonly roleId: string) {
    super(`Role not found: ${roleId}`);
    this.name = 'RoleNotFoundError';
  }
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
    throw new ValidationError('Field must be a valid email address: email');
  }
  return trimmed;
}

async function roleIdsOf(db: Kysely<DatabaseSchema>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_roles')
    .select('role_id')
    .where('user_id', '=', userId)
    .orderBy('role_id', 'asc')
    .execute();
  return rows.map((row) => row.role_id);
}

function toPublicUser(
  row: {
    id: string;
    name: string;
    email: string;
    disabled: number;
    created_at: string;
    updated_at: string;
  },
  roles: string[],
): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    disabled: row.disabled === 1,
    roles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertRolesExist(db: Kysely<DatabaseSchema>, roleIds: string[]): Promise<void> {
  for (const roleId of roleIds) {
    const role = await db
      .selectFrom('roles')
      .select('id')
      .where('id', '=', roleId)
      .executeTakeFirst();
    if (!role) {
      throw new RoleNotFoundError(roleId);
    }
  }
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  roleIds?: string[];
}

export async function createUser(
  db: Kysely<DatabaseSchema>,
  input: CreateUserInput,
): Promise<PublicUser> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new ValidationError('Field must be 1-200 characters: name');
  }
  const email = validateEmail(input.email);
  const roleIds = [...new Set(input.roleIds ?? [])];
  await assertRolesExist(db, roleIds);
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) {
    throw new ValidationError(`Email is already registered: ${email}`);
  }
  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('users')
      .values({
        id,
        name,
        email,
        password_hash: passwordHash,
        disabled: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const roleId of roleIds) {
      await trx
        .insertInto('user_roles')
        .values({ user_id: id, role_id: roleId, created_at: now })
        .execute();
    }
  });
  return toPublicUser(
    { id, name, email, disabled: 0, created_at: now, updated_at: now },
    [...roleIds].sort(),
  );
}

export async function getUser(db: Kysely<DatabaseSchema>, userId: string): Promise<PublicUser> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!row) {
    throw new UserNotFoundError(userId);
  }
  return toPublicUser(row, await roleIdsOf(db, userId));
}

export async function getUserByEmail(
  db: Kysely<DatabaseSchema>,
  email: string,
): Promise<PublicUser | null> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email.trim().toLowerCase())
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  return toPublicUser(row, await roleIdsOf(db, row.id));
}

export async function listUsers(db: Kysely<DatabaseSchema>): Promise<PublicUser[]> {
  const rows = await db.selectFrom('users').selectAll().orderBy('created_at', 'asc').execute();
  return Promise.all(rows.map(async (row) => toPublicUser(row, await roleIdsOf(db, row.id))));
}

export interface UpdateUserInput {
  name?: string;
  disabled?: boolean;
}

export async function updateUser(
  db: Kysely<DatabaseSchema>,
  userId: string,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!row) {
    throw new UserNotFoundError(userId);
  }
  const patch: { name?: string; disabled?: number; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 200) {
      throw new ValidationError('Field must be 1-200 characters: name');
    }
    patch.name = name;
  }
  if (input.disabled !== undefined) {
    patch.disabled = input.disabled ? 1 : 0;
  }
  await db.updateTable('users').set(patch).where('id', '=', userId).execute();
  return getUser(db, userId);
}

/**
 * Delete a user: drops role/client/profile grants and revokes (not
 * deletes) their tokens so the audit trail stays intact.
 */
export async function deleteUser(db: Kysely<DatabaseSchema>, userId: string): Promise<void> {
  const row = await db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
  if (!row) {
    throw new UserNotFoundError(userId);
  }
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('user_roles').where('user_id', '=', userId).execute();
    await trx.deleteFrom('user_clients').where('user_id', '=', userId).execute();
    await trx.deleteFrom('user_profiles').where('user_id', '=', userId).execute();
    await trx
      .updateTable('api_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    await trx.deleteFrom('users').where('id', '=', userId).execute();
  });
}

export async function addUserRole(
  db: Kysely<DatabaseSchema>,
  userId: string,
  roleId: string,
): Promise<PublicUser> {
  await getUser(db, userId);
  await assertRolesExist(db, [roleId]);
  await db
    .insertInto('user_roles')
    .values({ user_id: userId, role_id: roleId, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return getUser(db, userId);
}

export async function removeUserRole(
  db: Kysely<DatabaseSchema>,
  userId: string,
  roleId: string,
): Promise<PublicUser> {
  await getUser(db, userId);
  await db
    .deleteFrom('user_roles')
    .where('user_id', '=', userId)
    .where('role_id', '=', roleId)
    .execute();
  return getUser(db, userId);
}

/** Number of users holding the admin role — guards the last-admin rule. */
export async function countAdmins(db: Kysely<DatabaseSchema>): Promise<number> {
  const row = await db
    .selectFrom('user_roles')
    .select((eb) => eb.fn.countAll().as('total'))
    .where('role_id', '=', 'admin')
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

export async function userHasRole(
  db: Kysely<DatabaseSchema>,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('user_roles')
    .select('role_id')
    .where('user_id', '=', userId)
    .where('role_id', '=', roleId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Stored password hash (for login verification). Null when the user is gone. */
export async function getUserPasswordHash(
  db: Kysely<DatabaseSchema>,
  userId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('password_hash')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.password_hash ?? null;
}

/** Replace a user's password (policy-validated; hash only, never plaintext). */
export async function setUserPassword(
  db: Kysely<DatabaseSchema>,
  userId: string,
  password: string,
): Promise<void> {
  await getUser(db, userId);
  const passwordHash = await hashPassword(password);
  await db
    .updateTable('users')
    .set({ password_hash: passwordHash, updated_at: new Date().toISOString() })
    .where('id', '=', userId)
    .execute();
}

// ---------------------------------------------------------------- scoping

async function assertClientExists(db: Kysely<DatabaseSchema>, clientId: string): Promise<void> {
  const row = await db
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!row) {
    throw new ValidationError(`Unknown client: ${clientId}`);
  }
}

async function assertProfileExists(db: Kysely<DatabaseSchema>, profileId: string): Promise<void> {
  const row = await db
    .selectFrom('profiles')
    .select('id')
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (!row) {
    throw new ValidationError(`Unknown profile: ${profileId}`);
  }
}

export async function grantClientAccess(
  db: Kysely<DatabaseSchema>,
  userId: string,
  clientId: string,
): Promise<void> {
  await getUser(db, userId);
  await assertClientExists(db, clientId);
  await db
    .insertInto('user_clients')
    .values({ user_id: userId, client_id: clientId, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function revokeClientAccess(
  db: Kysely<DatabaseSchema>,
  userId: string,
  clientId: string,
): Promise<void> {
  await getUser(db, userId);
  await db
    .deleteFrom('user_clients')
    .where('user_id', '=', userId)
    .where('client_id', '=', clientId)
    .execute();
}

export async function grantProfileAccess(
  db: Kysely<DatabaseSchema>,
  userId: string,
  profileId: string,
): Promise<void> {
  await getUser(db, userId);
  await assertProfileExists(db, profileId);
  await db
    .insertInto('user_profiles')
    .values({ user_id: userId, profile_id: profileId, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function revokeProfileAccess(
  db: Kysely<DatabaseSchema>,
  userId: string,
  profileId: string,
): Promise<void> {
  await getUser(db, userId);
  await db
    .deleteFrom('user_profiles')
    .where('user_id', '=', userId)
    .where('profile_id', '=', profileId)
    .execute();
}

export interface UserScopes {
  clients: string[];
  profiles: string[];
}

export async function getUserScopes(
  db: Kysely<DatabaseSchema>,
  userId: string,
): Promise<UserScopes> {
  await getUser(db, userId);
  const clients = await db
    .selectFrom('user_clients')
    .select('client_id')
    .where('user_id', '=', userId)
    .execute();
  const profiles = await db
    .selectFrom('user_profiles')
    .select('profile_id')
    .where('user_id', '=', userId)
    .execute();
  return {
    clients: clients.map((row) => row.client_id),
    profiles: profiles.map((row) => row.profile_id),
  };
}

// ---------------------------------------------------------------- roles

export interface PublicRole {
  id: string;
  name: string;
  description: string | null;
  seeded: boolean;
  permissions: string[];
  createdAt: string;
}

export async function listRoles(db: Kysely<DatabaseSchema>): Promise<PublicRole[]> {
  const rows = await db.selectFrom('roles').selectAll().orderBy('name', 'asc').execute();
  return Promise.all(
    rows.map(async (row) => {
      const perms = await db
        .selectFrom('role_permissions')
        .select('permission_id')
        .where('role_id', '=', row.id)
        .orderBy('permission_id', 'asc')
        .execute();
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        seeded: row.seeded === 1,
        permissions: perms.map((p) => p.permission_id),
        createdAt: row.created_at,
      };
    }),
  );
}

export async function createRole(
  db: Kysely<DatabaseSchema>,
  input: { name: string; description?: string; permissionKeys?: string[] },
): Promise<PublicRole> {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,50}$/.test(name)) {
    throw new ValidationError('Role name must be 1-50 chars: lowercase letters, digits, dashes');
  }
  const permissionKeys = [...new Set(input.permissionKeys ?? [])];
  const known = await db.selectFrom('permissions').select('id').execute();
  const knownIds = new Set(known.map((row) => row.id));
  for (const key of permissionKeys) {
    if (!knownIds.has(key)) {
      throw new ValidationError(`Unknown permission key: ${key}`);
    }
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('roles')
      .values({
        id,
        name,
        description: input.description?.trim() ?? null,
        seeded: 0,
        created_at: now,
      })
      .execute();
    for (const key of permissionKeys) {
      await trx
        .insertInto('role_permissions')
        .values({ role_id: id, permission_id: key })
        .execute();
    }
  });
  const roles = await listRoles(db);
  const created = roles.find((r) => r.id === id);
  if (!created) {
    throw new Error('Role creation failed unexpectedly');
  }
  return created;
}

export async function deleteRole(db: Kysely<DatabaseSchema>, roleId: string): Promise<void> {
  const row = await db.selectFrom('roles').selectAll().where('id', '=', roleId).executeTakeFirst();
  if (!row) {
    throw new RoleNotFoundError(roleId);
  }
  if (row.seeded === 1) {
    throw new ValidationError('Seeded roles (admin/operator/viewer) cannot be deleted');
  }
  const assigned = await db
    .selectFrom('user_roles')
    .select('user_id')
    .where('role_id', '=', roleId)
    .limit(1)
    .executeTakeFirst();
  if (assigned) {
    throw new ValidationError('Role is still assigned to users; unassign it first');
  }
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
    await trx.deleteFrom('roles').where('id', '=', roleId).execute();
  });
}
