/**
 * Static file serving for the production dashboard bundle (Task 10).
 *
 * When the API server is started with `webDir` pointing at the built web
 * `dist/` directory, GET/HEAD requests that are NOT API routes are served
 * from disk: `/` and unknown paths fall back to `index.html` (SPA), known
 * files are served with a content type. Anything under `/v1/` or `/health`
 * is never served from disk — those belong to the API router.
 *
 * Path traversal is blocked by construction: the requested path is
 * normalized and resolved against webDir, and anything that escapes webDir
 * resolves to null (the router then answers 404).
 */

import { createReadStream, promises as fs } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface ResolvedStatic {
  filePath: string;
  contentType: string;
  /** True when this is the SPA fallback rather than the requested file. */
  fallback: boolean;
}

/**
 * Decide whether a pathname should be served from webDir and which file
 * that is. Pure: no I/O, so it is unit-testable. Returns null when the
 * router should handle the request instead.
 */
export function resolveStaticFile(webDir: string, pathname: string): ResolvedStatic | null {
  if (pathname === '/health' || pathname.startsWith('/v1/') || pathname === '/v1') {
    return null;
  }
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding: serve nothing.
    return null;
  }
  // Strip the leading slash, normalize away `.`/`..`, and resolve against root.
  const stripped = normalize(decoded.replace(/^\/+/, ''));
  const relative = stripped === '' || stripped === '.' ? 'index.html' : stripped;
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    // Escapes webDir: do not serve anything.
    return null;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  return { filePath, contentType, fallback: false };
}

/**
 * Decide which file on disk to serve for a resolved static request: the
 * requested file when it exists, otherwise index.html (SPA fallback).
 * Returns null when neither exists.
 */
export async function findStaticFile(
  webDir: string,
  resolved: ResolvedStatic,
): Promise<{ filePath: string; contentType: string; fallback: boolean } | null> {
  const extOf = (filePath: string): string => {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
  };
  try {
    const stat = await fs.stat(resolved.filePath);
    if (!stat.isDirectory()) {
      return { filePath: resolved.filePath, contentType: extOf(resolved.filePath), fallback: false };
    }
  } catch {
    // Fall through to the SPA fallback.
  }
  const indexPath = join(resolve(webDir), 'index.html');
  try {
    const stat = await fs.stat(indexPath);
    if (!stat.isDirectory()) {
      return { filePath: indexPath, contentType: extOf(indexPath), fallback: true };
    }
  } catch {
    return null;
  }
  return null;
}

/** Stream a file found by findStaticFile to the response. */
export async function serveStaticFile(
  res: ServerResponse,
  found: { filePath: string; contentType: string; fallback: boolean },
): Promise<void> {
  res.writeHead(200, {
    'content-type': found.contentType,
    'cache-control': found.fallback ? 'no-cache' : 'public, max-age=3600',
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(found.filePath);
    stream.on('error', reject);
    res.on('error', reject);
    stream.pipe(res);
    stream.on('end', (): void => {
      resolvePromise();
    });
  });
}
