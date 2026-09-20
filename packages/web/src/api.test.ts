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
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API token' } }),
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
    expect(seen).toEqual(['GET /v1/profiles/profile-1/backups', 'POST /v1/backups/backup-1/verify']);
  });
});
