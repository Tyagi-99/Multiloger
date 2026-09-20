/**
 * Automation API integration tests: route wiring, auth, validation,
 * filtering, cancellation, artifact serving, and WebSocket run events —
 * plus a real-Chromium end-to-end run (navigate + getText + screenshot).
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

interface ApiResult<T> {
  status: number;
  json: T;
}

interface ScriptShape {
  id: string;
  version: number;
  name: string;
  description: string | null;
  steps: unknown[];
  createdAt: string;
}

interface JobShape {
  id: string;
  name: string;
  scriptId: string;
  scriptVersion: number;
  profileId: string;
  status: string;
  createdAt: string;
}

interface RunShape {
  id: string;
  jobId: string;
  profileId: string;
  status: string;
  attempt: number;
  timeoutMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  result: {
    steps: { index: number; type: string; ok: boolean; output?: unknown; error?: string }[];
    artifacts: { name: string; sizeBytes: number }[];
  } | null;
  logs: { seq: number; stepIndex: number; level: string; message: string; at: string }[];
  createdAt: string;
}

// ---------------------------------------------------------------- client

const DIR = mkdtempSync(join(tmpdir(), 'multiloger-automation-test-'));
let server: RunningServer;
let base = '';
let token = '';
/**
 * Hermetic test page. Chromium's Local Network Access checks block
 * CDP-driven top-level navigations to private-network addresses (even
 * 127.0.0.1, with no preflight sent), so a data: URL is the deterministic
 * local target: it renders without any network request.
 */
const PAGE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body><h1 id="title">Hello Multiloger</h1><p>e2e</p></body></html>',
  );

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (auth) {
    headers.authorization = `Bearer ${auth}`;
  }
  let raw: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    raw = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(raw !== undefined ? { body: raw } : {}),
  });
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
  return {
    opcode,
    text: data.subarray(offset, offset + length).toString('utf8'),
    consumed: offset + length,
  };
}

type WsEvent = Record<string, unknown>;

interface WsTap {
  socket: Socket;
  received: WsEvent[];
  close(): void;
}

