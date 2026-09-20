import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { createClient, createProfile } from '../profiles/repository.js';
import { getState } from '../profiles/stateMachine.js';
import { getLockInfo } from '../profiles/lock.js';
import { ProfileManager } from '../profiles/manager.js';
import { findFreePort } from '../browser/ports.js';
import {
  assignProxyToProfile,
  createProxy,
  setProxyRequired,
} from './repository.js';
import {
  ProxyCredentialError,
  ProxyRequiredError,
  ProxyUnhealthyError,
  resolveProxyCredentials,
  resolveProxyForLaunch,
} from './service.js';

interface Fixture {
  dir: string;
  db: Kysely<DatabaseSchema>;
  profileId: string;
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'multiloger-proxy-svc-'));
  const db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
  const clientId = (await createClient(db, { name: 'Acme' })).id;
  const profile = await createProfile(db, {
    clientId,
    name: 'p1',
    userDataDir: join(dir, 'profiles', 'p1'),
  });
  return { dir, db, profileId: profile.id };
}

describe('proxy launch gate', () => {
  let fixture: Fixture | undefined;
  const servers: { close: () => void }[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.close();
    }
    if (fixture) {
      await closeDatabase(fixture.db);
      rmSync(fixture.dir, { recursive: true, force: true });
      fixture = undefined;
    }
    delete process.env.TEST_PROXY_PASSWORD;
  });

  /** A dummy TCP listener that passes the health check (no real proxying). */
  async function dummyProxy(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    });
    servers.push(server);
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  it('returns undefined when no proxy is assigned and none is required', async () => {
    fixture = await setup();
    expect(await resolveProxyForLaunch(fixture.db, fixture.profileId)).toBeUndefined();
  });

  it('throws ProxyRequiredError when a required proxy is missing', async () => {
    fixture = await setup();
    await setProxyRequired(fixture.db, fixture.profileId, true);
    await expect(resolveProxyForLaunch(fixture.db, fixture.profileId)).rejects.toThrow(
      ProxyRequiredError,
    );
  });

  it('throws ProxyUnhealthyError for an assigned but dead proxy', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const deadPort = await findFreePort();
    const proxy = await createProxy(db, {
      name: 'dead',
      scheme: 'http',
      host: '127.0.0.1',
      port: deadPort,
    });
    await assignProxyToProfile(db, profileId, proxy.id);
    await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyUnhealthyError);
  });

  it('returns Chromium proxy flags for a healthy assigned proxy', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'alive',
      scheme: 'socks5',
      host: '127.0.0.1',
      port,
      bypass: 'internal.corp',
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    const flags = await resolveProxyForLaunch(db, profileId, 2000);
    expect(flags).toEqual({ scheme: 'socks5', host: '127.0.0.1', port, bypass: 'internal.corp' });
  });

  it('resolves credentials from the referenced env var, and fails when unset', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'auth',
      scheme: 'http',
      host: '127.0.0.1',
      port,
      username: 'alice',
      passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    // Healthy proxy, but the credential reference is dangling.
    await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyCredentialError);

    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    expect(resolveProxyCredentials(proxy)).toEqual({ username: 'alice', password: 'hunter2' });
    // Launch proceeds (with the documented no-auth-applied warning).
    const flags = await resolveProxyForLaunch(db, profileId, 2000);
    expect(flags?.host).toBe('127.0.0.1');

    delete process.env.TEST_PROXY_PASSWORD;
    expect(() => resolveProxyCredentials(proxy)).toThrow(ProxyCredentialError);
  });

  it('blocks a manager launch fail-closed: state error, lock released, nothing spawned', async () => {
    fixture = await setup();
    const { db, dir, profileId } = fixture;
    await setProxyRequired(db, profileId, true);

    const manager = new ProfileManager(db, {
      dataDir: dir,
      lockTtlMs: 10_000,
      resolveProxy: (id) => resolveProxyForLaunch(db, id, 2000),
    });
    manager.start();
    try {
      await expect(manager.launchProfile(profileId)).rejects.toThrow(ProxyRequiredError);
      // The failure path ran: error state, lock released, no live entry —
      // NOT stuck at 'launching' with a leaked lock.
      expect(await getState(db, profileId)).toBe('error');
      expect((await getLockInfo(db, profileId, 10_000)).active).toBe(false);
      expect(manager.isLive(profileId)).toBe(false);
    } finally {
      await manager.shutdown();
    }
  }, 60_000);

  it('launches through a healthy assigned proxy and pins the WebRTC policy', async () => {
    fixture = await setup();
    const { db, dir, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'alive',
      scheme: 'http',
      host: '127.0.0.1',
      port,
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    const manager = new ProfileManager(db, {
      dataDir: dir,
      lockTtlMs: 10_000,
      resolveProxy: (id) => resolveProxyForLaunch(db, id, 2000),
    });
    manager.start();
    try {
      const launched = await manager.launchProfile(profileId);
      expect(await getState(db, profileId)).toBe('running');

      // Leak guard applied for this launch.
      const { readFileSync } = await import('node:fs');
      const prefs = JSON.parse(
        readFileSync(join(dir, 'profiles', 'p1', 'Default', 'Preferences'), 'utf8'),
      ) as { webrtc: { ip_handling_policy: string } };
      expect(prefs.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');

      await manager.stopProfile(profileId);
      expect(launched.pid).toBeGreaterThan(0);
    } finally {
      await manager.shutdown();
    }
  }, 60_000);
});
