/**
 * Tests for static dashboard serving: routing decisions, traversal guards,
 * real file delivery, and the SPA fallback.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findStaticFile, resolveStaticFile, serveStaticFile } from './static.js';

describe('resolveStaticFile', () => {
  const webDir = '/srv/multiloger/web';

  it('maps / to index.html', () => {
    const resolved = resolveStaticFile(webDir, '/');
    expect(resolved?.filePath).toBe(join(webDir, 'index.html'));
    expect(resolved?.contentType).toContain('text/html');
  });

  it('maps asset paths with content types', () => {
    const resolved = resolveStaticFile(webDir, '/assets/index-abc.js');
    expect(resolved?.filePath).toBe(join(webDir, 'assets', 'index-abc.js'));
    expect(resolved?.contentType).toContain('javascript');
  });

  it('never serves API paths from disk', () => {
    expect(resolveStaticFile(webDir, '/v1/profiles')).toBeNull();
    expect(resolveStaticFile(webDir, '/v1/events')).toBeNull();
    expect(resolveStaticFile(webDir, '/v1')).toBeNull();
    expect(resolveStaticFile(webDir, '/health')).toBeNull();
  });

  it('blocks path traversal outside webDir', () => {
    expect(resolveStaticFile(webDir, '/../etc/passwd')).toBeNull();
    expect(resolveStaticFile(webDir, '/assets/../../secret')).toBeNull();
    // Encoded traversal is decoded before the containment check.
    expect(resolveStaticFile(webDir, '/..%2f..%2fetc')).toBeNull();
    expect(resolveStaticFile(webDir, '/%2e%2e/%2e%2e/x')).toBeNull();
  });
});

describe('serveStaticFile over HTTP', () => {
  it('serves files, falls back to index.html for SPA routes, and 404s API paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlweb-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<html>dashboard</html>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const resolved = resolveStaticFile(dir, pathname);
      if (!resolved) {
        res.writeHead(404).end('no route');
        return;
      }
      void findStaticFile(dir, resolved).then((found): void => {
        if (!found) {
          res.writeHead(404).end('no route');
          return;
        }
        void serveStaticFile(res, found).catch(() => {
          res.destroy();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const get = (path: string): Promise<{ status: number; body: string; contentType: string }> =>
      new Promise((resolvePromise, reject) => {
        httpGet(`http://127.0.0.1:${String(port)}${path}`, (res) => {
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
        }).on('error', reject);
      });

    try {
      const index = await get('/');
      expect(index.status).toBe(200);
      expect(index.body).toContain('dashboard');
      expect(index.contentType).toContain('text/html');

      const asset = await get('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.body).toContain('console.log(1)');
      expect(asset.contentType).toContain('javascript');

      const spaFallback = await get('/some/client/route');
      expect(spaFallback.status).toBe(200);
      expect(spaFallback.body).toContain('dashboard');

      const apiPath = await get('/v1/profiles');
      expect(apiPath.status).toBe(404);

      const traversal = await get('/..%2f..%2fetc%2fpasswd');
      expect(traversal.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close((): void => {
        resolve();
      }));
    }
  });

  it('returns null when webDir has no index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mlweb-empty-'));
    const resolved = resolveStaticFile(dir, '/missing.js');
    expect(resolved).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const found = await findStaticFile(dir, resolved!);
    expect(found).toBeNull();
  });
});
