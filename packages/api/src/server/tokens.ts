/**
 * API token persistence and authentication.
 *
 * The plaintext token is returned ONLY by `createApiToken` — callers must
 * show it once and never store it. Every other shape omits it.
 *
 * Phase 3: tokens carry optional `user_id` attribution (null = legacy
 * token, grandfathered with full access), optional `scopes` (a JSON array
 * of permission keys that can only narrow the token's permissions), and
 * `created_by` (the issuing token, for the audit trail).
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ApiTokensTable, DatabaseSchema } from '../db/schema.js';
import { PERMISSION_KEYS } from '../db/migrations/008-teams.js';
import {
  burnDummyVerification,
  generateTokenValue,
  hashTokenSecret,
  isTokenFormat,
  parseBearerToken,
  tokenLookupPrefix,
  verifyTokenSecret,
} from './auth.js';
import { ValidationError } from './router.js';

export type { ApiTokensTable };

export interface CreatedToken {
  id: string;
  name: string;
  /** Plaintext. Shown ONCE — never stored, never returned again. */
  token: string;
  createdAt: string;
}

export interface PublicToken {
  id: string;
  name: string;
  prefix: string;
  userId: string | null;
  scopes: string[] | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateTokenOptions {
  /** Attribute the token to a user; omit/null for a legacy-style token. */
  userId?: string;
  /**
   * Narrow the token to these permission keys. Every key must be a known
   * permission; the set can only ever remove permissions, never add them.
   */
  scopes?: string[];
  /** Id of the issuing token (audit trail). */
  createdBy?: string;
}

function toPublicToken(row: ApiTokensTable): PublicToken {
  let scopes: string[] | null = null;
  if (row.scopes !== null) {
    try {
      const parsed: unknown = JSON.parse(row.scopes);
      scopes = Array.isArray(parsed)
        ? parsed.filter((s): s is string => typeof s === 'string')
        : null;
    } catch {
      scopes = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    userId: row.user_id,
    scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const KNOWN_PERMISSIONS = new Set<string>(PERMISSION_KEYS);

function validateScopes(scopes: string[] | undefined): string | null {
  if (scopes === undefined) {
    return null;
  }
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (typeof scope !== 'string' || !KNOWN_PERMISSIONS.has(scope)) {
      throw new ValidationError(
        `Unknown permission key in scopes: ${typeof scope === 'string' ? scope : '<non-string>'}`,
      );
    }
  }
  return JSON.stringify(unique);
}

export async function createApiToken(
  db: Kysely<DatabaseSchema>,
  name: string,
  options: CreateTokenOptions = {},
): Promise<CreatedToken> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error('Token name must be 1-100 characters');
  }
  const scopesJson = validateScopes(options.scopes);
  if (options.userId !== undefined) {
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', options.userId)
      .executeTakeFirst();
    if (!user) {
      throw new ValidationError(`Unknown user: ${options.userId}`);
    }
  }
  const token = generateTokenValue();
  const { salt, hash } = await hashTokenSecret(token);
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto('api_tokens')
    .values({
      id,
      name: trimmed,
      prefix: tokenLookupPrefix(token),
      salt,
      hash,
      ...(options.userId !== undefined ? { user_id: options.userId } : {}),
      ...(scopesJson !== null ? { scopes: scopesJson } : {}),
      ...(options.createdBy !== undefined ? { created_by: options.createdBy } : {}),
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute();
  return { id, name: trimmed, token, createdAt: now };
}

export async function listApiTokens(
  db: Kysely<DatabaseSchema>,
  filter: { userId?: string } = {},
): Promise<PublicToken[]> {
  let query = db.selectFrom('api_tokens').selectAll().orderBy('created_at', 'asc');
  if (filter.userId !== undefined) {
    query = query.where('user_id', '=', filter.userId);
  }
  const rows = await query.execute();
  return rows.map(toPublicToken);
}

export class TokenNotFoundError extends Error {
  constructor(public readonly tokenId: string) {
    super(`API token not found: ${tokenId}`);
    this.name = 'TokenNotFoundError';
  }
}

export async function revokeApiToken(
  db: Kysely<DatabaseSchema>,
  tokenId: string,
): Promise<PublicToken> {
  const row = await db
    .selectFrom('api_tokens')
    .selectAll()
    .where('id', '=', tokenId)
    .executeTakeFirst();
  if (!row) {
    throw new TokenNotFoundError(tokenId);
  }
  const now = new Date().toISOString();
  await db.updateTable('api_tokens').set({ revoked_at: now }).where('id', '=', tokenId).execute();
  return { ...toPublicToken(row), revokedAt: now };
}

/**
 * Authenticate a request. Returns the token row on success, null otherwise.
 * Updates `last_used_at` on success. Tokens attributed to a disabled or
 * deleted user are rejected (fail closed). Performs a dummy scrypt when no
 * candidate exists so failures take constant-ish time.
 */
export async function authenticateRequest(
  db: Kysely<DatabaseSchema>,
  authorizationHeader: string | undefined,
): Promise<ApiTokensTable | null> {
  const presented = parseBearerToken(authorizationHeader);
  if (!presented || !isTokenFormat(presented)) {
    return null;
  }
  const candidates = await db
    .selectFrom('api_tokens')
    .selectAll()
    .where('prefix', '=', tokenLookupPrefix(presented))
    .where('revoked_at', 'is', null)
    .execute();
  for (const row of candidates) {
    if (await verifyTokenSecret(presented, row.salt, row.hash)) {
      if (row.user_id !== null) {
        const user = await db
          .selectFrom('users')
          .select('disabled')
          .where('id', '=', row.user_id)
          .executeTakeFirst();
        if (!user || user.disabled === 1) {
          await burnDummyVerification();
          return null;
        }
      }
      await db
        .updateTable('api_tokens')
        .set({ last_used_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute();
      return row;
    }
  }
  await burnDummyVerification();
  return null;
}
