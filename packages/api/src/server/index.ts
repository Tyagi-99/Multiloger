/**
 * Multiloger API server (Task 7).
 *
 * Dependency-free node:http server:
 * - POST-less public /health; everything else needs a Bearer `mlt_` token.
 * - Token-bucket rate limiting: generous per-token, strict per-IP for
 *   anonymous traffic (blunts token brute-forcing).
 * - Structured JSON errors; request log lines carry method/path/status/
 *   duration/token-id — never Authorization values, never request bodies.
 * - Authenticated WebSocket hub at /v1/events broadcasting profile domain
 *   events (state changes, lock events) to dashboard clients.
 * - First start with an empty token table prints a bootstrap token ONCE.
 *   Anyone with server-log access can read it: protect the logs, rotate
 *   the token afterwards (POST /v1/tokens, then revoke the bootstrap).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import type { DatabaseSchema } from '../db/schema.js';
import { reconcileOnBoot } from '../browser/reaper.js';
import { profileEvents } from '../profiles/events.js';
import { ProfileManager } from '../profiles/manager.js';
import { getState } from '../profiles/stateMachine.js';
import { ResourceManager, type ResourceManagerOptions } from '../resources/manager.js';
import { BackupService } from '../backups/service.js';
import { findStaticFile, resolveStaticFile, serveStaticFile } from './static.js';
import { resolveProxyAuthForLaunch, resolveProxyForLaunch } from '../proxies/service.js';
import { resolveVaultPath } from '../vault/index.js';
import { authenticateRequest, createApiToken } from './tokens.js';
import { TokenBucketLimiter, type RateLimitOptions } from './rateLimit.js';
import { buildRoutes } from './routes.js';
import { httpErrorBody, toHttpError } from './errors.js';
import { matchRoute, readJsonBody, sendJson, type Route, type RouteContext } from './router.js';
import { WsHub } from './websocket.js';

export interface ServerOptions {
  dbPath: string;
  dataDir: string;
  host?: string;
  port?: number;
  chromiumPath?: string;
  headless?: boolean;
  lockTtlMs?: number;
  rateLimit?: RateLimitOptions;
  anonymousRateLimit?: RateLimitOptions;
  /**
   * Resource governor (Task 8). Always constructed; defaults are
   * conservative (max 4 concurrent, 1 GiB disk watermark, idle shutdown
   * disabled). dataDir and the idle-stop wiring are set by the server.
   */
  resources?: Omit<ResourceManagerOptions, 'dataDir' | 'onIdleProfile'>;
  /**
   * Encrypted backups (Task 9). The key comes from backups.keyHex,
   * backups.keyFile, or the MULTILOGER_BACKUP_KEY / MULTILOGER_BACKUP_KEY_FILE
   * environment variables; backup endpoints answer 503 until one is set.
   */
  backups?: {
    keyHex?: string;
    keyFile?: string;
    backupsDir?: string;
    retention?: number;
  };
  /**
   * Directory holding the built dashboard (Task 10). When set, GET/HEAD
   * requests that match no API route are served from disk (SPA fallback to
   * index.html); /v1/* and /health are never served statically.
   */
  webDir?: string;
}

export interface RunningServer {
  readonly port: number;
  /** The bootstrap token, or null when tokens already existed. */
  readonly bootstrapToken: string | null;
  close(): Promise<void>;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { capacity: 300, refillPerSecond: 5 };
const DEFAULT_ANONYMOUS_RATE_LIMIT: RateLimitOptions = { capacity: 60, refillPerSecond: 1 };

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const db: Kysely<DatabaseSchema> = openDatabase({ path: options.dbPath });
  await migrateToLatest(db);

  if (options.chromiumPath) {
    process.env.CHROMIUM_PATH = options.chromiumPath;
  }

