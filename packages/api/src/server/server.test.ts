/**
 * Live API server tests: full HTTP lifecycle plus a raw-socket WebSocket
 * client (no ws dependency). Slow by design — real Chromium launches.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './index.js';

// ---------------------------------------------------------------- shapes

interface ErrorBody {
  error: { code: string; message: string };
}

interface ProfileDetail {
  id: string;
  clientId: string;
  name: string;
  state: string;
  proxyRequired: boolean;
  lock: unknown;
  proxy: { id: string } | null;
}

interface PublicTokenShape {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface PublicProxyShape {
  id: string;
  name: string;
  scheme: string;
  host: string;
  port: number;
  username: string | null;
}

interface ApiResult<T> {
  status: number;
  json: T;
}

// ---------------------------------------------------------------- client

const DIR = mkdtempSync(join(tmpdir(), 'multiloger-server-test-'));
let server: RunningServer;
let base = '';
let bootstrap = '';

async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  let raw: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    raw = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, ...(raw !== undefined ? { body: raw } : {}) });
  const rawJson: unknown = await res.json().catch((): null => null);
  return { status: res.status, json: rawJson as T };
}

/** Decode one server→client frame (unmasked). Returns consumed bytes or 0. */
function decodeServerFrame(data: Buffer): { opcode: number; text: string; consumed: number } {
  const empty = { opcode: 0, text: '', consumed: 0 };
  if (data.length < 2) {
    return empty;
  }
  const opcode = (data[0] ?? 0) & 0x0f;
  let length = (data[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (data.length < 4) {
      return empty;
    }
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) {
      return empty;
    }
    length = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  if (data.length < offset + length) {
    return empty;
  }
  return { opcode, text: data.subarray(offset, offset + length).toString('utf8'), consumed: offset + length };
}

type WsEvent = Record<string, unknown>;

interface WsTap {
  socket: Socket;
  received: WsEvent[];
  close(): void;
}

async function wsConnect(port: number, token: string): Promise<WsTap> {
  const socket = new Socket();
  const received: WsEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.connect(port, '127.0.0.1', () => {
      const key = randomBytes(16).toString('base64');
      socket.write(
        `GET /v1/events?token=${token} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${String(port)}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    let handshook = false;
    let pending = Buffer.alloc(0);
    const pump = (): void => {
      for (;;) {
        const frame = decodeServerFrame(pending);
        if (frame.consumed === 0) {
          break;
        }
        pending = pending.subarray(frame.consumed);
        if (frame.opcode === 0x1 && frame.text.length > 0) {
          try {
            received.push(JSON.parse(frame.text) as WsEvent);
          } catch {
            // ignore malformed
          }
        }
        if (frame.opcode === 0x8) {
          socket.destroy();
          break;
        }
      }
    };
    socket.on('data', (data: Buffer) => {
      if (!handshook) {
        buf = Buffer.concat([buf, data]);
        const str = buf.toString('utf8');
        const headerEnd = str.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return;
        }
        if (!str.startsWith('HTTP/1.1 101')) {
          reject(new Error(`WS handshake rejected: ${str.split('\r\n')[0] ?? ''}`));
          socket.destroy();
          return;
        }
        handshook = true;
        pending = buf.subarray(headerEnd + 4);
        buf = Buffer.alloc(0);
        resolve();
      } else {
        pending = Buffer.concat([pending, data]);
      }
      pump();
    });
  });
  return { socket, received, close: () => socket.destroy() };
}

async function waitFor(tap: WsTap, predicate: (event: WsEvent) => boolean, timeoutMs = 20_000): Promise<WsEvent> {
  const start = Date.now();
  for (;;) {
    const found = tap.received.find(predicate);
    if (found) {
      return found;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for WS event; got: ${JSON.stringify(tap.received)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  server = await startServer({
    dbPath: join(DIR, 'api.db'),
    dataDir: join(DIR, 'profiles'),
    port: 0,
    // The tmpfs tmpdir on CI VMs sits below the 1 GiB default watermark;
    // the watermark itself is unit-tested in resources.test.ts.
    resources: { checkDiskBeforeLaunch: false },
  });
  base = `http://127.0.0.1:${String(server.port)}`;
  bootstrap = server.bootstrapToken ?? '';
  expect(bootstrap).toMatch(/^mlt_/);
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('API server (live)', () => {
  let userToken = '';
  let clientId = '';
  let profileId = '';
  let ws: WsTap | undefined;

  it('serves /health without auth', async () => {
    const { status, json } = await api<{ ok: boolean; version: string }>('GET', '/health', null);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('reports resource governor status at /v1/resources', async () => {
    const { status, json } = await api<{
      enabled: boolean;
      maxConcurrent: number;
      running: number;
      queued: string[];
      idleShutdownMs: number;
      minFreeDiskBytes: number;
    }>('GET', '/v1/resources', bootstrap);
    expect(status).toBe(200);
    expect(json.enabled).toBe(true);
    expect(json.maxConcurrent).toBe(4);
    expect(json.running).toBe(0);
    expect(json.queued).toEqual([]);
    expect(json.idleShutdownMs).toBe(0);
    expect(json.minFreeDiskBytes).toBeGreaterThan(0);
  });

  it('rejects unauthenticated API access', async () => {
    const { status, json } = await api<ErrorBody>('GET', '/v1/profiles', null);
    expect(status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('creates a token and shows the plaintext exactly once', async () => {
    const { status, json } = await api<{ id: string; name: string; token: string; createdAt: string }>(
      'POST',
      '/v1/tokens',
      bootstrap,
      { name: 'dashboard' },
    );
    expect(status).toBe(201);
    expect(json.token).toMatch(/^mlt_/);
    userToken = json.token;

    const listed = await api<{ tokens: PublicTokenShape[] }>('GET', '/v1/tokens', bootstrap);
    expect(listed.status).toBe(200);
    expect(listed.json.tokens).toHaveLength(2);
    for (const t of listed.json.tokens) {
      expect(t).not.toHaveProperty('token');
      expect(t).not.toHaveProperty('hash');
      expect(t).not.toHaveProperty('salt');
    }
  });

  it('validates request bodies', async () => {
    const missing = await api<ErrorBody>('POST', '/v1/clients', userToken, {});
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe('VALIDATION_ERROR');

    const badJson = await api<ErrorBody>('POST', '/v1/clients', userToken, 'not json{{');
    expect(badJson.status).toBe(400);
    expect(badJson.json.error.code).toBe('INVALID_JSON');

    const unknown = await api<ErrorBody>('GET', '/nope', userToken);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('NOT_FOUND');
  });

  it('runs the client lifecycle', async () => {
    const created = await api<{ client: { id: string; name: string } }>('POST', '/v1/clients', userToken, {
      name: 'Acme',
    });
    expect(created.status).toBe(201);
    clientId = created.json.client.id;

    const listed = await api<{ clients: { id: string }[] }>('GET', '/v1/clients', userToken);
    expect(listed.json.clients).toHaveLength(1);

    const missing = await api<ErrorBody>('GET', '/v1/clients/does-not-exist', userToken);
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('creates a profile and streams its lifecycle over WebSocket', async () => {
    const created = await api<{ profile: ProfileDetail }>('POST', '/v1/profiles', userToken, {
      clientId,
      name: 'main',
    });
    expect(created.status).toBe(201);
    expect(created.json.profile.state).toBe('created');
    expect(created.json.profile.proxyRequired).toBe(false);
    profileId = created.json.profile.id;

    ws = await wsConnect(server.port, userToken);
    const hello = await waitFor(ws, (e) => e.type === 'hello');
    expect(typeof hello.tokenId).toBe('string');

    const launched = await api<{ profile: ProfileDetail; cdp: { pid: number; port: number; cdpUrl: string } }>(
      'POST',
      `/v1/profiles/${profileId}/launch`,
      userToken,
    );
    expect(launched.status).toBe(200);
    expect(launched.json.profile.state).toBe('running');
    expect(launched.json.cdp.port).toBeGreaterThan(0);

    const running = await waitFor(
      ws,
      (e) => e.type === 'profile.state-changed' && e.profileId === profileId && e.to === 'running',
    );
    expect(running.from).toBe('launching');

    const relaunch = await api<ErrorBody>('POST', `/v1/profiles/${profileId}/launch`, userToken);
    expect(relaunch.status).toBe(409);
    expect(relaunch.json.error.code).toBe('PROFILE_ALREADY_RUNNING');

    const sessions = await api<{ sessions: unknown[] }>('GET', `/v1/profiles/${profileId}/sessions`, userToken);
    expect(sessions.status).toBe(200);
    expect(sessions.json.sessions.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('manages proxies without ever exposing secrets', async () => {
    const created = await api<{ proxy: PublicProxyShape }>('POST', '/v1/proxies', userToken, {
      name: 'corp',
      scheme: 'http',
      host: '127.0.0.1',
      port: 9,
      username: 'u',
      passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
    });
    expect(created.status).toBe(201);
    const proxyId = created.json.proxy.id;
    expect(created.json.proxy).not.toHaveProperty('passwordSecretRef');
    expect(created.json.proxy).not.toHaveProperty('password');
    expect(created.json.proxy.username).toBe('u');

    const assigned = await api<{ profile: ProfileDetail }>('POST', `/v1/profiles/${profileId}/proxy`, userToken, {
      proxyId,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.json.profile.proxy?.id).toBe(proxyId);

    const blocked = await api<ErrorBody>('DELETE', `/v1/proxies/${proxyId}`, userToken);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('PROXY_ASSIGNED');

    const unassigned = await api<{ profile: ProfileDetail }>('DELETE', `/v1/profiles/${profileId}/proxy`, userToken);
    expect(unassigned.status).toBe(200);
    expect(unassigned.json.profile.proxy).toBeNull();

    const deleted = await api<{ deleted: boolean }>('DELETE', `/v1/proxies/${proxyId}`, userToken);
    expect(deleted.status).toBe(200);
  });

  it('refuses launch with 409 PROXY_AUTH_UNSUPPORTED for a credentialed proxy', async () => {
    // Separate profile so the shared one keeps its lifecycle intact.
    const created = await api<{ profile: ProfileDetail }>('POST', '/v1/profiles', userToken, {
      clientId,
      name: 'auth-proxy-profile',
    });
    expect(created.status).toBe(201);
    const pId = created.json.profile.id;

    // Env var set: credentials fully resolve, so the refusal is specifically
    // PROXY_AUTH_UNSUPPORTED (unset would be PROXY_CREDENTIAL_ERROR instead).
    process.env.TEST_PROXY_PASSWORD = 'hunter2';
    try {
      const proxy = await api<{ proxy: PublicProxyShape }>('POST', '/v1/proxies', userToken, {
        name: 'auth-proxy',
        scheme: 'http',
        host: '127.0.0.1',
        port: 9,
        username: 'u',
        passwordSecretRef: 'env:TEST_PROXY_PASSWORD',
      });
      expect(proxy.status).toBe(201);

      const assigned = await api<{ profile: ProfileDetail }>(
        'POST',
        `/v1/profiles/${pId}/proxy`,
        userToken,
        { proxyId: proxy.json.proxy.id },
      );
      expect(assigned.status).toBe(200);

      const refused = await api<ErrorBody>('POST', `/v1/profiles/${pId}/launch`, userToken);
      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('PROXY_AUTH_UNSUPPORTED');
    } finally {
      delete process.env.TEST_PROXY_PASSWORD;
    }
  });

  it('stops the profile and reports readiness honestly', async () => {
    const readiness = await api<{ ready: boolean; reason?: string }>(
      'GET',
      `/v1/profiles/${profileId}/launch-readiness`,
      userToken,
    );
    expect(readiness.status).toBe(200);
    expect(readiness.json.ready).toBe(true);

    const stopped = await api<{ profile: ProfileDetail }>('POST', `/v1/profiles/${profileId}/stop`, userToken);
    expect(stopped.status).toBe(200);
    expect(stopped.json.profile.state).toBe('stopped');

    if (ws) {
      const backToStopped = await waitFor(
        ws,
        (e) => e.type === 'profile.state-changed' && e.profileId === profileId && e.to === 'stopped',
      );
      expect(backToStopped).toBeDefined();
      ws.close();
    }
  }, 120_000);

  describe('encrypted backups', () => {
    const backupKey = randomBytes(32).toString('hex');
    let backupId = '';

    function withKey<T>(fn: () => Promise<T>): Promise<T> {
      process.env.MULTILOGER_BACKUP_KEY = backupKey;
      return fn().finally(() => {
        delete process.env.MULTILOGER_BACKUP_KEY;
      });
    }

    it('answers 503 when no backup key is configured', async () => {
      const saved = process.env.MULTILOGER_BACKUP_KEY;
      delete process.env.MULTILOGER_BACKUP_KEY;
      try {
        const res = await api<ErrorBody>('POST', `/v1/profiles/${profileId}/backups`, userToken);
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('BACKUP_KEY_MISSING');
      } finally {
        if (saved !== undefined) {
          process.env.MULTILOGER_BACKUP_KEY = saved;
        }
      }
    });

    it('creates, lists, verifies, restores, and deletes a backup', async () => {
      await withKey(async () => {
        const created = await api<{
          backup: { id: string; sizeBytes: number; sha256: string; stoppedForBackup: boolean };
        }>('POST', `/v1/profiles/${profileId}/backups`, userToken);
        expect(created.status).toBe(201);
        backupId = created.json.backup.id;
        expect(created.json.backup.sizeBytes).toBeGreaterThan(0);
        expect(created.json.backup.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(created.json.backup.stoppedForBackup).toBe(false);

        const listed = await api<{ backups: { id: string }[] }>(
          'GET',
          `/v1/profiles/${profileId}/backups`,
          userToken,
        );
        expect(listed.status).toBe(200);
        expect(listed.json.backups.map((b) => b.id)).toContain(backupId);

        const got = await api<{ backup: { id: string } }>('GET', `/v1/backups/${backupId}`, userToken);
        expect(got.status).toBe(200);
        expect(got.json.backup.id).toBe(backupId);

        const verified = await api<{ ok: boolean; entries: number; sha256Match: boolean }>(
          'POST',
          `/v1/backups/${backupId}/verify`,
          userToken,
        );
        expect(verified.status).toBe(200);
        expect(verified.json.ok).toBe(true);
        expect(verified.json.sha256Match).toBe(true);
        expect(verified.json.entries).toBeGreaterThan(0);

        const restored = await api<{ profile: { id: string; name: string; state: string } }>(
          'POST',
          `/v1/backups/${backupId}/restore`,
          userToken,
          { name: 'restored-via-api' },
        );
        expect(restored.status).toBe(201);
        expect(restored.json.profile.id).not.toBe(profileId);
        expect(restored.json.profile.name).toBe('restored-via-api');
        expect(restored.json.profile.state).toBe('created');

        // The restored profile launches: the backup is a working profile dir.
        const relaunched = await api<{ profile: ProfileDetail }>(
          'POST',
          `/v1/profiles/${restored.json.profile.id}/launch`,
          userToken,
        );
        expect(relaunched.status).toBe(200);
        expect(relaunched.json.profile.state).toBe('running');
        const restopped = await api<{ profile: ProfileDetail }>(
          'POST',
          `/v1/profiles/${restored.json.profile.id}/stop`,
          userToken,
        );
        expect(restopped.status).toBe(200);

        const deleted = await api<{ deleted: boolean }>(
          'DELETE',
          `/v1/backups/${backupId}`,
          userToken,
        );
        expect(deleted.status).toBe(200);
        const gone = await api<ErrorBody>('GET', `/v1/backups/${backupId}`, userToken);
        expect(gone.status).toBe(404);
        expect(gone.json.error.code).toBe('BACKUP_NOT_FOUND');
      });
    });

    it('rejects restore without a name', async () => {
      await withKey(async () => {
        const created = await api<{ backup: { id: string } }>(
          'POST',
          `/v1/profiles/${profileId}/backups`,
          userToken,
        );
        expect(created.status).toBe(201);
        const bid = created.json.backup.id;
        const bad = await api<ErrorBody>('POST', `/v1/backups/${bid}/restore`, userToken, {});
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('VALIDATION_ERROR');
        await api('DELETE', `/v1/backups/${bid}`, userToken);
      });
    });
  });

  it('revokes tokens', async () => {
    const listed = await api<{ tokens: PublicTokenShape[] }>('GET', '/v1/tokens', bootstrap);
    const mine = listed.json.tokens.find((t) => t.name === 'dashboard');
    expect(mine).toBeDefined();
    const revoked = await api<{ token: PublicTokenShape }>('POST', `/v1/tokens/${mine?.id ?? ''}/revoke`, bootstrap);
    expect(revoked.status).toBe(200);
    expect(typeof revoked.json.token.revokedAt).toBe('string');

    const rejected = await api<ErrorBody>('GET', '/v1/profiles', userToken);
    expect(rejected.status).toBe(401);
  });

  it('rate-limits anonymous traffic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-ratelimit-'));
    const limited = await startServer({
      dbPath: join(dir, 'api.db'),
      dataDir: join(dir, 'profiles'),
      port: 0,
      anonymousRateLimit: { capacity: 2, refillPerSecond: 0.001 },
    });
    try {
      const url = `http://127.0.0.1:${String(limited.port)}/health`;
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(url)).status).toBe(200);
      const third = await fetch(url);
      expect(third.status).toBe(429);
      expect(typeof third.headers.get('retry-after')).toBe('string');
      const rawBody: unknown = await third.json();
      expect((rawBody as ErrorBody).error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects WebSocket upgrades with bad tokens', async () => {
    await expect(wsConnect(server.port, 'mlt_00000000000000000000000000000000')).rejects.toThrow(/HTTP\/1\.1 401/);
  });
});
