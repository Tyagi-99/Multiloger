/**
 * Tests for the API client: URL/header/body wiring and error mapping.
 * fetch is stubbed; no network involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (req: CapturedRequest) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => Promise.resolve(handler({ url, init }))),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('prefixes the base URL and sends the bearer token', async () => {
    let captured: CapturedRequest | undefined;
    stubFetch((req) => {
      captured = req;
      return jsonResponse(200, { ok: true });
    });
    const client = createApiClient('http://api:3000', () => 'mlt_secret');
    const res = await client.get<{ ok: boolean }>('/v1/resources');
    expect(res.ok).toBe(true);
    expect(captured?.url).toBe('http://api:3000/v1/resources');
    expect((captured?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer mlt_secret',
    );
  });

  it('omits the authorization header when there is no token', async () => {
    let captured: CapturedRequest | undefined;
    stubFetch((req) => {
      captured = req;
      return jsonResponse(200, {});
    });
    const client = createApiClient('', () => null);
    await client.get('/v1/resources');
    const headers = (captured?.init.headers ?? {}) as Record<string, string>;
    expect('authorization' in headers).toBe(false);
  });

  it('serializes JSON bodies with a content-type header', async () => {
    let captured: CapturedRequest | undefined;
    stubFetch((req) => {
      captured = req;
      return jsonResponse(201, {});
    });
    const client = createApiClient('', () => 'mlt_secret');
    await client.post('/v1/clients', { name: 'acme' });
    expect(captured?.init.method).toBe('POST');
    expect((captured?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(captured?.init.body).toBe(JSON.stringify({ name: 'acme' }));
  });

  it('throws ApiError with the server code on HTTP errors', async () => {
    stubFetch(() =>
      jsonResponse(401, {
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API token' },
      }),
    );
    const client = createApiClient('', () => 'bad');
    const error = await client.get('/v1/profiles').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe('UNAUTHORIZED');
  });

  it('throws NETWORK_ERROR when fetch itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused'))),
    );
    const client = createApiClient('', () => 'mlt_secret');
    const error = await client.get('/v1/profiles').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('exposes typed resource helpers', async () => {
    const seen: string[] = [];
    stubFetch((req) => {
      seen.push(`${String(req.init.method)} ${req.url}`);
      return jsonResponse(200, { backups: [] });
    });
    const client = createApiClient('', () => 'mlt_secret');
    await client.listBackups('profile-1');
    await client.verifyBackup('backup-1');
    expect(seen).toEqual([
      'GET /v1/profiles/profile-1/backups',
      'POST /v1/backups/backup-1/verify',
    ]);
  });

  it('wires the team endpoints with the right paths and bodies', async () => {
    const seen: { method: string; url: string; body: unknown }[] = [];
    stubFetch((req) => {
      seen.push({
        method: String(req.init.method),
        url: req.url,
        body: req.init.body === undefined ? undefined : JSON.parse(req.init.body as string),
      });
      return jsonResponse(200, { ok: true });
    });
    const client = createApiClient('', () => 'mlt_secret');

    await client.getIdentity();
    await client.listUsers();
    await client.createUser({
      name: 'N',
      email: 'n@example.com',
      password: 'long-password-1',
      roleIds: ['viewer'],
    });
    await client.updateUser('u1', { disabled: true });
    await client.deleteUser('u1');
    await client.assignRole('u1', 'operator');
    await client.removeRole('u1', 'operator');
    await client.grantClientAccess('u1', 'c1');
    await client.revokeClientAccess('u1', 'c1');
    await client.grantProfileAccess('u1', 'p1');
    await client.revokeProfileAccess('u1', 'p1');
    await client.getUserScopes('u1');
    await client.listUserTokens('u1');
    await client.issueUserToken('u1', 'agent', ['profiles:read']);
    await client.listRoles();
    await client.createRole({ id: 'support', name: 'Support', permissions: ['profiles:read'] });
    await client.deleteRole('support');
    await client.listInvitations();
    await client.createInvitation({ email: 'i@example.com', roleId: 'viewer' });
    await client.revokeInvitation('inv1');
    await client.queryAuditLog({ action: 'profile.launch', limit: 10, offset: 20 });

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v1/auth/me',
      'GET /v1/users',
      'POST /v1/users',
      'PATCH /v1/users/u1',
      'DELETE /v1/users/u1',
      'POST /v1/users/u1/roles',
      'DELETE /v1/users/u1/roles/operator',
      'POST /v1/users/u1/clients',
      'DELETE /v1/users/u1/clients/c1',
      'POST /v1/users/u1/profiles',
      'DELETE /v1/users/u1/profiles/p1',
      'GET /v1/users/u1/scopes',
      'GET /v1/users/u1/tokens',
      'POST /v1/users/u1/tokens',
      'GET /v1/roles',
      'POST /v1/roles',
      'DELETE /v1/roles/support',
      'GET /v1/invitations',
      'POST /v1/invitations',
      'POST /v1/invitations/inv1/revoke',
      'GET /v1/audit-log?action=profile.launch&limit=10&offset=20',
    ]);
    expect(seen[2]?.body).toEqual({
      name: 'N',
      email: 'n@example.com',
      password: 'long-password-1',
      roleIds: ['viewer'],
    });
    expect(seen[13]?.body).toEqual({ name: 'agent', scopes: ['profiles:read'] });
  });

  it('loginWithPassword posts to /v1/auth/login and unwraps the token', async () => {
    let capturedBody: unknown;
    stubFetch((req) => {
      capturedBody = JSON.parse(req.init.body as string);
      // No Authorization header when logging in with a password.
      expect((req.init.headers as Record<string, string>).authorization ?? null).toBe(null);
      return jsonResponse(201, {
        user: { id: 'u1' },
        token: { id: 't1', name: 'login', token: 'mlt_secret', createdAt: 'x' },
      });
    });
    const client = createApiClient('', () => null);
    const res = await client.loginWithPassword('op@example.com', 'password-1');
    expect(res).toEqual({ token: 'mlt_secret' });
    expect(capturedBody).toEqual({ email: 'op@example.com', password: 'password-1' });
  });
});

describe('windowSync client', () => {
  it('POSTs profile ids and URL to /v1/window-sync and returns the result', async () => {
    let captured: CapturedRequest | undefined;
    stubFetch((req) => {
      captured = req;
      return jsonResponse(200, {
        synced: ['p1'],
        failed: [{ profileId: 'p2', error: 'profile is not running' }],
      });
    });
    const client = createApiClient('http://api:3000', () => 'mlt_secret');
    const result = await client.windowSync(['p1', 'p2'], 'https://example.com/');
    expect(captured?.url).toBe('http://api:3000/v1/window-sync');
    expect(captured?.init.method).toBe('POST');
    expect(JSON.parse(captured?.init.body as string)).toEqual({
      profileIds: ['p1', 'p2'],
      url: 'https://example.com/',
    });
    expect(result.synced).toEqual(['p1']);
    expect(result.failed).toEqual([{ profileId: 'p2', error: 'profile is not running' }]);
  });
});
