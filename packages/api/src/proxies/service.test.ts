import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
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
import { storeSecret } from '../vault/index.js';
import {
  assignProxyToProfile,
  assertValidSecretRef,
  createProxy,
  InvalidSecretRefError,
  setProxyRequired,
  type ProxyRecord,
} from './repository.js';
import {
  ProxyAuthUnsupportedError,
  ProxyCredentialError,
  ProxyRequiredError,
  ProxyUnhealthyError,
  resolveProxyAuthForLaunch,
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
    delete process.env.MULTILOGER_VAULT_PATH;
    delete process.env.MULTILOGER_VAULT_KEY;
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
    // Credentials resolve — but the MVP cannot apply proxy authentication, so
    // the launch gate fails closed instead of launching unauthenticated.
    await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyAuthUnsupportedError);

    delete process.env.TEST_PROXY_PASSWORD;
    expect(() => resolveProxyCredentials(proxy)).toThrow(ProxyCredentialError);
  });

  it('refuses launch when only a username is configured (no secret ref)', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'user-only',
      scheme: 'http',
      host: '127.0.0.1',
      port,
      username: 'alice',
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    // A username signals intended authentication; launching without applying
    // it would silently send traffic unauthenticated — refuse instead.
    await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyAuthUnsupportedError);
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

  it('blocks a manager launch when the proxy has credentials: nothing spawned', async () => {
    fixture = await setup();
    const { db, dir, profileId } = fixture;
    const port = await dummyProxy();
    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    const proxy = await createProxy(db, {
      name: 'auth',
      scheme: 'http',
      host: '127.0.0.1',
      port,
      username: 'alice',
      passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    const manager = new ProfileManager(db, {
      dataDir: dir,
      lockTtlMs: 10_000,
      resolveProxy: (id) => resolveProxyForLaunch(db, id, 2000),
    });
    manager.start();
    try {
      // Fail closed: the launch is refused BEFORE Chromium spawns, because
      // proxy authentication cannot be applied in this build.
      await expect(manager.launchProfile(profileId)).rejects.toThrow(ProxyAuthUnsupportedError);
      expect(await getState(db, profileId)).toBe('error');
      expect((await getLockInfo(db, profileId, 10_000)).active).toBe(false);
      expect(manager.isLive(profileId)).toBe(false);
    } finally {
      delete process.env.TEST_PROXY_PASSWORD;
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

  it('fails a manager launch closed when the proxy-auth resolver throws: browser killed, state error, lock released', async () => {
    fixture = await setup();
    const { db, dir, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'plain',
      scheme: 'http',
      host: '127.0.0.1',
      port,
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    const manager = new ProfileManager(db, {
      dataDir: dir,
      lockTtlMs: 10_000,
      resolveProxy: (id) => resolveProxyForLaunch(db, id, 2000),
      resolveProxyAuth: () => {
        throw new Error('vault exploded');
      },
    });
    manager.start();
    try {
      // The proxy gate passes, so Chromium actually spawns — then the
      // resolver throws and the launch must fail closed: browser killed,
      // error state, lock released, nothing left live.
      await expect(manager.launchProfile(profileId)).rejects.toThrow('vault exploded');
      expect(await getState(db, profileId)).toBe('error');
      expect((await getLockInfo(db, profileId, 10_000)).active).toBe(false);
      expect(manager.isLive(profileId)).toBe(false);
    } finally {
      await manager.shutdown();
    }
  }, 60_000);
});

describe('vault-backed proxy credentials', () => {
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
    delete process.env.MULTILOGER_VAULT_PATH;
    delete process.env.MULTILOGER_VAULT_KEY;
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

  /** Store secrets in a real encrypted vault file under the fixture dir. */
  function useVault(dir: string, secrets: Record<string, string>): string {
    const vaultPath = join(dir, 'vault.mlvault');
    process.env.MULTILOGER_VAULT_KEY = randomBytes(32).toString('hex');
    process.env.MULTILOGER_VAULT_PATH = vaultPath;
    for (const [name, value] of Object.entries(secrets)) {
      storeSecret(vaultPath, name, value);
    }
    return vaultPath;
  }

  function vaultRecord(): ProxyRecord {
    return {
      id: 'proxy-1',
      name: 'vaulted',
      scheme: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password_secret_ref: 'vault:proxy-password',
      bypass: null,
      notes: null,
      created_at: '',
      updated_at: '',
    };
  }

  async function assignVaultProxy(port: number): Promise<{ db: Fixture['db']; profileId: string; proxyId: string }> {
    fixture = await setup();
    const { db, profileId } = fixture;
    const proxy = await createProxy(db, {
      name: 'vault-auth',
      scheme: 'http',
      host: '127.0.0.1',
      port,
      username: 'alice',
      passwordSecretRef: 'vault:proxy-password',
    });
    await assignProxyToProfile(db, profileId, proxy.id);
    return { db, profileId, proxyId: proxy.id };
  }

  it('assertValidSecretRef accepts vault: refs and rejects malformed ones', () => {
    expect(() => { assertValidSecretRef('vault:proxy-password'); }).not.toThrow();
    expect(() => { assertValidSecretRef('vault:a'); }).not.toThrow();
    expect(() => { assertValidSecretRef('vault:my.secret_1-2'); }).not.toThrow();
    expect(() => { assertValidSecretRef(`vault:${'x'.repeat(100)}`); }).not.toThrow();
    expect(() => { assertValidSecretRef('vault:'); }).toThrow(InvalidSecretRefError);
    expect(() => { assertValidSecretRef('vault:bad name'); }).toThrow(InvalidSecretRefError);
    expect(() => { assertValidSecretRef('vault:bad/name'); }).toThrow(InvalidSecretRefError);
    expect(() => { assertValidSecretRef(`vault:${'x'.repeat(101)}`); }).toThrow(InvalidSecretRefError);
    // env: refs keep working; plaintext is still rejected.
    expect(() => { assertValidSecretRef('env:FOO'); }).not.toThrow();
    expect(() => { assertValidSecretRef('hunter2'); }).toThrow(InvalidSecretRefError);
    expect(() => { assertValidSecretRef(null); }).not.toThrow();
    expect(() => { assertValidSecretRef(undefined); }).not.toThrow();
  });

  it('resolves vault: refs from the vault (explicit path and MULTILOGER_VAULT_PATH)', async () => {
    fixture = await setup();
    const vaultPath = useVault(fixture.dir, { 'proxy-password': 's3cret' });

    expect(resolveProxyCredentials(vaultRecord(), { vaultPath })).toEqual({
      username: 'alice',
      password: 's3cret',
    });
    // Falls back to MULTILOGER_VAULT_PATH when no explicit path is given.
    expect(resolveProxyCredentials(vaultRecord())).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('throws ProxyCredentialError when the vault secret is missing', async () => {
    fixture = await setup();
    const vaultPath = useVault(fixture.dir, { 'other-secret': 'x' });
    expect(() => resolveProxyCredentials(vaultRecord(), { vaultPath })).toThrow(ProxyCredentialError);
  });

  it('throws ProxyCredentialError when no vault path is configured', async () => {
    fixture = await setup();
    // Neither vaultPath opt nor MULTILOGER_VAULT_PATH: fail closed.
    expect(() => resolveProxyCredentials(vaultRecord())).toThrow(ProxyCredentialError);
  });

  it('throws ProxyCredentialError when the vault key is not set', async () => {
    fixture = await setup();
    const vaultPath = join(fixture.dir, 'vault.mlvault');
    process.env.MULTILOGER_VAULT_KEY = randomBytes(32).toString('hex');
    process.env.MULTILOGER_VAULT_PATH = vaultPath;
    storeSecret(vaultPath, 'proxy-password', 's3cret');
    // MULTILOGER_VAULT_KEY deliberately unset: the vault cannot be opened.
    delete process.env.MULTILOGER_VAULT_KEY;
    expect(() => resolveProxyCredentials(vaultRecord())).toThrow(ProxyCredentialError);
  });

  it('keeps resolving env: refs alongside vault: refs', async () => {
    fixture = await setup();
    useVault(fixture.dir, { 'proxy-password': 's3cret' });
    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    try {
      const record: ProxyRecord = { ...vaultRecord(), password_secret_ref: 'env:TEST_PROXY_PASSWORD' };
      expect(resolveProxyCredentials(record)).toEqual({ username: 'alice', password: 'hunter2' });
    } finally {
      delete process.env.TEST_PROXY_PASSWORD;
    }
  });

  it('launch gate passes a vault-credentialed proxy like an unauthenticated one', async () => {
    const port = await dummyProxy();
    const { db, profileId } = await assignVaultProxy(port);
    useVault(fixture?.dir ?? '', { 'proxy-password': 's3cret' });

    const flags = await resolveProxyForLaunch(db, profileId, 2000);
    expect(flags).toEqual({ scheme: 'http', host: '127.0.0.1', port });
  });

  it('launch gate fails closed when the vault secret is dangling', async () => {
    const port = await dummyProxy();
    const { db, profileId } = await assignVaultProxy(port);
    useVault(fixture?.dir ?? '', { 'unrelated': 'x' });

    await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyCredentialError);
  });

  it('launch gate still refuses env:-credentialed proxies: credentials come only from the vault', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    try {
      const proxy = await createProxy(db, {
        name: 'env-auth',
        scheme: 'http',
        host: '127.0.0.1',
        port,
        username: 'alice',
        passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
      });
      await assignProxyToProfile(db, profileId, proxy.id);
      await expect(resolveProxyForLaunch(db, profileId, 2000)).rejects.toThrow(ProxyAuthUnsupportedError);
    } finally {
      delete process.env.TEST_PROXY_PASSWORD;
    }
  });

  it('resolveProxyAuthForLaunch returns a lazy credential closure for vault proxies', async () => {
    const port = await dummyProxy();
    const { db, profileId, proxyId } = await assignVaultProxy(port);
    const vaultPath = useVault(fixture?.dir ?? '', { 'proxy-password': 's3cret' });

    const auth = await resolveProxyAuthForLaunch(db, profileId, { vaultPath });
    expect(auth).toBeDefined();
    expect(auth?.proxyId).toBe(proxyId);
    // The password lives only inside the getCredentials closure: the returned
    // object carries no secret material.
    expect(Object.keys(auth ?? {}).sort()).toEqual(['getCredentials', 'proxyId']);
    expect(JSON.stringify(auth)).not.toContain('s3cret');
    expect(auth?.getCredentials()).toEqual({ username: 'alice', password: 's3cret' });
  });

  it('resolveProxyAuthForLaunch returns undefined when the proxy has no credentials', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    const proxy = await createProxy(db, {
      name: 'plain',
      scheme: 'http',
      host: '127.0.0.1',
      port,
    });
    await assignProxyToProfile(db, profileId, proxy.id);

    await expect(resolveProxyAuthForLaunch(db, profileId)).resolves.toBeUndefined();
  });

  it('resolveProxyAuthForLaunch returns undefined when no proxy is assigned', async () => {
    fixture = await setup();
    await expect(resolveProxyAuthForLaunch(fixture.db, fixture.profileId)).resolves.toBeUndefined();
  });

  it('resolveProxyAuthForLaunch throws ProxyAuthUnsupportedError for env:-credentialed proxies', async () => {
    fixture = await setup();
    const { db, profileId } = fixture;
    const port = await dummyProxy();
    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    try {
      const proxy = await createProxy(db, {
        name: 'env-auth',
        scheme: 'http',
        host: '127.0.0.1',
        port,
        username: 'alice',
        passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
      });
      await assignProxyToProfile(db, profileId, proxy.id);
      await expect(resolveProxyAuthForLaunch(db, profileId)).rejects.toThrow(ProxyAuthUnsupportedError);
    } finally {
      delete process.env.TEST_PROXY_PASSWORD;
    }
  });
});
