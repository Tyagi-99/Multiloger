/**
 * End-to-end: real Chromium + a 407-challenging HTTP proxy + a vault-backed
 * proxy row. Asserts Chromium actually sends the Proxy-Authorization header
 * built from the vault secret when the proxy challenges it.
 *
 * Uses the real vault module (storeSecret/getSecret) with a throwaway key —
 * this exercises the full integration: resolution, the launch gate, the CDP
 * auth handler.
 *
 * Skips gracefully when the Chromium binary is absent.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { ProfileManager } from '../profiles/manager.js';
import { getDebuggerWsUrl, sendCdpCommand } from '../browser/cdp.js';
import { storeSecret } from '../vault/index.js';
import { assignProxyToProfile, createProxy } from './repository.js';
import { resolveProxyAuthForLaunch, resolveProxyForLaunch } from './service.js';

const CHROME_BIN = '/opt/meta-chromium/chrome';
const USERNAME = 'e2euser';
const PASSWORD = 'e2e-s3cret-proxy-password';
const EXPECTED_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

interface ObservedRequest {
  header: string | undefined;
  requestLine: string;
}

interface ChallengingProxy {
  port: number;
  seen: ObservedRequest[];
  close: () => Promise<void>;
}

/**
 * Tiny HTTP proxy: 407-challenges any request without the expected
 * Proxy-Authorization header, records every request line + auth header, and
 * answers authorized requests itself (no upstream needed).
 */
async function startChallengingProxy(): Promise<ChallengingProxy> {
  const seen: ObservedRequest[] = [];
  const server: HttpServer = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('utf8');
      if (!text.includes('\r\n\r\n')) {
        return;
      }
      socket.off('data', onData);
      const lines = text.split('\r\n');
      const authLine = lines.find((l) => l.toLowerCase().startsWith('proxy-authorization:'));
      const header =
        authLine === undefined ? undefined : authLine.slice(authLine.indexOf(':') + 1).trim();
      seen.push({ header, requestLine: lines[0] ?? '' });
      if (header === EXPECTED_HEADER) {
        const body = 'proxied-ok';
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-length: ${String(body.length)}\r\nconnection: close\r\n\r\n${body}`,
        );
      } else {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\n' +
            'Proxy-Authenticate: Basic realm="multiloger-e2e"\r\n' +
            'content-length: 0\r\nconnection: close\r\n\r\n',
        );
      }
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Poll /json/list until the given target appears, then return its page-level
 * WebSocket URL (Page.navigate works directly on it, no session id needed).
 */
async function waitForPageTargetWsUrl(
  cdpHttpUrl: string,
  targetId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${cdpHttpUrl}/json/list`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    if (response?.ok) {
      const targets = (await response.json()) as {
        id?: string;
        type?: string;
        webSocketDebuggerUrl?: string;
      }[];
      const match = targets.find(
        (t) => t.id === targetId && typeof t.webSocketDebuggerUrl === 'string',
      );
      if (match?.webSocketDebuggerUrl) {
        return match.webSocketDebuggerUrl;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for target ${targetId} in /json/list`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!existsSync(CHROME_BIN))('proxy auth end-to-end (live Chromium)', () => {  let dir = '';
  let db: Kysely<DatabaseSchema> | undefined;
  let manager: ProfileManager | undefined;
  let challengingProxy: ChallengingProxy | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = undefined;
    }
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (challengingProxy) {
      await challengingProxy.close();
      challengingProxy = undefined;
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
    delete process.env.MULTILOGER_VAULT_PATH;
    delete process.env.MULTILOGER_VAULT_KEY;
  });

  it('delivers vault credentials to Chromium through a 407-challenging proxy', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-proxy-e2e-'));
    const database: Kysely<DatabaseSchema> = openDatabase({ path: join(dir, 'test.db') });
    db = database;
    await migrateToLatest(database);
    const client = await createClient(database, { name: 'Acme' });
    const profile = await createProfile(database, {
      clientId: client.id,
      name: 'p1',
      userDataDir: join(dir, 'profiles', 'p1'),
    });

    // Vault: real encrypted vault file + env, with a throwaway key.
    const vaultPath = join(dir, 'vault.mlvault');
    process.env.MULTILOGER_VAULT_KEY = randomBytes(32).toString('hex');
    process.env.MULTILOGER_VAULT_PATH = vaultPath;
    storeSecret(vaultPath, 'e2e-proxy-password', PASSWORD);

    challengingProxy = await startChallengingProxy();
    const proxyPort = challengingProxy.port;
    const proxy = await createProxy(database, {
      name: 'e2e',
      scheme: 'http',
      host: '127.0.0.1',
      port: proxyPort,
      username: USERNAME,
      passwordSecretRef: 'vault:e2e-proxy-password',
    });
    await assignProxyToProfile(database, profile.id, proxy.id);

    const profileManager = new ProfileManager(database, {
      dataDir: dir,
      lockTtlMs: 10_000,
      monitorIntervalMs: 60_000,
      resolveProxy: (id) => resolveProxyForLaunch(database, id, 5000),
      resolveProxyAuth: (id) => resolveProxyAuthForLaunch(database, id, { vaultPath }),
    });
    manager = profileManager;
    profileManager.start();

    const launched = await profileManager.launchProfile(profile.id);
    try {
      // Drive a navigation through the proxy with CDP Page.navigate on the
      // page target's own socket. example.com is external (never loopback);
      // the fake proxy answers directly, so no real upstream traffic is needed.
      const wsUrl = await getDebuggerWsUrl(launched.cdpUrl, 10_000);
      const created = (await sendCdpCommand(wsUrl, 'Target.createTarget', { url: 'about:blank' }, 10_000)) as {
        targetId?: string;
      };
      const targetId = created.targetId;
      if (!targetId) {
        throw new Error('Target.createTarget returned no targetId');
      }
      const pageWsUrl = await waitForPageTargetWsUrl(launched.cdpUrl, targetId, 10_000);
      await sendCdpCommand(pageWsUrl, 'Page.navigate', { url: 'http://example.com/' }, 10_000);

      const deadline = Date.now() + 60_000;
      let authorized = false;
      while (Date.now() < deadline) {
        if (challengingProxy.seen.some((r) => r.header === EXPECTED_HEADER)) {
          authorized = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(authorized).toBe(true);
      expect(challengingProxy.seen.length).toBeGreaterThan(0);
    } finally {
      await profileManager.stopProfile(profile.id, 15_000);
    }
  }, 120_000);
});
