/**
 * Migration 003 — managed proxies.
 *
 * - `proxies`: named proxy endpoints (http/https/socks5). Credentials are
 *   NEVER stored here: `username` is fine (not secret), but the password
 *   lives behind `password_secret_ref`, an opaque reference of the form
 *   `env:VAR_NAME` resolved from the process environment at launch time.
 *   The production OS-vault/keychain integration is a tracked pending
 *   decision; this reference scheme is the honest MVP placeholder.
 * - `profile_proxy_assignments`: at most one proxy per profile (MVP).
 * - `profiles.proxy_required`: when true, launching without a healthy
 *   assigned proxy is refused (fail-closed, Task 6 launch gate).
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

export const proxies: Migration = {
  name: '003-proxies',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('proxies')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull().unique())
      .addColumn('scheme', 'text', (col) => col.notNull())
      .addColumn('host', 'text', (col) => col.notNull())
      .addColumn('port', 'integer', (col) => col.notNull())
      .addColumn('username', 'text')
      .addColumn('password_secret_ref', 'text')
      .addColumn('bypass', 'text')
      .addColumn('notes', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('profile_proxy_assignments')
      .addColumn('profile_id', 'text', (col) =>
        col.primaryKey().references('profiles.id').onDelete('cascade'),
      )
      .addColumn('proxy_id', 'text', (col) =>
        col.notNull().references('proxies.id').onDelete('restrict'),
      )
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .alterTable('profiles')
      .addColumn('proxy_required', 'integer', (col) => col.notNull().defaultTo(0))
      .execute();
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.alterTable('profiles').dropColumn('proxy_required').execute();
    await db.schema.dropTable('profile_proxy_assignments').execute();
    await db.schema.dropTable('proxies').execute();
  },
};
