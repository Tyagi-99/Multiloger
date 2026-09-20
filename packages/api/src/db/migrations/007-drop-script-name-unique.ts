/**
 * Migration 007: drop the UNIQUE(name, version) constraint on automation_scripts.
 *
 * Script identity is the `id` column: versions accumulate as (id, version)
 * rows and jobs pin an exact (script_id, script_version). The name is only a
 * human label, so two different scripts must be allowed to share a name
 * (e.g. a "daily login" script per client). The UNIQUE(name, version) index
 * from 006 made names effectively global and turned a duplicate name into
 * an unmapped 500 instead of two distinct scripts.
 *
 * Replaced with a plain (non-unique) index on name for listing/filtering.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const dropScriptNameUnique: Migration = {
  name: '007-drop-script-name-unique',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropIndex('automation_scripts_name_version_idx').execute();
    await db.schema
      .createIndex('automation_scripts_name_idx')
      .on('automation_scripts')
      .column('name')
      .execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropIndex('automation_scripts_name_idx').execute();
    // NOTE: rolling back re-imposes name uniqueness and will fail if
    // duplicate (name, version) rows were created while 007 was applied.
    // That failure is intentional: it refuses to silently violate the
    // restored constraint.
    await db.schema
      .createIndex('automation_scripts_name_version_idx')
      .unique()
      .on('automation_scripts')
      .columns(['name', 'version'])
      .execute();
  },
};
