/**
 * Migration 005: encrypted profile backups.
 *
 * `backups` records every .mlbackup file on disk. `seq` is an autoincrement
 * ordering key so retention ("keep newest N per profile") is deterministic
 * even when several backups share a created_at timestamp.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const backups: Migration = {
  name: '005-backups',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('backups')
      .addColumn('seq', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('id', 'text', (col) => col.notNull().unique())
      .addColumn('profile_id', 'text', (col) => col.notNull())
      .addColumn('file_name', 'text', (col) => col.notNull())
      .addColumn('size_bytes', 'integer', (col) => col.notNull())
      .addColumn('sha256', 'text', (col) => col.notNull())
      .addColumn('encryption', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();
    await db.schema.createIndex('idx_backups_profile_id').on('backups').column('profile_id').execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('backups').execute();
  },
};