  // The server owns its dataDir: create it at boot so the disk watermark
  // always has a real path to measure (and permission problems surface
  // here, not on the first launch).
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  // Idle shutdown is conservative by construction: only a profile the DB
  // still reports as 'running' is stopped, and the stop itself goes through
  // the manager's normal path (the lock heartbeat keeps the lock fresh).
  // onIdleProfile is assigned after the manager exists (see below).
  const resourceOptions: ResourceManagerOptions = {
    dataDir: options.dataDir,
  };
  // exactOptionalPropertyTypes: only forward overrides that were set.
  const resourceOverrides = options.resources;
  if (resourceOverrides?.maxConcurrent !== undefined) {
    resourceOptions.maxConcurrent = resourceOverrides.maxConcurrent;
  }
  if (resourceOverrides?.queueTimeoutMs !== undefined) {
    resourceOptions.queueTimeoutMs = resourceOverrides.queueTimeoutMs;
  }
  if (resourceOverrides?.idleShutdownMs !== undefined) {
    resourceOptions.idleShutdownMs = resourceOverrides.idleShutdownMs;
  }
  if (resourceOverrides?.minFreeDiskBytes !== undefined) {
    resourceOptions.minFreeDiskBytes = resourceOverrides.minFreeDiskBytes;
  }
  if (resourceOverrides?.checkDiskBeforeLaunch !== undefined) {
    resourceOptions.checkDiskBeforeLaunch = resourceOverrides.checkDiskBeforeLaunch;
  }
  const resources = new ResourceManager(resourceOptions);

  const vaultPath = resolveVaultPath(options.dataDir);
  const manager = new ProfileManager(db, {
    dataDir: options.dataDir,
    headless: options.headless ?? true,
    lockTtlMs: options.lockTtlMs ?? 30_000,
    resolveProxy: (profileId: string) => resolveProxyForLaunch(db, profileId, 5000, { vaultPath }),
    // Authenticated proxies: credentials come only from the vault; the CDP
    // Fetch.continueWithAuth handler is attached after launch and closed on
    // stop/crash. Non-vault credentialed proxies keep failing closed (409).
    resolveProxyAuth: (profileId: string) =>
      resolveProxyAuthForLaunch(db, profileId, { vaultPath }),
    resources,
  });

  // Assigned after construction: the callback needs the manager, and the
  // manager needs the resources object. The idle timer cannot fire before
  // this runs (first tick is >= 1s out and reapIdle no-ops without it).
  const backups = new BackupService({
    db,
    dataDir: options.dataDir,
    ...(options.backups?.keyHex !== undefined ? { keyHex: options.backups.keyHex } : {}),
    ...(options.backups?.keyFile !== undefined ? { keyFile: options.backups.keyFile } : {}),
    ...(options.backups?.backupsDir !== undefined
      ? { backupsDir: options.backups.backupsDir }
      : {}),
    ...(options.backups?.retention !== undefined ? { retention: options.backups.retention } : {}),
    profiles: manager,
  });

