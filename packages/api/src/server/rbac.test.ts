/**
 * RBAC integration tests: live HTTP server, real database.
 *
 * Covers the Phase 3 enforcement seams: cross-client denial, permission
 * denial, scope narrowing, disabled/revoked identities, the invitation
 * lifecycle, audit entries, and legacy-token backwards compatibility.
 * One real Chromium launch proves a scoped operator keeps the happy path.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './index.js';

interface ErrorBody {
  error: { code: string; message: string };
}

interface ApiResult<T> {
  status: number;
  json: T;
}

const DIR = mkdtempSync(join(tmpdir(), 'multiloger-rbac-test-'));
let server: RunningServer;
let base = '';
let bootstrap = '';

async function api<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  let raw: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    raw = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(raw !== undefined ? { body: raw } : {}),
  });
  const rawJson: unknown = await res.json().catch((): null => null);
  return { status: res.status, json: rawJson as T };
}

interface UserShape {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  roles: string[];
}

interface ProfileShape {
  id: string;
  clientId: string;
  name: string;
  state: string;
}

let clientA = '';
let clientB = '';
let profileA = '';
let profileB = '';
let operatorId = '';
let operatorToken = '';
let viewerToken = '';

async function loginAs(email: string, password: string): Promise<string> {
  const { status, json } = await api<{ token: { token: string } }>('POST', '/v1/auth/login', null, {
    email,
    password,
  });
  expect(status).toBe(201);
  return json.token.token;
}

beforeAll(async () => {
  server = await startServer({
    dbPath: join(DIR, 'api.db'),
    dataDir: join(DIR, 'profiles'),
    port: 0,
    resources: { checkDiskBeforeLaunch: false },
  });
  base = `http://127.0.0.1:${String(server.port)}`;
  bootstrap = server.bootstrapToken ?? '';
  expect(bootstrap).toMatch(/^mlt_/);

  // Two clients with one profile each (legacy bootstrap: full access).
  clientA = (
    await api<{ client: { id: string } }>('POST', '/v1/clients', bootstrap, { name: 'Client A' })
  ).json.client.id;
  clientB = (
    await api<{ client: { id: string } }>('POST', '/v1/clients', bootstrap, { name: 'Client B' })
  ).json.client.id;
  profileA = (
    await api<{ profile: ProfileShape }>('POST', '/v1/profiles', bootstrap, {
      clientId: clientA,
      name: 'pa',
    })
  ).json.profile.id;
  profileB = (
    await api<{ profile: ProfileShape }>('POST', '/v1/profiles', bootstrap, {
      clientId: clientB,
      name: 'pb',
    })
  ).json.profile.id;

  // Operator user scoped to client A; viewer scoped to client A.
  const op = await api<{ user: UserShape }>('POST', '/v1/users', bootstrap, {
    name: 'Op',
    email: 'op@example.com',
    password: 'operator-password-1',
    roleIds: ['operator'],
  });
  expect(op.status).toBe(201);
  operatorId = op.json.user.id;
  await api('POST', `/v1/users/${operatorId}/clients`, bootstrap, { clientId: clientA });
  operatorToken = await loginAs('op@example.com', 'operator-password-1');

  const viewer = await api<{ user: UserShape }>('POST', '/v1/users', bootstrap, {
    name: 'Viewer',
    email: 'viewer@example.com',
    password: 'viewer-password-12',
    roleIds: ['viewer'],
  });
  const viewerId = viewer.json.user.id;
  await api('POST', `/v1/users/${viewerId}/clients`, bootstrap, { clientId: clientA });
  viewerToken = await loginAs('viewer@example.com', 'viewer-password-12');
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('RBAC (live)', () => {
  it('reports the identity via /v1/auth/me', async () => {
    const { status, json } = await api<{
      identity: {
        kind: string;
        legacy: boolean;
        isAdmin: boolean;
        permissions: string[];
        user: UserShape;
      };
    }>('GET', '/v1/auth/me', operatorToken);
    expect(status).toBe(200);
    expect(json.identity.kind).toBe('user');
    expect(json.identity.legacy).toBe(false);
    expect(json.identity.isAdmin).toBe(false);
    expect(json.identity.permissions).toContain('profiles:launch');
    expect(json.identity.permissions).not.toContain('users:manage');
    expect(json.identity.user.email).toBe('op@example.com');

    const legacy = await api<{ identity: { kind: string; legacy: boolean; isAdmin: boolean } }>(
      'GET',
      '/v1/auth/me',
      bootstrap,
    );
    expect(legacy.json.identity.kind).toBe('legacy');
    expect(legacy.json.identity.legacy).toBe(true);
  });

  it('denies cross-client access (403) while allowing scoped access', async () => {
    // List is scoped: only client A's profile is visible.
    const listed = await api<{ profiles: ProfileShape[] }>('GET', '/v1/profiles', operatorToken);
    expect(listed.status).toBe(200);
    expect(listed.json.profiles.map((p) => p.id).sort()).toEqual([profileA]);

    const clients = await api<{ clients: { id: string }[] }>('GET', '/v1/clients', operatorToken);
    expect(clients.json.clients.map((c) => c.id)).toEqual([clientA]);

    // Direct access to client B's profile is denied, not "not found".
    const denied = await api<ErrorBody>('GET', `/v1/profiles/${profileB}`, operatorToken);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('FORBIDDEN');

    // Scoped access works.
    const allowed = await api<{ profile: ProfileShape }>(
      'GET',
      `/v1/profiles/${profileA}`,
      operatorToken,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.json.profile.id).toBe(profileA);

    // Truly missing profiles are still 404 (denial never leaks existence).
    const missing = await api<ErrorBody>('GET', '/v1/profiles/does-not-exist', operatorToken);
    expect(missing.status).toBe(404);
  });

  it('denies launching an out-of-scope profile before touching Chromium', async () => {
    const { status, json } = await api<ErrorBody>(
      'POST',
      `/v1/profiles/${profileB}/launch`,
      operatorToken,
    );
    expect(status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('denies creating profiles in an out-of-scope client', async () => {
    const { status, json } = await api<ErrorBody>('POST', '/v1/profiles', operatorToken, {
      clientId: clientB,
      name: 'sneaky',
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('denies actions the role lacks (viewer cannot create profiles)', async () => {
    const denied = await api<ErrorBody>('POST', '/v1/profiles', viewerToken, {
      clientId: clientA,
      name: 'nope',
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('FORBIDDEN');

    const allowed = await api<{ profiles: ProfileShape[] }>('GET', '/v1/profiles', viewerToken);
    expect(allowed.status).toBe(200);
    expect(allowed.json.profiles.map((p) => p.id)).toEqual([profileA]);
  });

  it('denies user management without users:manage', async () => {
    const { status, json } = await api<ErrorBody>('POST', '/v1/users', viewerToken, {
      name: 'X',
      email: 'x@example.com',
      password: 'x-password-12345',
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('lets a scoped operator launch and stop their profile', async () => {
    const launched = await api<{ profile: ProfileShape }>(
      'POST',
      `/v1/profiles/${profileA}/launch`,
      operatorToken,
    );
    expect(launched.status).toBe(200);
    expect(launched.json.profile.state).toBe('running');
    const stopped = await api<{ profile: ProfileShape }>(
      'POST',
      `/v1/profiles/${profileA}/stop`,
      operatorToken,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.json.profile.state).toBe('stopped');
  }, 90_000);

  it('narrows tokens through scopes: read-only token cannot stop', async () => {
    const created = await api<{ token: string }>('POST', '/v1/tokens', bootstrap, {
      name: 'read-only',
      userId: operatorId,
      scopes: ['profiles:read'],
    });
    expect(created.status).toBe(201);
    const readOnly = created.json.token;

    const listed = await api<{ profiles: ProfileShape[] }>('GET', '/v1/profiles', readOnly);
    expect(listed.status).toBe(200);

    const denied = await api<ErrorBody>('POST', `/v1/profiles/${profileA}/stop`, readOnly);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('FORBIDDEN');
  });

  it('refuses self-issued tokens with scopes the user does not hold', async () => {
    const { status, json } = await api<ErrorBody>('POST', '/v1/tokens', operatorToken, {
      name: 'escalation',
      scopes: ['users:manage'],
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('rejects unknown scope keys', async () => {
    const { status, json } = await api<ErrorBody>('POST', '/v1/tokens', bootstrap, {
      name: 'bad-scopes',
      scopes: ['nope:not-real'],
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('fails closed for disabled users (401 on login and on token use)', async () => {
    const disabled = await api<{ user: UserShape }>('PATCH', `/v1/users/${operatorId}`, bootstrap, {
      disabled: true,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.json.user.disabled).toBe(true);

    const login = await api<ErrorBody>('POST', '/v1/auth/login', null, {
      email: 'op@example.com',
      password: 'operator-password-1',
    });
    expect(login.status).toBe(401);
    expect(login.json.error.code).toBe('INVALID_CREDENTIALS');

    const use = await api<ErrorBody>('GET', '/v1/profiles', operatorToken);
    expect(use.status).toBe(401);
    expect(use.json.error.code).toBe('UNAUTHORIZED');

    // Re-enable for the remaining tests.
    const reenabled = await api<{ user: UserShape }>(
      'PATCH',
      `/v1/users/${operatorId}`,
      bootstrap,
      {
        disabled: false,
      },
    );
    expect(reenabled.status).toBe(200);
    operatorToken = await loginAs('op@example.com', 'operator-password-1');
  });

  it('rejects revoked tokens with 401', async () => {
    const created = await api<{ id: string; token: string }>('POST', '/v1/tokens', bootstrap, {
      name: 'doomed',
    });
    const doomed = created.json.token;
    const revoked = await api('POST', `/v1/tokens/${created.json.id}/revoke`, bootstrap);
    expect(revoked.status).toBe(200);
    const use = await api<ErrorBody>('GET', '/v1/profiles', doomed);
    expect(use.status).toBe(401);
  });

  it('rejects wrong passwords without distinguishing unknown users', async () => {
    const wrong = await api<ErrorBody>('POST', '/v1/auth/login', null, {
      email: 'op@example.com',
      password: 'wrong-password-xyz',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await api<ErrorBody>('POST', '/v1/auth/login', null, {
      email: 'nobody-here@example.com',
      password: 'wrong-password-xyz',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('runs the invitation lifecycle: create → redeem → login', async () => {
    const created = await api<{ invitation: { id: string; email: string }; token: string }>(
      'POST',
      '/v1/invitations',
      bootstrap,
      { email: 'newbie@example.com', roleId: 'viewer', clientIds: [clientA] },
    );
    expect(created.status).toBe(201);
    expect(created.json.token).toMatch(/^mli_/);
    const inviteToken = created.json.token;

    const redeemed = await api<{ user: { userId: string; email: string; roles: string[] } }>(
      'POST',
      '/v1/invitations/redeem',
      null,
      { token: inviteToken, name: 'Newbie', password: 'newbie-password-1' },
    );
    expect(redeemed.status).toBe(201);
    expect(redeemed.json.user.email).toBe('newbie@example.com');
    expect(redeemed.json.user.roles).toEqual(['viewer']);

    // The invitee can log in and sees the granted client scope.
    const token = await loginAs('newbie@example.com', 'newbie-password-1');
    const listed = await api<{ profiles: ProfileShape[] }>('GET', '/v1/profiles', token);
    expect(listed.status).toBe(200);
    expect(listed.json.profiles.map((p) => p.id)).toEqual([profileA]);

    // Double redeem is rejected.
    const again = await api<ErrorBody>('POST', '/v1/invitations/redeem', null, {
      token: inviteToken,
      name: 'Newbie',
      password: 'newbie-password-1',
    });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe('INVITATION_INVALID');
  });

  it('rejects expired and malformed invitation tokens', async () => {
    const created = await api<{ token: string }>('POST', '/v1/invitations', bootstrap, {
      email: 'late@example.com',
      roleId: 'viewer',
      expiresInHours: 0.00001, // ~36ms
    });
    expect(created.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const expired = await api<ErrorBody>('POST', '/v1/invitations/redeem', null, {
      token: created.json.token,
      name: 'Late',
      password: 'late-password-1234',
    });
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe('INVITATION_EXPIRED');

    const malformed = await api<ErrorBody>('POST', '/v1/invitations/redeem', null, {
      token: 'mli_not-a-real-token',
      name: 'Nobody',
      password: 'nobody-password-12',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe('INVITATION_INVALID');
  });

  it('writes audit entries for mutations', async () => {
    const created = await api<{ client: { id: string } }>('POST', '/v1/clients', bootstrap, {
      name: 'Audited Client',
    });
    expect(created.status).toBe(201);

    const log = await api<{
      entries: { action: string; actorType: string; entityType: string; entityId: string }[];
      total: number;
    }>('GET', '/v1/audit-log?action=client.create&limit=5', bootstrap);
    expect(log.status).toBe(200);
    const entry = log.json.entries.find((e) => e.entityId === created.json.client.id);
    expect(entry).toBeDefined();
    expect(entry?.actorType).toBe('token'); // legacy bootstrap token
    expect(entry?.entityType).toBe('client');

    // Non-admins only ever see their own actions. (Give the operator the
    // viewer role first so its token may hold audit:read.)
    await api('POST', `/v1/users/${operatorId}/roles`, bootstrap, { roleId: 'viewer' });
    const scoped = await api<{ token: string }>('POST', '/v1/tokens', bootstrap, {
      name: 'audit-scoped',
      userId: operatorId,
      scopes: ['profiles:read', 'audit:read'],
    });
    const own = await api<{ entries: { actorId: string }[] }>(
      'GET',
      '/v1/audit-log?limit=200',
      scoped.json.token,
    );
    expect(own.status).toBe(200);
    for (const e of own.json.entries) {
      expect(e.actorId).toBe(operatorId);
    }
  });

  it('guards the last admin', async () => {
    const admin = await api<{ user: UserShape }>('POST', '/v1/users', bootstrap, {
      name: 'Admin',
      email: 'admin@example.com',
      password: 'admin-password-123',
      roleIds: ['admin'],
    });
    const adminId = admin.json.user.id;

    const removeRole = await api<ErrorBody>(
      'DELETE',
      `/v1/users/${adminId}/roles/admin`,
      bootstrap,
    );
    expect(removeRole.status).toBe(400);

    const disable = await api<ErrorBody>('PATCH', `/v1/users/${adminId}`, bootstrap, {
      disabled: true,
    });
    expect(disable.status).toBe(400);

    const del = await api<ErrorBody>('DELETE', `/v1/users/${adminId}`, bootstrap);
    expect(del.status).toBe(400);
  });

  it('prevents self-disable and self-delete', async () => {
    const admin = await api<{ user: UserShape }>('POST', '/v1/users', bootstrap, {
      name: 'Admin2',
      email: 'admin2@example.com',
      password: 'admin2-password-12',
      roleIds: ['admin'],
    });
    const token = await loginAs('admin2@example.com', 'admin2-password-12');
    const me = await api<{ identity: { userId: string } }>('GET', '/v1/auth/me', token);
    const selfId = me.json.identity.userId;

    const disable = await api<ErrorBody>('PATCH', `/v1/users/${selfId}`, token, { disabled: true });
    expect(disable.status).toBe(400);

    const del = await api<ErrorBody>('DELETE', `/v1/users/${selfId}`, token);
    expect(del.status).toBe(400);
    expect(admin.json.user.id).toBe(selfId);
  });

  it('lets users change their own password', async () => {
    const changed = await api<{ changed: boolean }>('POST', '/v1/auth/password', operatorToken, {
      currentPassword: 'operator-password-1',
      newPassword: 'operator-password-2!',
    });
    expect(changed.status).toBe(200);

    const oldLogin = await api<ErrorBody>('POST', '/v1/auth/login', null, {
      email: 'op@example.com',
      password: 'operator-password-1',
    });
    expect(oldLogin.status).toBe(401);

    operatorToken = await loginAs('op@example.com', 'operator-password-2!');
  });

  it('keeps legacy (unattributed) tokens fully working', async () => {
    // The bootstrap token created users, clients, profiles, tokens, and
    // invitations above — every Phase 3 seam stays open for legacy tokens.
    const me = await api<{ identity: { legacy: boolean } }>('GET', '/v1/auth/me', bootstrap);
    expect(me.json.identity.legacy).toBe(true);
    const listed = await api<{ profiles: ProfileShape[] }>('GET', '/v1/profiles', bootstrap);
    expect(listed.json.profiles.length).toBeGreaterThanOrEqual(2);
  });
});

describe('cloud sync RBAC (live)', () => {
  it('denies the mutating cloud-sync routes for viewers (403)', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/v1/cloud-sync/config'],
      [
        'PUT',
        '/v1/cloud-sync/config',
        {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          accessKeySecretName: 'a',
          secretKeySecretName: 's',
        },
      ],
      ['POST', '/v1/cloud-sync/sync'],
      ['POST', '/v1/cloud-sync/restore', { key: 'multiloger/x.mlbackup', name: 'x' }],
      ['POST', '/v1/cloud-sync/prune'],
    ];
    for (const [method, path, body] of calls) {
      const { status } = await api<ErrorBody>(method, path, viewerToken, body);
      expect(`${method} ${path} → ${String(status)}`).toBe(`${method} ${path} → 403`);
    }
  });

  it('lets viewers list remote objects (backups:read) but reports not-configured', async () => {
    const { status, json } = await api<ErrorBody>('GET', '/v1/cloud-sync/objects', viewerToken);
    expect(status).toBe(409);
    expect(json.error.code).toBe('CLOUD_SYNC_NOT_CONFIGURED');
  });

  it('reports not-configured to an operator (409 CLOUD_SYNC_NOT_CONFIGURED)', async () => {
    const { status, json } = await api<ErrorBody>('GET', '/v1/cloud-sync/config', operatorToken);
    expect(status).toBe(409);
    expect(json.error.code).toBe('CLOUD_SYNC_NOT_CONFIGURED');
  });

  it('rejects insecure endpoints through the API (400)', async () => {
    const { status, json } = await api<ErrorBody>('PUT', '/v1/cloud-sync/config', operatorToken, {
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'test-bucket',
      accessKeySecretName: 's3-access-key-id',
      secretKeySecretName: 's3-secret-access-key',
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe('CLOUD_SYNC_ERROR');
  });
});

describe('window sync RBAC (live)', () => {
  it('denies window sync for viewers (403)', async () => {
    const { status } = await api<ErrorBody>('POST', '/v1/window-sync', viewerToken, {
      profileIds: [profileA],
      url: 'https://example.com/',
    });
    expect(status).toBe(403);
  });

  it('denies cross-client profiles before touching any browser (403)', async () => {
    // profileB belongs to client B; the operator is scoped to client A.
    const { status } = await api<ErrorBody>('POST', '/v1/window-sync', operatorToken, {
      profileIds: [profileB],
      url: 'https://example.com/',
    });
    expect(status).toBe(403);
  });

  it('rejects invalid URLs (400)', async () => {
    const { status, json } = await api<ErrorBody>('POST', '/v1/window-sync', operatorToken, {
      profileIds: [profileA],
      url: 'javascript:alert(1)',
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe('WINDOW_SYNC_INVALID_URL');
  });

  it('requires a non-empty profile list (400)', async () => {
    const { status } = await api<ErrorBody>('POST', '/v1/window-sync', operatorToken, {
      profileIds: [],
      url: 'https://example.com/',
    });
    expect(status).toBe(400);
  });

  it('404s on unknown profiles', async () => {
    const { status } = await api<ErrorBody>('POST', '/v1/window-sync', operatorToken, {
      profileIds: ['no-such-profile'],
      url: 'https://example.com/',
    });
    expect(status).toBe(404);
  });

  it('reports stopped profiles as failed instead of throwing', async () => {
    // Neither profile is running in this test (no Chromium launched).
    const { status, json } = await api<{
      synced: string[];
      failed: { profileId: string; error: string }[];
    }>('POST', '/v1/window-sync', operatorToken, {
      profileIds: [profileA],
      url: 'https://example.com/',
    });
    expect(status).toBe(200);
    expect(json.synced).toEqual([]);
    expect(json.failed).toEqual([{ profileId: profileA, error: 'profile is not running' }]);
  });
});
