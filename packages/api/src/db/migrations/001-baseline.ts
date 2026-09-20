/**
 * Migration 001 — baseline schema.
 *
 * Creates the core tables every later task builds on:
 * - `clients` — who the profiles belong to.
 * - `profiles` — browser profiles with lifecycle state and lock columns.
 *
 * The `_migrations` journal table is managed by the migration runner itself
 * and is not part of any migration.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const baseline: Migration = {
  name: '001-baseline',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('clients')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('notes', 'text')
      .addColumn('archived_at', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('profiles')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('client_id', 'text', (col) =>
        col.notNull().references('clients.id').onDelete('cascade'),
      )
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('state', 'text', (col) => col.notNull())
      .addColumn('locked_by', 'text')
      .addColumn('locked_at', 'text')
      .addColumn('user_data_dir', 'text', (col) => col.notNull().unique())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex('profiles_client_id_idx')
      .on('profiles')
      .column('client_id')
      .execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('profiles').execute();
    await db.schema.dropTable('clients').execute();
  },
};
