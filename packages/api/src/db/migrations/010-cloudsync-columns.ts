/**
 * Migration 010: Phase 4b cloud-sync refinements.
 *
 * - `cloud_sync_config.prefix`: object key prefix for remote backups
 *   (default 'multiloger/').
 * - `cloud_sync_objects.sha256`: hex SHA-256 of the encrypted .mlbackup
 *   blob at upload time, so a later download can be integrity-checked
 *   before restore (defense in depth alongside the AES-GCM envelope).
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const cloudsyncColumns: Migration = {
  name: '010-cloudsync-columns',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .alterTable('cloud_sync_config')
      .addColumn('prefix', 'text', (col) => col.notNull().defaultTo('multiloger/'))
      .execute();
    await db.schema.alterTable('cloud_sync_objects').addColumn('sha256', 'text').execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.alterTable('cloud_sync_objects').dropColumn('sha256').execute();
    await db.schema.alterTable('cloud_sync_config').dropColumn('prefix').execute();
  },
};
