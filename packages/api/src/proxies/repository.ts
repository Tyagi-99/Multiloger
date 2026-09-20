/**
 * Proxy CRUD. Validation is shared with the Chromium flag builder so the
 * repository and the launcher reject the same malformed endpoints.
 *
 * Credential rule: the password itself is NEVER stored. `passwordSecretRef`
 * must be of the form `env:VAR_NAME` or `vault:<secret-name>` (or omitted);
 * anything else is rejected at write time.
 */

import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DatabaseSchema, ProxiesTable } from '../db/schema.js';
import { assertValidProxyEndpoint } from '../browser/flags.js';
import { ProfileNotFoundError } from '../profiles/lock.js';

export type ManagedProxyScheme = 'http' | 'https' | 'socks5';

const MANAGED_SCHEMES: readonly string[] = ['http', 'https', 'socks5'];

export class ProxyNotFoundError extends Error {
  constructor(readonly proxyId: string) {
    super(`Proxy ${proxyId} not found`);
    this.name = 'ProxyNotFoundError';
  }
}

export class InvalidSecretRefError extends Error {
  constructor(readonly ref: string) {
    super(
      `Invalid password_secret_ref ${JSON.stringify(ref)}: ` +
        'must be of the form "env:VAR_NAME" or "vault:<secret-name>"; plaintext secrets are never stored',
    );
    this.name = 'InvalidSecretRefError';
  }
}

