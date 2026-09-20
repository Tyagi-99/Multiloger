/**
 * Proves the API server wires the dashboard bundle: with webDir set, the
 * built web app is served at / without auth while /v1/* stays token-gated.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './index.js';

const DIR = mkdtempSync(join(tmpdir(), 'ml-static-serving-'));
const WEB = join(DIR, 'web');
let server: RunningServer;
let base = '';

async function get(
  path: string,
  token: string | null,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpGet(
      `${base}${path}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', (): void => {
          const contentType = res.headers['content-type'];
          resolvePromise({
            status: res.statusCode ?? 0,
            body,
            contentType: typeof contentType === 'string' ? contentType : '',
          });
        });
      },
    );
    req.on('error', reject);
  });
}

async function headRequest(
  path: string,
): Promise<{ status: number; body: string; contentLength: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(`${base}${path}`, { method: 'HEAD' }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', (): void => {
        const contentLength = res.headers['content-length'];
        resolvePromise({
          status: res.statusCode ?? 0,
          body,
          contentLength: typeof contentLength === 'string' ? contentLength : '',
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  mkdirSync(join(WEB, 'assets'), { recursive: true });
  writeFileSync(join(WEB, 'index.html'), '<html><body>dashboard</body></html>');
  writeFileSync(join(WEB, 'assets', 'app.js'), 'console.log("app")');
  server = await startServer({
    dbPath: join(DIR, 'api.db'),
    dataDir: join(DIR, 'profiles'),
    port: 0,
    webDir: WEB,
    resources: { checkDiskBeforeLaunch: false },
  });
  base = `http://127.0.0.1:${String(server.port)}`;
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('dashboard static serving', () => {
  it('serves index.html at / without auth', async () => {
    const res = await get('/', null);
    expect(res.status).toBe(200);
    expect(res.body).toContain('dashboard');
    expect(res.contentType).toContain('text/html');
  });

  it('serves hashed assets', async () => {
    const res = await get('/assets/app.js', null);
    expect(res.status).toBe(200);
    expect(res.body).toContain('console.log("app")');
  });

  it('falls back to index.html for unknown non-API paths', async () => {
    const res = await get('/profiles/some-id', null);
    expect(res.status).toBe(200);
    expect(res.body).toContain('dashboard');
  });

  it('keeps /v1/* token-gated', async () => {
    const res = await get('/v1/resources', null);
    expect(res.status).toBe(401);
  });

  it('answers 404 JSON for unknown API routes', async () => {
    const res = await get('/v1/nope', server.bootstrapToken ?? '');
    expect(res.status).toBe(404);
    expect(res.body).toContain('NOT_FOUND');
  });

  it('answers HEAD with headers and no body', async () => {
    const headRes = await headRequest('/assets/app.js');
    const got = await get('/assets/app.js', null);
    expect(headRes.status).toBe(200);
    expect(headRes.body).toBe('');
    expect(headRes.contentLength).toBe(String(Buffer.byteLength(got.body)));
  });
});
