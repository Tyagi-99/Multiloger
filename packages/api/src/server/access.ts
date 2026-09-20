/**
 * RBAC identity resolution and enforcement (Phase 3).
 *
 * Identity kinds:
 * - 'legacy': a token with no user_id — grandfathered from before Phase 3.
 *   Full access to everything, exactly like before. The bootstrap token is
 *   always legacy, so existing single-token setups keep working unchanged.
 * - 'user': a token attributed to a team member. Permissions are the union
 *   of the user's roles, narrowed by the token's scopes when set. Non-admin
 *   users are additionally restricted to their client/profile scopes.
 *
 * Enforcement helpers throw ForbiddenError (→ 403) or IdentityRejectedError
 * (→ 401 for disabled/deleted users); errors.ts maps them to HTTP.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema, ApiTokensTable } from '../db/schema.js';
import { getProfile } from '../profiles/repository.js';

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The token's user is disabled or no longer exists — authentication fails. */
export class IdentityRejectedError extends Error {
  constructor(message = 'Identity rejected') {
    super(message);
    this.name = 'IdentityRejectedError';
  }
}

export interface Identity {
  kind: 'legacy' | 'user';
  tokenId: string;
  /** Null for legacy tokens. */
  userId: string | null;
  isAdmin: boolean;
  /** Effective permission keys. Empty + legacy=true means "everything". */
  permissions: Set<string>;
  legacy: boolean;
}

function parseScopes(scopes: string | null): string[] | null {
  if (scopes === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(scopes);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return null;
  }
}

/**
 * Resolve the caller's identity from an authenticated token row.
 * Throws IdentityRejectedError when the token's user is disabled/missing.
 */
export async function resolveIdentity(
  db: Kysely<DatabaseSchema>,
  token: ApiTokensTable,
): Promise<Identity> {
  if (token.user_id === null) {
    return {
      kind: 'legacy',
      tokenId: token.id,
      userId: null,
      isAdmin: true,
      permissions: new Set<string>(),
      legacy: true,
    };
  }

  const user = await db
    .selectFrom('users')
    .select(['id', 'disabled'])
    .where('id', '=', token.user_id)
    .executeTakeFirst();
  if (!user || user.disabled === 1) {
    // Disabled/deleted users fail closed: the token stops working.
    throw new IdentityRejectedError('User is disabled or no longer exists');
  }

  const roleRows = await db
    .selectFrom('user_roles')
    .select('role_id')
    .where('user_id', '=', user.id)
    .execute();
  const roleIds = roleRows.map((row) => row.role_id);
  const isAdmin = roleIds.includes('admin');

  let permissions = new Set<string>();
  if (roleIds.length > 0) {
    const permRows = await db
      .selectFrom('role_permissions')
      .select('permission_id')
      .where('role_id', 'in', roleIds)
      .execute();
    permissions = new Set(permRows.map((row) => row.permission_id));
  }

  const scopes = parseScopes(token.scopes);
  if (scopes !== null) {
    const narrowed = new Set<string>();
    for (const scope of scopes) {
      if (permissions.has(scope)) {
        narrowed.add(scope);
      }
    }
    permissions = narrowed;
  }

  return {
    kind: 'user',
    tokenId: token.id,
    userId: user.id,
    isAdmin,
    permissions,
    legacy: false,
  };
}

export function hasPermission(identity: Identity, permission: string): boolean {
  return identity.legacy || identity.permissions.has(permission);
}

/** The authenticated identity; throws when absent (a server bug → 500). */
export function requireIdentity(ctx: { identity: Identity | null }): Identity {
  const identity = ctx.identity;
  if (!identity) {
    throw new Error('Authenticated route has no identity');
  }
  return identity;
}

/** Throws ForbiddenError unless the identity holds the permission. */
export function requirePermission(identity: Identity, permission: string): void {
  if (!hasPermission(identity, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
}

/**
 * Client ids the identity may access, or null for "all" (legacy/admin).
 * Non-admin users without any scope row see nothing (deny by default).
 */
export async function accessibleClientIds(
  db: Kysely<DatabaseSchema>,
  identity: Identity,
): Promise<Set<string> | null> {
  if (identity.legacy || identity.isAdmin || identity.userId === null) {
    return null;
  }
  const rows = await db
    .selectFrom('user_clients')
    .select('client_id')
    .where('user_id', '=', identity.userId)
    .execute();
  return new Set(rows.map((row) => row.client_id));
}

/**
 * Profile ids the identity may access directly, or null for "all".
 * (Client-scoped access is checked separately via the profile's client.)
 */
export async function accessibleProfileIds(
  db: Kysely<DatabaseSchema>,
  identity: Identity,
): Promise<Set<string> | null> {
  if (identity.legacy || identity.isAdmin || identity.userId === null) {
    return null;
  }
  const rows = await db
    .selectFrom('user_profiles')
    .select('profile_id')
    .where('user_id', '=', identity.userId)
    .execute();
  return new Set(rows.map((row) => row.profile_id));
}

/** Throws ForbiddenError unless the identity may access the client. */
export async function assertClientAccess(
  db: Kysely<DatabaseSchema>,
  identity: Identity,
  clientId: string,
): Promise<void> {
  if (identity.legacy || identity.isAdmin) {
    return;
  }
  const allowed = await accessibleClientIds(db, identity);
  if (!allowed?.has(clientId)) {
    throw new ForbiddenError('Access denied to this client');
  }
}

/**
 * Throws ForbiddenError unless the identity may access the profile —
 * directly via user_profiles or via the profile's client. The profile must
 * exist first (404), so denial never leaks existence of missing profiles.
 */
export async function assertProfileAccess(
  db: Kysely<DatabaseSchema>,
  identity: Identity,
  profileId: string,
): Promise<void> {
  if (identity.legacy || identity.isAdmin) {
    await getProfile(db, profileId); // still 404 when missing
    return;
  }
  const profile = await getProfile(db, profileId);
  const direct = await accessibleProfileIds(db, identity);
  if (direct?.has(profileId)) {
    return;
  }
  const clients = await accessibleClientIds(db, identity);
  if (clients?.has(profile.client_id)) {
    return;
  }
  throw new ForbiddenError('Access denied to this profile');
}

/**
 * Keep rows whose profile the identity may access — directly via
 * user_profiles or via the profile's client. Rows that reference deleted
 * profiles are hidden from scoped users (fail closed); legacy/admin see all.
 */
export async function filterByProfileScope<T>(
  db: Kysely<DatabaseSchema>,
  identity: Identity,
  rows: readonly T[],
  profileIdOf: (row: T) => string,
): Promise<T[]> {
  const direct = await accessibleProfileIds(db, identity);
  const clients = await accessibleClientIds(db, identity);
  if (direct === null && clients === null) {
    return [...rows];
  }
  const profileRows = await db.selectFrom('profiles').select(['id', 'client_id']).execute();
  const clientOf = new Map(profileRows.map((p) => [p.id, p.client_id] as const));
  return rows.filter((row) => {
    const pid = profileIdOf(row);
    if (direct?.has(pid)) {
      return true;
    }
    const cid = clientOf.get(pid);
    return clients !== null && cid !== undefined && clients.has(cid);
  });
}