async function wsConnect(port: number, wsToken: string): Promise<WsTap> {
  const socket = new Socket();
  const received: WsEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.connect(port, '127.0.0.1', () => {
      const key = randomBytes(16).toString('base64');
      socket.write(
        `GET /v1/events?token=${wsToken} HTTP/1.1\r\n` +
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

async function waitFor(
  tap: WsTap,
  predicate: (event: WsEvent) => boolean,
  timeoutMs = 60_000,
): Promise<WsEvent> {
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

async function waitForRun(
  runId: string,
  terminal: readonly string[],
  timeoutMs = 120_000,
): Promise<RunShape> {
  const start = Date.now();
  for (;;) {
    const { status, json } = await api<{ run: RunShape }>(
      'GET',
      `/v1/automation/runs/${runId}`,
      undefined,
      token,
    );
    expect(status).toBe(200);
    if (terminal.includes(json.run.status)) {
      return json.run;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for run ${runId} to finish; last status: ${json.run.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  server = await startServer({
    dbPath: join(DIR, 'api.db'),
    dataDir: join(DIR, 'profiles'),
    port: 0,
    resources: { checkDiskBeforeLaunch: false },
    // One slot: lets the cancel test hold a queued run deterministically.
    automation: { maxConcurrentRuns: 1 },
  });
  base = `http://127.0.0.1:${String(server.port)}`;
  const bootstrap = server.bootstrapToken ?? '';
  expect(bootstrap).toMatch(/^mlt_/);

  const created = await api<{ token: string }>(
    'POST',
    '/v1/tokens',
    { name: 'automation-e2e' },
    bootstrap,
  );
  expect(created.status).toBe(201);
  token = created.json.token;
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe('automation API', () => {
  let scriptId = '';
  let clientId = '';
  let profileId = '';
  let cancelledRunId = '';
  let ws: WsTap | undefined;

  it('rejects unauthenticated access', async () => {
    const { status, json } = await api<ErrorBody>('GET', '/v1/automation/scripts');
    expect(status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('creates a script and versions it', async () => {
    const steps = [
      { type: 'navigate', url: PAGE_URL },
      { type: 'getText', selector: 'h1' },
      { type: 'screenshot' },
    ];
    const created = await api<{ script: ScriptShape }>(
      'POST',
      '/v1/automation/scripts',
      { name: 'e2e smoke', steps },
      token,
    );
    expect(created.status).toBe(201);
    expect(created.json.script.version).toBe(1);
    expect(created.json.script.steps).toHaveLength(3);
    scriptId = created.json.script.id;

    const versioned = await api<{ script: ScriptShape }>(
      'POST',
      `/v1/automation/scripts/${scriptId}/versions`,
      { steps: [{ type: 'wait', ms: 10 }] },
      token,
    );
    expect(versioned.status).toBe(201);
    expect(versioned.json.script.version).toBe(2);

    const fetched = await api<{ script: ScriptShape }>(
      'GET',
      `/v1/automation/scripts/${scriptId}?version=2`,
      undefined,
      token,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.json.script.version).toBe(2);

    const listed = await api<{ scripts: ScriptShape[] }>(
      'GET',
      '/v1/automation/scripts',
      undefined,
      token,
    );
    expect(listed.status).toBe(200);
    expect(listed.json.scripts.some((s) => s.id === scriptId)).toBe(true);

    const missing = await api<ErrorBody>(
      'GET',
      '/v1/automation/scripts/does-not-exist',
      undefined,
      token,
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('SCRIPT_NOT_FOUND');
  });

  it('rejects invalid scripts with INVALID_SCRIPT', async () => {
    const badSteps = await api<ErrorBody>(
      'POST',
      '/v1/automation/scripts',
      { name: 'bad', steps: [{ type: 'navigate', url: 'ftp://evil.example/x' }] },
      token,
    );
    expect(badSteps.status).toBe(400);
    expect(badSteps.json.error.code).toBe('INVALID_SCRIPT');

    const badVersion = await api<ErrorBody>(
      'POST',
      `/v1/automation/scripts/${scriptId}/versions`,
      { steps: [{ type: 'unknown-step' }] },
      token,
    );
    expect(badVersion.status).toBe(400);
    expect(badVersion.json.error.code).toBe('INVALID_SCRIPT');
  });

  it('rejects jobs for unknown scripts, versions, and profiles', async () => {
    const client = await api<{ client: { id: string } }>(
      'POST',
      '/v1/clients',
      { name: 'acme' },
      token,
    );
    expect(client.status).toBe(201);
    clientId = client.json.client.id;

    const profile = await api<{ profile: { id: string } }>(
      'POST',
      '/v1/profiles',
      { clientId, name: 'auto' },
      token,
    );
    expect(profile.status).toBe(201);
    profileId = profile.json.profile.id;

    const noScript = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs',
      { name: 'j', scriptId: 'nope', profileId },
      token,
    );
    expect(noScript.status).toBe(404);
    expect(noScript.json.error.code).toBe('SCRIPT_NOT_FOUND');

    const noVersion = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs',
      { name: 'j', scriptId, scriptVersion: 999, profileId },
      token,
    );
    expect(noVersion.status).toBe(404);
    expect(noVersion.json.error.code).toBe('SCRIPT_NOT_FOUND');

    const noProfile = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs',
      { name: 'j', scriptId, profileId: 'missing-profile' },
      token,
    );
    expect(noProfile.status).toBe(404);
    expect(noProfile.json.error.code).toBe('PROFILE_NOT_FOUND');

    const badTimeout = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs',
      { name: 'j', scriptId, profileId, timeoutMs: 0 },
      token,
    );
    expect(badTimeout.status).toBe(400);
    expect(badTimeout.json.error.code).toBe('VALIDATION_ERROR');

    const notRunning = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs',
      { name: 'j', scriptId, profileId },
      token,
    );
    expect(notRunning.status).toBe(409);
    expect(notRunning.json.error.code).toBe('PROFILE_NOT_RUNNING');
  });

  it('cancels queued and in-flight runs deterministically', async () => {
    // Second profile so the e2e test keeps a pristine one.
    const profile2 = await api<{ profile: { id: string } }>(
      'POST',
      '/v1/profiles',
      { clientId, name: 'auto-cancel' },
      token,
    );
    expect(profile2.status).toBe(201);
    const profileId2 = profile2.json.profile.id;

    const launched = await api('POST', `/v1/profiles/${profileId2}/launch`, {}, token);
    expect(launched.status).toBe(200);

    const slow = await api<{ script: ScriptShape }>(
      'POST',
      '/v1/automation/scripts',
      { name: 'slow-wait', steps: [{ type: 'wait', ms: 60_000 }] },
      token,
    );
    expect(slow.status).toBe(201);

    // Job A occupies the single runner slot; job B stays queued behind it.
    const jobA = await api<{ job: JobShape; run: RunShape }>(
      'POST',
      '/v1/automation/jobs',
      { name: 'slow-job', scriptId: slow.json.script.id, profileId: profileId2 },
      token,
    );
    expect(jobA.status).toBe(201);
    await waitForRun(jobA.json.run.id, ['running']);

    const jobB = await api<{ job: JobShape; run: RunShape }>(
      'POST',
      '/v1/automation/jobs',
      { name: 'queued-job', scriptId, profileId: profileId2 },
      token,
    );
    expect(jobB.status).toBe(201);
    expect(jobB.json.run.status).toBe('queued');
    cancelledRunId = jobB.json.run.id;

    // Cancel the queued run: never started, marked cancelled.
    const cancelledB = await api<{ job: JobShape }>(
      'POST',
      `/v1/automation/jobs/${jobB.json.job.id}/cancel`,
      undefined,
      token,
    );
    expect(cancelledB.status).toBe(200);
    expect(cancelledB.json.job.status).toBe('cancelled');
    const runB = await api<{ run: RunShape }>(
      'GET',
      `/v1/automation/runs/${jobB.json.run.id}`,
      undefined,
      token,
    );
    expect(runB.json.run.status).toBe('cancelled');

    // Cancel the in-flight run: the wait step aborts promptly.
    const cancelledA = await api<{ job: JobShape }>(
      'POST',
      `/v1/automation/jobs/${jobA.json.job.id}/cancel`,
      undefined,
      token,
    );
    expect(cancelledA.status).toBe(200);
    const runA = await waitForRun(jobA.json.run.id, [
      'cancelled',
      'completed',
      'failed',
      'timed_out',
    ]);
    expect(runA.status).toBe('cancelled');

    const filtered = await api<{ runs: RunShape[] }>(
      'GET',
      `/v1/automation/runs?jobId=${jobB.json.job.id}&status=cancelled`,
      undefined,
      token,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.json.runs).toHaveLength(1);

    const missing = await api<ErrorBody>(
      'POST',
      '/v1/automation/jobs/nope/cancel',
      undefined,
      token,
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('JOB_NOT_FOUND');

    const stopped = await api('POST', `/v1/profiles/${profileId2}/stop`, {}, token);
    expect(stopped.status).toBe(200);
  });

  it('rejects artifact path traversal', async () => {
    // A real run id is required: run existence is checked before the
    // artifact-name allowlist, so a bogus id would 404 as RUN_NOT_FOUND.
    const traversal = await api<ErrorBody>(
      'GET',
      `/v1/automation/runs/${cancelledRunId}/artifacts/..%2f..%2fsecret.png`,
      undefined,
      token,
    );
    expect(traversal.status).toBe(400);
    expect(traversal.json.error.code).toBe('INVALID_ARTIFACT_NAME');

    const noArtifact = await api<ErrorBody>(
      'GET',
      `/v1/automation/runs/${cancelledRunId}/artifacts/0.png`,
      undefined,
      token,
    );
    expect(noArtifact.status).toBe(404);
    expect(noArtifact.json.error.code).toBe('ARTIFACT_NOT_FOUND');

    const noRun = await api<ErrorBody>(
      'GET',
      '/v1/automation/runs/nope/artifacts/0.png',
      undefined,
      token,
    );
    expect(noRun.status).toBe(404);
    expect(noRun.json.error.code).toBe('RUN_NOT_FOUND');
  });

  it('runs a script end-to-end in real Chromium and broadcasts WS events', async () => {
    ws = await wsConnect(server.port, token);

    const launched = await api<{ profile: { state: string } }>(
      'POST',
      `/v1/profiles/${profileId}/launch`,
      {},
      token,
    );
    expect(launched.status).toBe(200);
    expect(launched.json.profile.state).toBe('running');

    const created = await api<{ job: JobShape; run: RunShape }>(
      'POST',
      '/v1/automation/jobs',
      { name: 'e2e-run', scriptId, scriptVersion: 1, profileId, timeoutMs: 90_000 },
      token,
    );
    expect(created.status).toBe(201);
    const runId = created.json.run.id;

    const started = await waitFor(
      ws,
      (e) =>
        e.type === 'automation.run-status' &&
        (e as { runId?: string }).runId === runId &&
        e.status === 'running',
    );
    expect(started.runId).toBe(runId);

    const run = await waitForRun(runId, ['completed', 'failed', 'timed_out', 'cancelled']);
    expect(run.status).toBe('completed');
    expect(run.result?.steps).toHaveLength(3);
    expect(run.result?.steps.every((s) => s.ok)).toBe(true);
    expect(run.result?.steps[1]?.output).toBe('Hello Multiloger');
    expect(run.result?.artifacts).toHaveLength(1);
    expect(run.result?.artifacts[0]?.name).toBe('2.png');
    expect(run.result?.artifacts[0]?.sizeBytes).toBeGreaterThan(100);
    expect(run.logs.length).toBeGreaterThan(0);

    const completed = await waitFor(
      ws,
      (e) =>
        e.type === 'automation.run-status' &&
        (e as { runId?: string }).runId === runId &&
        e.status === 'completed',
    );
    expect(completed.runId).toBe(runId);

    const artifactName = run.result?.artifacts[0]?.name ?? '';
    const res = await fetch(`${base}/v1/automation/runs/${runId}/artifacts/${artifactName}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.length).toBeGreaterThan(100);

    const stopped = await api('POST', `/v1/profiles/${profileId}/stop`, {}, token);
    expect(stopped.status).toBe(200);

    ws.close();
    ws = undefined;
  }, 240_000);
});
