/**
 * Migration 008: team management + RBAC.
 *
 * New tables:
 * - users: team members (passwords are scrypt hashes — never reversible).
 * - roles / permissions / role_permissions: the RBAC catalog.
 * - user_roles: role assignment.
 * - user_clients / user_profiles: client/profile scoping for non-admins.
 * - invitations: single-use, expiring invite tokens (scrypt-hashed like API
 *   tokens; the plaintext is shown to the inviting admin exactly once).
 * - audit_log: append-only record of mutating API calls.
 *
 * api_tokens gains three nullable columns:
 * - user_id: attribution to a user; NULL = legacy token (grandfathered:
 *   keeps full access, exactly like before Phase 3).
 * - scopes: JSON array of permission keys; NULL = no narrowing, otherwise
 *   the token's effective permissions are role-permissions ∩ scopes.
 * - created_by: id of the API token that issued this one (audit trail).
 *
 * Seeds the default roles (admin / operator / viewer) and the permission
 * catalog. Seed ids are fixed ('admin', 'operator', 'viewer', and the
 * permission key itself) so re-running the seed is a no-op.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../schema.js';
import type { Migration } from '../migrate.js';

/** The permission catalog. Keys are stable API surface — never rename. */
export const PERMISSION_KEYS = [
  'profiles:read',
  'profiles:create',
  'profiles:update',
  'profiles:launch',
  'clients:read',
  'clients:create',
  'proxies:read',
  'proxies:manage',
  'proxies:health',
  'automation:read',
  'automation:scripts:manage',
  'automation:run',
  'backups:read',
  'backups:create',
  'backups:restore',
  'backups:delete',
  'tokens:read',
  'tokens:manage',
  'users:manage',
  'roles:manage',
  'audit:read',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const ADMIN_PERMISSIONS: readonly string[] = [...PERMISSION_KEYS];

const OPERATOR_PERMISSIONS: readonly string[] = [
  'profiles:read',
  'profiles:create',
  'profiles:update',
  'profiles:launch',
  'clients:read',
  'clients:create',
  'proxies:read',
  'proxies:health',
  'automation:read',
  'automation:scripts:manage',
  'automation:run',
  'backups:read',
  'backups:create',
  'backups:restore',
];

const VIEWER_PERMISSIONS: readonly string[] = [
  'profiles:read',
  'clients:read',
  'proxies:read',
  'automation:read',
  'backups:read',
  'audit:read',
];

export const apiTeams: Migration = {
  name: '008-teams',

  async up(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema
      .createTable('users')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('email', 'text', (col) => col.notNull().unique())
      .addColumn('password_hash', 'text', (col) => col.notNull())
      .addColumn('disabled', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('roles')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull().unique())
      .addColumn('description', 'text')
      .addColumn('seeded', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('permissions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('key', 'text', (col) => col.notNull().unique())
      .addColumn('description', 'text')
      .execute();

    await db.schema
      .createTable('role_permissions')
      .addColumn('role_id', 'text', (col) => col.notNull())
      .addColumn('permission_id', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_role_permissions', ['role_id', 'permission_id'])
      .execute();

    await db.schema
      .createTable('user_roles')
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('role_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_user_roles', ['user_id', 'role_id'])
      .execute();

    await db.schema
      .createTable('user_clients')
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('client_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_user_clients', ['user_id', 'client_id'])
      .execute();

    await db.schema
      .createTable('user_profiles')
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('profile_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_user_profiles', ['user_id', 'profile_id'])
      .execute();

    await db.schema
      .createTable('invitations')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('email', 'text', (col) => col.notNull())
      .addColumn('role_id', 'text', (col) => col.notNull())
      .addColumn('client_ids', 'text', (col) => col.notNull())
      .addColumn('profile_ids', 'text', (col) => col.notNull())
      .addColumn('prefix', 'text', (col) => col.notNull())
      .addColumn('salt', 'text', (col) => col.notNull())
      .addColumn('hash', 'text', (col) => col.notNull())
      .addColumn('expires_at', 'text', (col) => col.notNull())
      .addColumn('used_at', 'text')
      .addColumn('created_by', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();
    await db.schema.createIndex('idx_invitations_prefix').on('invitations').column('prefix').execute();

    await db.schema
      .createTable('audit_log')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('at', 'text', (col) => col.notNull())
      .addColumn('actor_type', 'text', (col) => col.notNull())
      .addColumn('actor_id', 'text')
      .addColumn('action', 'text', (col) => col.notNull())
      .addColumn('entity_type', 'text')
      .addColumn('entity_id', 'text')
      .addColumn('details_json', 'text')
      .addColumn('ip', 'text')
      .execute();
    await db.schema.createIndex('idx_audit_log_at').on('audit_log').column('at').execute();
    await db.schema.createIndex('idx_audit_log_actor').on('audit_log').column('actor_id').execute();
    await db.schema.createIndex('idx_audit_log_action').on('audit_log').column('action').execute();

    await db.schema.alterTable('api_tokens').addColumn('user_id', 'text').execute();
    await db.schema.alterTable('api_tokens').addColumn('scopes', 'text').execute();
    await db.schema.alterTable('api_tokens').addColumn('created_by', 'text').execute();

    // ---- seeds (idempotent: fixed ids + insert-or-ignore) ----
    const now = new Date().toISOString();
    const roles = [
      { id: 'admin', name: 'admin', description: 'Full access: all permissions, all clients, user management.' },
      { id: 'operator', name: 'operator', description: 'Day-to-day operations: launch/stop profiles, run automation, manage backups (no deletes), no user management.' },
      { id: 'viewer', name: 'viewer', description: 'Read-only: view profiles, clients, proxies, automation, backups; own audit entries.' },
    ];
    for (const role of roles) {
      await db
        .insertInto('roles')
        .values({ ...role, seeded: 1, created_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const key of PERMISSION_KEYS) {
      await db
        .insertInto('permissions')
        .values({ id: key, key, description: null })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const grants: Record<string, readonly string[]> = {
      admin: ADMIN_PERMISSIONS,
      operator: OPERATOR_PERMISSIONS,
      viewer: VIEWER_PERMISSIONS,
    };
    for (const [roleId, keys] of Object.entries(grants)) {
      for (const key of keys) {
        await db
          .insertInto('role_permissions')
          .values({ role_id: roleId, permission_id: key })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
  },

  async down(db: Kysely<DatabaseSchema>): Promise<void> {
    await db.schema.dropTable('audit_log').execute();
    await db.schema.dropTable('invitations').execute();
    await db.schema.dropTable('user_profiles').execute();
    await db.schema.dropTable('user_clients').execute();
    await db.schema.dropTable('user_roles').execute();
    await db.schema.dropTable('role_permissions').execute();
    await db.schema.dropTable('permissions').execute();
    await db.schema.dropTable('roles').execute();
    await db.schema.dropTable('users').execute();
    await db.schema.alterTable('api_tokens').dropColumn('created_by').execute();
    await db.schema.alterTable('api_tokens').dropColumn('scopes').execute();
    await db.schema.alterTable('api_tokens').dropColumn('user_id').execute();
  },
};
