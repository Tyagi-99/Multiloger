/**
 * Migration 008 (teams + RBAC): seeds and rollback.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from './database.js';
import { migrateDown, migrateToLatest } from './migrate.js';
import { PERMISSION_KEYS } from './migrations/008-teams.js';
import type { DatabaseSchema } from './schema.js';

let dir: string | undefined;
let db: Kysely<DatabaseSchema> | undefined;

afterEach(async () => {
  if (db) {
    await closeDatabase(db);
    db = undefined;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tableNames(database: Kysely<DatabaseSchema>): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.execute(
    database,
  );
  return rows.rows.map((r) => r.name);
}

async function permissionsOf(database: Kysely<DatabaseSchema>, roleId: string): Promise<string[]> {
  const rows = await database
    .selectFrom('role_permissions')
    .select('permission_id')
    .where('role_id', '=', roleId)
    .execute();
  return rows.map((r) => r.permission_id).sort();
}

describe('migration 008-teams', () => {
  it('creates the team tables and seeds roles + permissions', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-teams-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    await migrateToLatest(db);

    const tables = await tableNames(db);
    for (const table of [
      'users',
      'roles',
      'permissions',
      'role_permissions',
      'user_roles',
      'user_clients',
      'user_profiles',
      'invitations',
      'audit_log',
    ]) {
      expect(tables).toContain(table);
    }

    const permissionRows = await db.selectFrom('permissions').select('key').execute();
    expect(permissionRows.map((r) => r.key).sort()).toEqual([...PERMISSION_KEYS].sort());

    const roles = await db.selectFrom('roles').selectAll().execute();
    expect(roles.map((r) => r.id).sort()).toEqual(['admin', 'operator', 'viewer']);
    expect(roles.every((r) => r.seeded === 1)).toBe(true);

    // admin: everything; operator: no user management; viewer: read-only.
    expect(await permissionsOf(db, 'admin')).toEqual([...PERMISSION_KEYS].sort());
    const operator = await permissionsOf(db, 'operator');
    expect(operator).toContain('profiles:launch');
    expect(operator).toContain('automation:run');
    expect(operator).not.toContain('users:manage');
    expect(operator).not.toContain('tokens:manage');
    expect(operator).not.toContain('backups:delete');
    const viewer = await permissionsOf(db, 'viewer');
    expect(viewer).toContain('profiles:read');
    expect(viewer).not.toContain('profiles:launch');
    expect(viewer).not.toContain('profiles:create');

    // api_tokens gained the Phase 3 columns.
    const columns = await sql<{ name: string }>`PRAGMA table_info(api_tokens)`.execute(db);
    const names = columns.rows.map((r) => r.name);
    expect(names).toContain('user_id');
    expect(names).toContain('scopes');
    expect(names).toContain('created_by');
  });

  it('rolls back cleanly with migrateDown', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-teams-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    await migrateToLatest(db);

    const reverted = await migrateDown(db, 1);
    expect(reverted).toEqual(['008-teams']);

    const tables = await tableNames(db);
    for (const table of ['users', 'roles', 'permissions', 'invitations', 'audit_log']) {
      expect(tables).not.toContain(table);
    }
    expect(tables).toContain('api_tokens');
    const columns = await sql<{ name: string }>`PRAGMA table_info(api_tokens)`.execute(db);
    const names = columns.rows.map((r) => r.name);
    expect(names).not.toContain('user_id');
    expect(names).not.toContain('scopes');

    // And migrating up again restores everything (seeds are idempotent).
    await migrateToLatest(db);
    expect(await tableNames(db)).toContain('audit_log');
    expect(await permissionsOf(db, 'admin')).toEqual([...PERMISSION_KEYS].sort());
  });
});
