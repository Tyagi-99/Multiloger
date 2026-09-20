/**
 * Unit tests for RBAC identity resolution and enforcement (access.ts).
 * Uses a real migrated SQLite database in a temp dir — no HTTP involved.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import type { DatabaseSchema } from '../db/schema.js';
import { createApiToken } from './tokens.js';
import {
  createUser,
  grantClientAccess,
  grantProfileAccess,
  updateUser,
} from './users.js';
import {
  assertClientAccess,
  assertProfileAccess,
  filterByProfileScope,
  ForbiddenError,
  hasPermission,
  IdentityRejectedError,
  requireIdentity,
  requirePermission,
  resolveIdentity,
} from './access.js';

let dir: string;
let db: Kysely<DatabaseSchema>;

async function seedClient(name: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('clients')
    .values({
      id,
      name,
      notes: null,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

async function seedProfile(clientId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('profiles')
    .values({
      id,
      client_id: clientId,
      name,
      state: 'stopped',
      locked_by: null,
      locked_at: null,
      user_data_dir: `/tmp/ml-test/${name}`,
      last_pid: null,
      last_cdp_port: null,
      last_launched_at: null,
      proxy_required: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'multiloger-access-test-'));
  db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveIdentity', () => {
  it('grandfathers legacy tokens with full access', async () => {
    const created = await createApiToken(db, 'legacy');
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    expect(identity.kind).toBe('legacy');
    expect(identity.legacy).toBe(true);
    expect(identity.isAdmin).toBe(true);
    expect(identity.userId).toBeNull();
    expect(hasPermission(identity, 'users:manage')).toBe(true);
    expect(hasPermission(identity, 'anything:at:all')).toBe(true);
  });

  it('resolves role permissions as a union', async () => {
    const user = await createUser(db, {
      name: 'Op',
      email: 'op@example.com',
      password: 'operator-password-1',
      roleIds: ['operator', 'viewer'],
    });
    const created = await createApiToken(db, 'op-token', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    expect(identity.kind).toBe('user');
    expect(identity.isAdmin).toBe(false);
    expect(hasPermission(identity, 'profiles:launch')).toBe(true);
    expect(hasPermission(identity, 'audit:read')).toBe(true); // from viewer
    expect(hasPermission(identity, 'users:manage')).toBe(false);
  });

  it('marks admin role holders as admin', async () => {
    const user = await createUser(db, {
      name: 'Admin',
      email: 'admin@example.com',
      password: 'admin-password-123',
      roleIds: ['admin'],
    });
    const created = await createApiToken(db, 'admin-token', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    expect(identity.isAdmin).toBe(true);
    expect(hasPermission(identity, 'users:manage')).toBe(true);
  });

  it('gives users with no roles zero permissions', async () => {
    const user = await createUser(db, { name: 'Nobody', email: 'nobody@example.com', password: 'nobody-password-1' });
    const created = await createApiToken(db, 'nobody-token', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    expect(hasPermission(identity, 'profiles:read')).toBe(false);
  });

  it('narrows permissions through token scopes (scopes can only remove)', async () => {
    const user = await createUser(db, {
      name: 'Scoped',
      email: 'scoped@example.com',
      password: 'scoped-password-12',
      roleIds: ['operator'],
    });
    const created = await createApiToken(db, 'scoped-token', {
      userId: user.id,
      scopes: ['profiles:read', 'profiles:launch', 'users:manage'],
    });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    // users:manage is dropped: the operator role never had it.
    expect(hasPermission(identity, 'profiles:read')).toBe(true);
    expect(hasPermission(identity, 'profiles:launch')).toBe(true);
    expect(hasPermission(identity, 'users:manage')).toBe(false);
    expect(hasPermission(identity, 'profiles:create')).toBe(false);
  });

  it('rejects tokens of disabled users', async () => {
    const user = await createUser(db, {
      name: 'Gone',
      email: 'gone@example.com',
      password: 'gone-password-1234',
      roleIds: ['viewer'],
    });
    const created = await createApiToken(db, 'gone-token', { userId: user.id });
    await updateUser(db, user.id, { disabled: true });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    await expect(resolveIdentity(db, row)).rejects.toThrow(IdentityRejectedError);
  });

  it('rejects tokens whose user was deleted', async () => {
    const user = await createUser(db, {
      name: 'Deleted',
      email: 'deleted@example.com',
      password: 'deleted-password-1',
      roleIds: ['viewer'],
    });
    const created = await createApiToken(db, 'deleted-token', { userId: user.id });
    await db.deleteFrom('users').where('id', '=', user.id).execute();
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    await expect(resolveIdentity(db, row)).rejects.toThrow(IdentityRejectedError);
  });
});

describe('requirePermission / requireIdentity', () => {
  it('throws ForbiddenError naming the missing permission', async () => {
    const user = await createUser(db, {
      name: 'Viewer',
      email: 'viewer@example.com',
      password: 'viewer-password-12',
      roleIds: ['viewer'],
    });
    const created = await createApiToken(db, 'v', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    expect(() => {
      requirePermission(identity, 'profiles:launch');
    }).toThrow(ForbiddenError);
    expect(() => {
      requirePermission(identity, 'profiles:launch');
    }).toThrow('profiles:launch');
    expect(() => {
      requirePermission(identity, 'profiles:read');
    }).not.toThrow();
  });

  it('requireIdentity throws when there is no identity', () => {
    expect(() => requireIdentity({ identity: null })).toThrow();
  });
});

describe('client/profile scoping', () => {
  it('denies by default and allows granted clients', async () => {
    const clientA = await seedClient('a');
    const clientB = await seedClient('b');
    const user = await createUser(db, {
      name: 'Scoped',
      email: 's@example.com',
      password: 'scoped-password-12',
      roleIds: ['operator'],
    });
    const created = await createApiToken(db, 't', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    await expect(assertClientAccess(db, identity, clientA)).rejects.toThrow(ForbiddenError);
    await grantClientAccess(db, user.id, clientA);
    await assertClientAccess(db, identity, clientA);
    await expect(assertClientAccess(db, identity, clientB)).rejects.toThrow(ForbiddenError);
  });

  it('lets legacy tokens and admins bypass scoping', async () => {
    const clientA = await seedClient('a');
    const created = await createApiToken(db, 'legacy');
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    await assertClientAccess(db, await resolveIdentity(db, row), clientA);

    const admin = await createUser(db, {
      name: 'Admin',
      email: 'a2@example.com',
      password: 'admin-password-123',
      roleIds: ['admin'],
    });
    const adminToken = await createApiToken(db, 'at', { userId: admin.id });
    const adminRow = await db
      .selectFrom('api_tokens')
      .selectAll()
      .where('id', '=', adminToken.id)
      .executeTakeFirstOrThrow();
    await assertClientAccess(db, await resolveIdentity(db, adminRow), clientA);
  });

  it('grants profile access via direct grant or client grant', async () => {
    const clientA = await seedClient('a');
    const clientB = await seedClient('b');
    const profileA = await seedProfile(clientA, 'a1');
    const profileB = await seedProfile(clientB, 'b1');
    const user = await createUser(db, {
      name: 'Op',
      email: 'op2@example.com',
      password: 'operator-password-1',
      roleIds: ['operator'],
    });
    const created = await createApiToken(db, 't', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);

    await expect(assertProfileAccess(db, identity, profileA)).rejects.toThrow(ForbiddenError);
    // Direct profile grant works without any client grant.
    await grantProfileAccess(db, user.id, profileB);
    await assertProfileAccess(db, identity, profileB);
    await expect(assertProfileAccess(db, identity, profileA)).rejects.toThrow(ForbiddenError);
    // Client grant covers the client's profiles.
    await grantClientAccess(db, user.id, clientA);
    await assertProfileAccess(db, identity, profileA);
  });

  it('filterByProfileScope keeps only accessible jobs', async () => {
    const clientA = await seedClient('a');
    const clientB = await seedClient('b');
    const profileA = await seedProfile(clientA, 'a1');
    const profileB = await seedProfile(clientB, 'b1');
    const user = await createUser(db, {
      name: 'Op',
      email: 'op3@example.com',
      password: 'operator-password-1',
      roleIds: ['operator'],
    });
    await grantClientAccess(db, user.id, clientA);
    const created = await createApiToken(db, 't', { userId: user.id });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
    const identity = await resolveIdentity(db, row);
    const jobs = [{ id: 'j1', profileId: profileA }, { id: 'j2', profileId: profileB }];
    const visible = await filterByProfileScope(db, identity, jobs, (j) => j.profileId);
    expect(visible.map((j) => j.id)).toEqual(['j1']);
  });
});