export interface ProxyRecord {
  id: string;
  name: string;
  scheme: ManagedProxyScheme;
  host: string;
  port: number;
  username: string | null;
  password_secret_ref: string | null;
  bypass: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The public shape of a proxy: everything EXCEPT the credential reference.
 * API responses and logs must use this — never the full record.
 */
export interface PublicProxy {
  id: string;
  name: string;
  scheme: ManagedProxyScheme;
  host: string;
  port: number;
  username: string | null;
  has_credentials: boolean;
  bypass: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function toPublicProxy(record: ProxyRecord): PublicProxy {
  return {
    id: record.id,
    name: record.name,
    scheme: record.scheme,
    host: record.host,
    port: record.port,
    username: record.username,
    has_credentials: record.password_secret_ref !== null,
    bypass: record.bypass,
    notes: record.notes,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function rowToRecord(row: ProxiesTable): ProxyRecord {
  return {
    id: row.id,
    name: row.name,
    scheme: row.scheme as ManagedProxyScheme,
    host: row.host,
    port: row.port,
    username: row.username,
    password_secret_ref: row.password_secret_ref,
    bypass: row.bypass,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertManagedScheme(scheme: string): asserts scheme is ManagedProxyScheme {
  if (!MANAGED_SCHEMES.includes(scheme)) {
    throw new Error(
      `Unsupported proxy scheme ${JSON.stringify(scheme)}: expected one of ${MANAGED_SCHEMES.join(', ')}`,
    );
  }
}

const ENV_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_REF_PATTERN = /^vault:[A-Za-z0-9_.-]{1,100}$/;

export function assertValidSecretRef(ref: string | null | undefined): void {
  if (ref === null || ref === undefined) {
    return;
  }
  if (!ENV_REF_PATTERN.test(ref) && !VAULT_REF_PATTERN.test(ref)) {
    throw new InvalidSecretRefError(ref);
  }
}

export interface CreateProxyInput {
  name: string;
  scheme: ManagedProxyScheme;
  host: string;
  port: number;
  username?: string | null;
  passwordSecretRef?: string | null;
  bypass?: string | null;
  notes?: string | null;
}

export async function createProxy(
  db: Kysely<DatabaseSchema>,
  input: CreateProxyInput,
): Promise<ProxyRecord> {
  assertManagedScheme(input.scheme);
  assertValidProxyEndpoint(input.scheme, input.host, input.port);
  assertValidSecretRef(input.passwordSecretRef);

  const now = nowIso();
  const id = randomUUID();
  await db
    .insertInto('proxies')
    .values({
      id,
      name: input.name,
      scheme: input.scheme,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      password_secret_ref: input.passwordSecretRef ?? null,
      bypass: input.bypass ?? null,
      notes: input.notes ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return getProxy(db, id);
}

export async function getProxy(db: Kysely<DatabaseSchema>, proxyId: string): Promise<ProxyRecord> {
  const row = await db.selectFrom('proxies').selectAll().where('id', '=', proxyId).executeTakeFirst();
  if (!row) {
    throw new ProxyNotFoundError(proxyId);
  }
  return rowToRecord(row);
}

export async function listProxies(db: Kysely<DatabaseSchema>): Promise<ProxyRecord[]> {
  const rows = await db.selectFrom('proxies').selectAll().orderBy('name', 'asc').execute();
  return rows.map(rowToRecord);
}

export interface UpdateProxyInput {
  name?: string;
  scheme?: ManagedProxyScheme;
  host?: string;
  port?: number;
  username?: string | null;
  passwordSecretRef?: string | null;
  bypass?: string | null;
  notes?: string | null;
}

export async function updateProxy(
  db: Kysely<DatabaseSchema>,
  proxyId: string,
  input: UpdateProxyInput,
): Promise<ProxyRecord> {
  const current = await getProxy(db, proxyId);
  const scheme = input.scheme ?? current.scheme;
  const host = input.host ?? current.host;
  const port = input.port ?? current.port;
  assertManagedScheme(scheme);
  assertValidProxyEndpoint(scheme, host, port);
  if (input.passwordSecretRef !== undefined) {
    assertValidSecretRef(input.passwordSecretRef);
  }

  const patch: Partial<ProxiesTable> = { updated_at: nowIso() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.scheme !== undefined) patch.scheme = input.scheme;
  if (input.host !== undefined) patch.host = input.host;
  if (input.port !== undefined) patch.port = input.port;
  if (input.username !== undefined) patch.username = input.username;
  if (input.passwordSecretRef !== undefined) patch.password_secret_ref = input.passwordSecretRef;
  if (input.bypass !== undefined) patch.bypass = input.bypass;
  if (input.notes !== undefined) patch.notes = input.notes;

  await db.updateTable('proxies').set(patch).where('id', '=', proxyId).execute();
  return getProxy(db, proxyId);
}

export async function deleteProxy(db: Kysely<DatabaseSchema>, proxyId: string): Promise<void> {
  await getProxy(db, proxyId); // throws ProxyNotFoundError when missing
  try {
    await db.deleteFrom('proxies').where('id', '=', proxyId).execute();
  } catch (error) {
    // ON DELETE RESTRICT: an assigned proxy cannot be removed.
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
      throw new Error(`Cannot delete proxy ${proxyId}: it is assigned to a profile`);
    }
    throw error;
  }
}

/** Assign (or reassign) a proxy to a profile. */
export async function assignProxyToProfile(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  proxyId: string,
): Promise<void> {
  const profile = await db
    .selectFrom('profiles')
    .select(['id'])
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (!profile) {
    throw new ProfileNotFoundError(profileId);
  }
  await getProxy(db, proxyId); // throws ProxyNotFoundError when missing
  await db
    .insertInto('profile_proxy_assignments')
    .values({ profile_id: profileId, proxy_id: proxyId, created_at: nowIso() })
    .onConflict((oc) => oc.column('profile_id').doUpdateSet({ proxy_id: proxyId }))
    .execute();
}

/** Remove any proxy assignment from a profile. */
export async function unassignProxyFromProfile(
  db: Kysely<DatabaseSchema>,
  profileId: string,
): Promise<void> {
  await db.deleteFrom('profile_proxy_assignments').where('profile_id', '=', profileId).execute();
}

/** The proxy assigned to a profile, if any. */
export async function getAssignedProxy(
  db: Kysely<DatabaseSchema>,
  profileId: string,
): Promise<ProxyRecord | undefined> {
  const row = await db
    .selectFrom('profile_proxy_assignments')
    .innerJoin('proxies', 'proxies.id', 'profile_proxy_assignments.proxy_id')
    .selectAll('proxies')
    .where('profile_proxy_assignments.profile_id', '=', profileId)
    .executeTakeFirst();
  return row ? rowToRecord(row) : undefined;
}

/** Toggle the fail-closed launch gate for a profile. */
export async function setProxyRequired(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  required: boolean,
): Promise<void> {
  const result = await db
    .updateTable('profiles')
    .set({ proxy_required: required ? 1 : 0, updated_at: nowIso() })
    .where('id', '=', profileId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw new ProfileNotFoundError(profileId);
  }
}
