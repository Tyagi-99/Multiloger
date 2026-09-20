/**
 * Migration 009: Phase 4 operational extras.
 *
 * - New permission keys: `monitoring:read`, `profiles:sync`, `backups:sync`.
 *   Granted to admin (all three), operator (all three), viewer
 *   (`monitoring:read` only). Insert-or-ignore so the migration is
 *   idempotent and never duplicates grants.
 * - `cloud_sync_config`: single-row table (id = 'default') holding the
 *   S3-compatible endpoint/bucket/region plus the vault secret names for
 *   the credentials. The credentials themselves live ONLY in the vault —
 *   this table stores names, never values.
 * - `cloud_sync_objects`: tracks which local backups have been uploaded,
 *   so `sync now` is incremental.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

const NEW_PERMISSIONS = ['monitoring:read', 'profiles:sync', 'backups:sync'] as const;

const GRANTS: Record<string, readonly string[]> = {
  admin: ['monitoring:read', 'profiles:sync', 'backups:sync'],
  operator: ['monitoring:read', 'profiles:sync', 'backups:sync'],
  viewer: ['monitoring:read'],
};

export const phase4: Migration = {
  name: '009-phase4',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    for (const key of NEW_PERMISSIONS) {
      await db
        .insertInto('permissions')
        .values({ id: key, key, description: null })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const [roleId, keys] of Object.entries(GRANTS)) {
      for (const key of keys) {
        await db
          .insertInto('role_permissions')
          .values({ role_id: roleId, permission_id: key })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }

    await db.schema
      .createTable('cloud_sync_config')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('endpoint', 'text', (col) => col.notNull())
      .addColumn('bucket', 'text', (col) => col.notNull())
      .addColumn('region', 'text', (col) => col.notNull())
      .addColumn('access_key_secret', 'text', (col) => col.notNull())
      .addColumn('secret_key_secret', 'text', (col) => col.notNull())
      .addColumn('retention', 'integer', (col) => col.notNull().defaultTo(10))
      .addColumn('allow_insecure', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('cloud_sync_objects')
      .addColumn('backup_id', 'text', (col) => col.primaryKey())
      .addColumn('object_key', 'text', (col) => col.notNull())
      .addColumn('etag', 'text')
      .addColumn('size_bytes', 'integer', (col) => col.notNull())
      .addColumn('uploaded_at', 'text', (col) => col.notNull())
      .execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('cloud_sync_objects').execute();
    await db.schema.dropTable('cloud_sync_config').execute();
    for (const [roleId, keys] of Object.entries(GRANTS)) {
      for (const key of keys) {
        await db
          .deleteFrom('role_permissions')
          .where('role_id', '=', roleId)
          .where('permission_id', '=', key)
          .execute();
      }
    }
    for (const key of NEW_PERMISSIONS) {
      await db.deleteFrom('permissions').where('id', '=', key).execute();
    }
  },
};
