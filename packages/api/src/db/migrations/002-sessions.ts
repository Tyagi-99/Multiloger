/**
 * Migration 002 — session history + launch bookkeeping on profiles.
 *
 * - `sessions`: one row per launch, for "last used", crash forensics and
 *   billing evidence (per the architecture report's DB design).
 * - `profiles.last_pid` / `last_cdp_port` / `last_launched_at`: lets the
 *   startup reaper check liveness of a browser whose manager died, and lets
 *   operators see what a profile last ran as.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const sessions: Migration = {
  name: '002-sessions',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('sessions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('profile_id', 'text', (col) =>
        col.notNull().references('profiles.id').onDelete('cascade'),
      )
      .addColumn('started_at', 'text', (col) => col.notNull())
      .addColumn('ended_at', 'text')
      .addColumn('exit_reason', 'text')
      .addColumn('pid', 'integer')
      .addColumn('cdp_port', 'integer')
      .execute();

    await db.schema
      .createIndex('sessions_profile_id_idx')
      .on('sessions')
      .column('profile_id')
      .execute();

    await db.schema.alterTable('profiles').addColumn('last_pid', 'integer').execute();
    await db.schema.alterTable('profiles').addColumn('last_cdp_port', 'integer').execute();
    await db.schema.alterTable('profiles').addColumn('last_launched_at', 'text').execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.alterTable('profiles').dropColumn('last_launched_at').execute();
    await db.schema.alterTable('profiles').dropColumn('last_cdp_port').execute();
    await db.schema.alterTable('profiles').dropColumn('last_pid').execute();
    await db.schema.dropTable('sessions').execute();
  },
};