  resources.onIdleProfile = (profileId, idleMs) => {
    void (async () => {
      try {
        const state = await getState(db, profileId).catch(() => null);
        if (state !== 'running') {
          return;
        }
        profileEvents.emit({
          type: 'profile.idle-stopped',
          profileId,
          idleMs,
          at: new Date().toISOString(),
        });
        await manager.stopProfile(profileId);
      } catch (error) {
        console.error(
          `[multiloger] idle stop of profile ${profileId} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    })();
  };

  const reconcile = await reconcileOnBoot(db, options.dataDir, options.lockTtlMs ?? 30_000);
  // eslint-disable-next-line no-console
  console.log(
    `[multiloger] boot reconcile: staleLocks=${String(reconcile.staleLocksReaped)} ` +
      `crashed=${String(reconcile.markedCrashed.length)} stopped=${String(reconcile.markedStopped.length)} ` +
      `orphansKilled=${String(reconcile.orphansKilled)}`,
  );

  // Bootstrap: first start with no tokens prints a one-time token.
  let bootstrapToken: string | null = null;
  const existing = await db.selectFrom('api_tokens').select('id').limit(1).execute();
  if (existing.length === 0) {
    const created = await createApiToken(db, 'bootstrap');
    bootstrapToken = created.token;
    // eslint-disable-next-line no-console
    console.log(
      '[multiloger] No API tokens exist — bootstrap token (shown ONCE, protect your logs):',
    );
    // eslint-disable-next-line no-console
    console.log(`[multiloger] ${bootstrapToken}`);
  }

  const routes: Route[] = buildRoutes();
  const authedLimiter = new TokenBucketLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
  const anonymousLimiter = new TokenBucketLimiter(
    options.anonymousRateLimit ?? DEFAULT_ANONYMOUS_RATE_LIMIT,
  );
  const hub = new WsHub();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    let tokenIdForLog = `ip=${clientIp(req)}`;

    const finish = (status: number, logToken = tokenIdForLog): void => {
      const ms = Date.now() - startedAt;
      // Redacted by construction: no headers, no bodies, token id only.
      // eslint-disable-next-line no-console
      console.log(
        `[multiloger] ${method} ${url.pathname} -> ${String(status)} ${String(ms)}ms ${logToken}`,
      );
    };

    try {
      const matched = matchRoute(routes, method, url.pathname);
      if (!matched) {
        if (options.webDir !== undefined && (method === 'GET' || method === 'HEAD')) {
          const resolved = resolveStaticFile(options.webDir, url.pathname);
          if (resolved) {
            const found = await findStaticFile(options.webDir, resolved);
            if (found) {
              await serveStaticFile(res, found, method === 'HEAD');
              finish(res.statusCode);
              return;
            }
          }
        }
        const { status, body } = httpErrorBody(
          404,
          'NOT_FOUND',
          `No route: ${method} ${url.pathname}`,
        );
        sendJson(res, status, body);
        finish(status);
        return;
      }
      const { route, params } = matched;

      if (!route.auth) {
        if (!anonymousLimiter.take(`anon:${clientIp(req)}`)) {
          const retryAfter = anonymousLimiter.retryAfterSeconds(`anon:${clientIp(req)}`);
          sendJson(res, 429, httpErrorBody(429, 'RATE_LIMITED', 'Too many requests').body, {
            'retry-after': String(retryAfter),
          });
          finish(429);
          return;
        }
        const ctx: RouteContext = {
          req,
          res,
          params,
          query: url.searchParams,
          body: undefined,
          token: null,
          db,
          manager,
          dataDir: options.dataDir,
          lockTtlMs: options.lockTtlMs ?? 30_000,
          resources,
          backups,
        };
        await route.handler(ctx);
        finish(res.statusCode);
        return;
      }

      const token = await authenticateRequest(db, req.headers.authorization);
      if (!token) {
        // Failed auth burns the strict anonymous budget (brute-force blunting).
        const key = `anon:${clientIp(req)}`;
        anonymousLimiter.take(key);
        const { status, body } = httpErrorBody(401, 'UNAUTHORIZED', 'Invalid or missing API token');
        sendJson(res, status, body);
        finish(status);
        return;
      }
      tokenIdForLog = `token=${token.id}`;

      const rateKey = `token:${token.id}`;
      if (!authedLimiter.take(rateKey)) {
        const retryAfter = authedLimiter.retryAfterSeconds(rateKey);
        sendJson(res, 429, httpErrorBody(429, 'RATE_LIMITED', 'Too many requests').body, {
          'retry-after': String(retryAfter),
        });
        finish(429);
        return;
      }

      const body =
        method === 'POST' || method === 'PATCH' || method === 'PUT'
          ? await readJsonBody(req)
          : undefined;
      const ctx: RouteContext = {
        req,
        res,
        params,
        query: url.searchParams,
        body,
        token,
        db,
        manager,
        dataDir: options.dataDir,
        lockTtlMs: options.lockTtlMs ?? 30_000,
        resources,
        backups,
      };
      await route.handler(ctx);
      finish(res.statusCode);
    } catch (error) {
      const { status, body } = toHttpError(error);
      if (!res.headersSent) {
        sendJson(res, status, body);
      } else {
        res.end();
      }
      finish(status);
      if (status === 500) {
        console.error(
          '[multiloger] internal error:',
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
      }
    }
  }

  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  hub.attach(
    () => httpServer,
    async (presented: string) => {
      const token = await authenticateRequest(db, `Bearer ${presented}`);
      return token ? token.id : null;
    },
  );
  hub.startHeartbeat();

  const offEvents = profileEvents.on((event) => {
    hub.broadcast(event);
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  // eslint-disable-next-line no-console
  console.log(`[multiloger] API listening on http://${host}:${String(boundPort)}`);

  let closed = false;
  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    offEvents();
    hub.close();
    resources.close();
    await manager.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
    });
    await closeDatabase(db);
  }

  return { port: boundPort, bootstrapToken, close };
}
