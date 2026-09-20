/**
 * Migration 004: API tokens.
 *
 * Tokens are stored scrypt-hashed with a per-token salt. The plaintext
 * token is shown exactly once at creation; only `prefix` (for lookup)
 * is stored alongside the hash.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const apiTokens: Migration = {
  name: '004-api-tokens',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('api_tokens')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('prefix', 'text', (col) => col.notNull())
      .addColumn('salt', 'text', (col) => col.notNull())
      .addColumn('hash', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('last_used_at', 'text')
      .addColumn('revoked_at', 'text')
      .execute();
    await db.schema.createIndex('idx_api_tokens_prefix').on('api_tokens').column('prefix').execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('api_tokens').execute();
  },
};
