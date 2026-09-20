/**
 * Migration 006: automation jobs & runs (Phase 2).
 *
 * - `automation_scripts` — versioned declarative scripts; (name, version)
 *   is unique so republishing never rewrites history.
 * - `automation_jobs` — "run script S vV against profile P"; script_id has
 *   a RESTRICT foreign key so a script with jobs cannot be deleted.
 * - `automation_runs` — one execution of a job; job_id cascades.
 *
 * `profile_id` intentionally has NO foreign key on jobs and runs: run
 * history is an audit trail and must survive the deletion of the profile
 * it ran against (same reasoning as the backups table in 005).
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const automation: Migration = {
  name: '006-automation',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('automation_scripts')
      // One row per (id, version): the id is the script's stable identity,
      // versions accumulate as new rows. Jobs pin id + version.
      .addColumn('id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('version', 'integer', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('steps', 'text', (col) => col.notNull())
      .addColumn('created_by', 'text')
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('automation_scripts_pkey', ['id', 'version'])
      .execute();
    await db.schema
      .createIndex('automation_scripts_name_version_idx')
      .unique()
      .on('automation_scripts')
      .columns(['name', 'version'])
      .execute();

    await db.schema
      .createTable('automation_jobs')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('script_id', 'text', (col) => col.notNull())
      .addColumn('script_version', 'integer', (col) => col.notNull())
      .addColumn('profile_id', 'text', (col) => col.notNull())
      .addColumn('created_by', 'text')
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('timeout_ms', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      // A job pins an exact script version; deleting a script version that
      // has jobs is refused (RESTRICT).
      .addForeignKeyConstraint(
        'automation_jobs_script_fk',
        ['script_id', 'script_version'],
        'automation_scripts',
        ['id', 'version'],
        (cb) => cb.onDelete('restrict'),
      )
      .execute();
    await db.schema
      .createIndex('automation_jobs_profile_id_idx')
      .on('automation_jobs')
      .column('profile_id')
      .execute();
    await db.schema
      .createIndex('automation_jobs_status_idx')
      .on('automation_jobs')
      .column('status')
      .execute();

    await db.schema
      .createTable('automation_runs')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('job_id', 'text', (col) =>
        col.notNull().references('automation_jobs.id').onDelete('cascade'),
      )
      .addColumn('profile_id', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('timeout_ms', 'integer', (col) => col.notNull())
      .addColumn('started_at', 'text')
      .addColumn('finished_at', 'text')
      .addColumn('logs', 'text', (col) => col.notNull())
      .addColumn('result_json', 'text')
      .addColumn('error', 'text')
      .addColumn('artifact_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();
    await db.schema
      .createIndex('automation_runs_job_id_idx')
      .on('automation_runs')
      .column('job_id')
      .execute();
    await db.schema
      .createIndex('automation_runs_status_idx')
      .on('automation_runs')
      .column('status')
      .execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('automation_runs').execute();
    await db.schema.dropTable('automation_jobs').execute();
    await db.schema.dropTable('automation_scripts').execute();
  },
};
