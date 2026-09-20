/**
 * API token persistence and authentication.
 *
 * The plaintext token is returned ONLY by `createApiToken` — callers must
 * show it once and never store it. Every other shape omits it.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ApiTokensTable, DatabaseSchema } from '../db/schema.js';
import {
  burnDummyVerification,
  generateTokenValue,
  hashTokenSecret,
  isTokenFormat,
  parseBearerToken,
  tokenLookupPrefix,
  verifyTokenSecret,
} from './auth.js';

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
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toPublicToken(row: ApiTokensTable): PublicToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export async function createApiToken(db: Kysely<DatabaseSchema>, name: string): Promise<CreatedToken> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error('Token name must be 1-100 characters');
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
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute();
  return { id, name: trimmed, token, createdAt: now };
}

export async function listApiTokens(db: Kysely<DatabaseSchema>): Promise<PublicToken[]> {
  const rows = await db.selectFrom('api_tokens').selectAll().orderBy('created_at', 'asc').execute();
  return rows.map(toPublicToken);
}

export class TokenNotFoundError extends Error {
  constructor(public readonly tokenId: string) {
    super(`API token not found: ${tokenId}`);
    this.name = 'TokenNotFoundError';
  }
}

export async function revokeApiToken(db: Kysely<DatabaseSchema>, tokenId: string): Promise<PublicToken> {
  const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', tokenId).executeTakeFirst();
  if (!row) {
    throw new TokenNotFoundError(tokenId);
  }
  const now = new Date().toISOString();
  await db.updateTable('api_tokens').set({ revoked_at: now }).where('id', '=', tokenId).execute();
  return { ...toPublicToken(row), revokedAt: now };
}

/**
 * Authenticate a request. Returns the token row on success, null otherwise.
 * Updates `last_used_at` on success. Performs a dummy scrypt when no
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
