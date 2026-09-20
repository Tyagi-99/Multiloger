/**
 * Tests for the Multiloger MCP server package.
 *
 * No test here hits a real server: the API client is tested against a stubbed
 * global fetch, and the tools are tested against a mock ApiClientLike.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { z } from 'zod';
import { ApiClientError, MultilogerApiClient, type ApiClientLike } from './api-client.js';
import { buildTools, type ToolDefinition } from './tools.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

/** Mock ApiClientLike backed by a METHOD+path -> response map. */
function createMockClient(
  routes: Record<string, unknown>,
  binaries: Record<string, { data: Uint8Array; contentType: string }> = {},
): {
  client: ApiClientLike;
  calls: RecordedCall[];
  binaryCalls: string[];
} {
  const calls: RecordedCall[] = [];
  const binaryCalls: string[] = [];
  const client: ApiClientLike = {
    request: <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (!Object.hasOwn(routes, key)) {
        return Promise.reject(new Error(`unexpected API call: ${key}`));
      }
      return Promise.resolve(routes[key] as T);
    },
    requestBinary: (path: string): Promise<{ data: Uint8Array; contentType: string }> => {
      binaryCalls.push(path);
      const hit = binaries[path];
      if (hit === undefined) {
        return Promise.reject(new Error(`unexpected binary API call: ${path}`));
      }
      return Promise.resolve(hit);
    },
  };
  return { client, calls, binaryCalls };
}

const TOKEN = 'test-token-abc123';

function toolsWith(client: ApiClientLike): Map<string, ToolDefinition> {
  return new Map(buildTools(client).map((t) => [t.name, t]));
}

function toolText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

const sampleProfile = {
  id: 'prof_1',
  clientId: 'client_a',
  name: 'Client A',
  state: 'running',
  proxyRequired: false,
  lastPid: 4242,
  lastCdpPort: 9333,
  lastLaunchedAt: '2026-09-20T10:00:00.000Z',
};

const sampleScript = {
  id: 'scr_1',
  name: 'Open example',
  version: 2,
  description: 'Opens the example page',
  steps: [{ type: 'navigate', url: 'https://example.com' }],
  createdBy: 'tester',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const sampleRun = {
  id: 'run_1',
  jobId: 'job_1',
  profileId: 'prof_1',
  status: 'succeeded',
  timeoutMs: 60000,
  startedAt: '2026-09-20T10:01:00.000Z',
  finishedAt: '2026-09-20T10:01:05.000Z',
  logs: [
    { at: '2026-09-20T10:01:01.000Z', stepIndex: 0, message: 'navigating' },
    { at: '2026-09-20T10:01:04.000Z', stepIndex: 0, message: 'done' },
  ],
  result: {
    steps: [
      { index: 0, type: 'navigate', ok: true, durationMs: 1200 },
      { index: 1, type: 'getText', ok: false, durationMs: 300, output: 'partial' },
    ],
    artifacts: [{ name: '0.png', sizeBytes: 1234 }],
  },
  error: null,
  createdAt: '2026-09-20T10:01:00.000Z',
  updatedAt: '2026-09-20T10:01:05.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* (a) Tool inventory + schema validation                              */
/* ------------------------------------------------------------------ */

const EXPECTED_TOOL_NAMES = [
  'whoami',
  'list_profiles',
  'get_profile_status',
  'launch_profile',
  'stop_profile',
  'list_scripts',
  'create_script',
  'run_job',
  'list_jobs',
  'get_run_status',
  'get_run_logs',
  'get_run_artifact',
  'cancel_job',
  'audit_log',
];

const GOOD_INPUTS: Record<string, unknown> = {
  whoami: {},
  list_profiles: {},
  get_profile_status: { profileId: 'prof_1' },
  launch_profile: { profileId: 'prof_1' },
  stop_profile: { profileId: 'prof_1' },
  list_scripts: {},
  create_script: {
    name: 'demo',
    steps: [
      { type: 'navigate', url: 'https://example.com' },
      { type: 'wait', ms: 1000 },
      { type: 'waitForSelector', selector: 'h1' },
      { type: 'evaluate', expression: 'document.title' },
      { type: 'getText', selector: 'h1' },
      { type: 'screenshot', fullPage: true },
    ],
  },
  run_job: { name: 'job', scriptId: 'scr_1', profileId: 'prof_1' },
  list_jobs: {},
  get_run_status: { runId: 'run_1' },
  get_run_logs: { runId: 'run_1' },
  get_run_artifact: { runId: 'run_1', name: '0.png' },
  cancel_job: { jobId: 'job_1' },
  audit_log: { action: 'profile.launch', limit: 10 },
};

const BAD_INPUTS: Record<string, unknown> = {
  whoami: 'not-an-object',
  list_profiles: 'not-an-object',
  get_profile_status: {},
  launch_profile: { profileId: 42 },
  stop_profile: { profileId: '' },
  list_scripts: 42,
  create_script: { name: 'demo', steps: [] },
  run_job: { name: 'job', scriptId: 'scr_1' },
  list_jobs: null,
  get_run_status: { runId: 7 },
  get_run_logs: {},
  get_run_artifact: { runId: 'run_1', name: 'nope.jpg' },
  cancel_job: { jobId: '' },
  audit_log: { limit: -5 },
};

describe('tool inventory', () => {
  const { client } = createMockClient({});

  it('exposes exactly the 14 expected tools', () => {
    expect(buildTools(client).map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('every tool has a name, a useful description, and an input schema', () => {
    for (const tool of buildTools(client)) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('input schemas accept good input', () => {
    for (const tool of buildTools(client)) {
      const schema = z.object(tool.inputSchema);
      const result = schema.safeParse(defined(GOOD_INPUTS[tool.name]));
      expect(result.success, `${tool.name} should accept its good input`).toBe(true);
    }
  });

  it('input schemas reject bad input', () => {
    for (const tool of buildTools(client)) {
      const schema = z.object(tool.inputSchema);
      const result = schema.safeParse(BAD_INPUTS[tool.name]);
      expect(result.success, `${tool.name} should reject its bad input`).toBe(false);
    }
  });

  it('create_script accepts http(s) and data:text/html navigate urls, rejects the rest', () => {
    const tool = defined(toolsWith(client).get('create_script'));
    const schema = z.object(tool.inputSchema);
    const ftp = { name: 'x', steps: [{ type: 'navigate', url: 'ftp://example.com' }] };
    expect(schema.safeParse(ftp).success).toBe(false);
    const dataImage = {
      name: 'x',
      steps: [{ type: 'navigate', url: 'data:image/png;base64,AAA' }],
    };
    expect(schema.safeParse(dataImage).success).toBe(false);
    const dataHtml = {
      name: 'x',
      steps: [{ type: 'navigate', url: 'data:text/html,<h1>hi</h1>' }],
    };
    expect(schema.safeParse(dataHtml).success).toBe(true);
    const bogus = { name: 'x', steps: [{ type: 'clickAndPray' }] };
    expect(schema.safeParse(bogus).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* (b) API client: auth header, URL handling, error mapping            */
/* ------------------------------------------------------------------ */

describe('MultilogerApiClient', () => {
  function stubFetchOnce(
    response: Response | Error,
  ): Mock<(url: string, init?: RequestInit) => Promise<Response>> {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      (_url: string, _init?: RequestInit): Promise<Response> => {
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(response);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('sends the Authorization Bearer header and strips trailing slashes', async () => {
    const fetchMock = stubFetchOnce(jsonResponse(200, { profiles: [] }));
    const client = new MultilogerApiClient('http://127.0.0.1:3000/', TOKEN);
    await client.request('GET', '/v1/profiles');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = defined(fetchMock.mock.calls[0]);
    expect(url).toBe('http://127.0.0.1:3000/v1/profiles');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('maps an API error body to ApiClientError with status, code and message', async () => {
    stubFetchOnce(
      jsonResponse(404, { error: { code: 'PROFILE_NOT_FOUND', message: 'No such profile' } }),
    );
    const client = new MultilogerApiClient('http://127.0.0.1:3000', TOKEN);
    const failure: unknown = await client
      .request('GET', '/v1/profiles/nope')
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ApiClientError);
    const apiErr = failure as ApiClientError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe('PROFILE_NOT_FOUND');
    expect(apiErr.message).toContain('No such profile');
  });

  it('falls back to HTTP_<status> when the error body is not JSON', async () => {
    stubFetchOnce(new Response('boom', { status: 500 }));
    const client = new MultilogerApiClient('http://127.0.0.1:3000', TOKEN);
    const failure: unknown = await client.request('GET', '/v1/profiles').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiClientError);
    const apiErr = failure as ApiClientError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.code).toBe('HTTP_500');
  });

  it('wraps a network failure as NETWORK_ERROR with status 0', async () => {
    stubFetchOnce(new TypeError('fetch failed'));
    const client = new MultilogerApiClient('http://127.0.0.1:3000', TOKEN);
    const failure: unknown = await client.request('GET', '/v1/profiles').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiClientError);
    const apiErr = failure as ApiClientError;
    expect(apiErr.status).toBe(0);
    expect(apiErr.code).toBe('NETWORK_ERROR');
  });
});

/* ------------------------------------------------------------------ */
/* (c) Tools against a mocked client: method, path, body, output       */
/* ------------------------------------------------------------------ */

describe('tools (mocked API client)', () => {
  it('list_profiles calls GET /v1/profiles and summarizes each profile', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/profiles': { profiles: [sampleProfile] },
    });
    const result = await defined(toolsWith(client).get('list_profiles')).handler({});

    expect(calls).toEqual([{ method: 'GET', path: '/v1/profiles', body: undefined }]);
    const text = toolText(result);
    expect(text).toContain('1 profile(s)');
    expect(text).toContain('Client A (prof_1)');
    expect(text).toContain('state=running');
  });

  it('get_profile_status calls GET /v1/profiles/:id with encoding', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/profiles/prof%201': { profile: sampleProfile },
    });
    const result = await defined(toolsWith(client).get('get_profile_status')).handler({
      profileId: 'prof 1',
    });

    expect(calls).toEqual([{ method: 'GET', path: '/v1/profiles/prof%201', body: undefined }]);
    expect(toolText(result)).toContain('Client A (prof_1)');
  });

  it('launch_profile calls POST /v1/profiles/:id/launch and redacts the CDP endpoint', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/profiles/prof_1/launch': {
        profile: { ...sampleProfile, state: 'running' },
        cdp: { pid: 4242, port: 9333, cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/abc' },
      },
    });
    const result = await defined(toolsWith(client).get('launch_profile')).handler({
      profileId: 'prof_1',
    });

    expect(calls).toEqual([
      { method: 'POST', path: '/v1/profiles/prof_1/launch', body: undefined },
    ]);
    const text = toolText(result);
    expect(text).toContain('state=running');
    // The raw CDP endpoint must never reach the agent: it would allow
    // driving the browser outside the API control plane.
    expect(text).not.toContain('cdpUrl');
    expect(text).not.toContain('ws://');
    expect(text).not.toContain('9333');
  });

  it('stop_profile calls POST /v1/profiles/:id/stop', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/profiles/prof_1/stop': { profile: { ...sampleProfile, state: 'idle' } },
    });
    const result = await defined(toolsWith(client).get('stop_profile')).handler({
      profileId: 'prof_1',
    });

    expect(calls).toEqual([{ method: 'POST', path: '/v1/profiles/prof_1/stop', body: undefined }]);
    expect(toolText(result)).toContain('state=idle');
  });

  it('list_scripts calls GET /v1/automation/scripts', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/automation/scripts': { scripts: [sampleScript] },
    });
    const result = await defined(toolsWith(client).get('list_scripts')).handler({});

    expect(calls).toEqual([{ method: 'GET', path: '/v1/automation/scripts', body: undefined }]);
    expect(toolText(result)).toContain('Open example (scr_1) v2');
  });

  it('create_script POSTs name+steps and omits description when not given', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/automation/scripts': { script: sampleScript },
    });
    const steps = [{ type: 'navigate', url: 'https://example.com' }];
    const result = await defined(toolsWith(client).get('create_script')).handler({
      name: 'Open example',
      steps,
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/automation/scripts',
        body: { name: 'Open example', steps },
      },
    ]);
    expect(toolText(result)).toContain('scr_1');
  });

  it('create_script includes description when provided', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/automation/scripts': { script: sampleScript },
    });
    const steps = [{ type: 'wait', ms: 500 }];
    await defined(toolsWith(client).get('create_script')).handler({
      name: 'Waiter',
      description: 'Just waits',
      steps,
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/automation/scripts',
        body: { name: 'Waiter', steps, description: 'Just waits' },
      },
    ]);
  });

  it('run_job POSTs the job and reports job + run ids', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/automation/jobs': {
        job: {
          id: 'job_1',
          name: 'demo run',
          scriptId: 'scr_1',
          scriptVersion: 2,
          profileId: 'prof_1',
          createdBy: 'tester',
          status: 'running',
          timeoutMs: null,
          createdAt: '2026-09-20T10:00:00.000Z',
          updatedAt: '2026-09-20T10:00:00.000Z',
        },
        run: { id: 'run_1', jobId: 'job_1', profileId: 'prof_1', status: 'running' },
      },
    });
    const result = await defined(toolsWith(client).get('run_job')).handler({
      name: 'demo run',
      scriptId: 'scr_1',
      profileId: 'prof_1',
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/automation/jobs',
        body: { name: 'demo run', scriptId: 'scr_1', profileId: 'prof_1' },
      },
    ]);
    const text = toolText(result);
    expect(text).toContain('job_1');
    expect(text).toContain('run_1');
  });

  it('run_job includes optional scriptVersion and timeoutMs when provided', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/automation/jobs': {
        job: { id: 'job_2', name: 'j', scriptId: 'scr_1', scriptVersion: 1, profileId: 'prof_1' },
      },
    });
    await defined(toolsWith(client).get('run_job')).handler({
      name: 'j',
      scriptId: 'scr_1',
      scriptVersion: 1,
      profileId: 'prof_1',
      timeoutMs: 30000,
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/automation/jobs',
        body: {
          name: 'j',
          scriptId: 'scr_1',
          scriptVersion: 1,
          profileId: 'prof_1',
          timeoutMs: 30000,
        },
      },
    ]);
  });

  it('list_jobs calls GET /v1/automation/jobs', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/automation/jobs': {
        jobs: [
          {
            id: 'job_1',
            name: 'demo run',
            scriptId: 'scr_1',
            scriptVersion: 2,
            profileId: 'prof_1',
            createdBy: 'tester',
            status: 'succeeded',
            timeoutMs: null,
            createdAt: '2026-09-20T10:00:00.000Z',
            updatedAt: '2026-09-20T10:05:00.000Z',
          },
        ],
      },
    });
    const result = await defined(toolsWith(client).get('list_jobs')).handler({});

    expect(calls).toEqual([{ method: 'GET', path: '/v1/automation/jobs', body: undefined }]);
    expect(toolText(result)).toContain('demo run (job_1)');
  });

  it('get_run_status reports status, times, error, steps and artifacts', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/automation/runs/run_1': { run: { ...sampleRun, error: 'step 1 failed' } },
    });
    const result = await defined(toolsWith(client).get('get_run_status')).handler({
      runId: 'run_1',
    });

    expect(calls).toEqual([{ method: 'GET', path: '/v1/automation/runs/run_1', body: undefined }]);
    const text = toolText(result);
    expect(text).toContain('status=succeeded');
    expect(text).toContain('2026-09-20T10:01:00.000Z');
    expect(text).toContain('error: step 1 failed');
    expect(text).toContain('[0] navigate: ok (1200ms)');
    expect(text).toContain('[1] getText: FAILED (300ms)');
    expect(text).toContain('Artifacts (1):');
    expect(text).toContain('0.png (1234 bytes)');
  });

  it('get_run_status tolerates a run result without artifacts', async () => {
    const runWithoutArtifacts = {
      ...sampleRun,
      result: { steps: sampleRun.result.steps },
    };
    const { client } = createMockClient({
      'GET /v1/automation/runs/run_1': { run: runWithoutArtifacts },
    });
    const result = await defined(toolsWith(client).get('get_run_status')).handler({
      runId: 'run_1',
    });
    expect(toolText(result)).toContain('Artifacts: none.');
  });

  it('get_run_logs returns the timestamped log lines', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/automation/runs/run_1': { run: sampleRun },
    });
    const result = await defined(toolsWith(client).get('get_run_logs')).handler({
      runId: 'run_1',
    });

    expect(calls).toEqual([{ method: 'GET', path: '/v1/automation/runs/run_1', body: undefined }]);
    const text = toolText(result);
    expect(text).toContain('[2026-09-20T10:01:01.000Z] step 0: navigating');
    expect(text).toContain('[2026-09-20T10:01:04.000Z] step 0: done');
  });

  it('get_run_artifact downloads the PNG and returns it as image content', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic
    const { client, binaryCalls } = createMockClient(
      {},
      { '/v1/automation/runs/run_1/artifacts/0.png': { data: png, contentType: 'image/png' } },
    );
    const result = await defined(toolsWith(client).get('get_run_artifact')).handler({
      runId: 'run_1',
      name: '0.png',
    });

    expect(binaryCalls).toEqual(['/v1/automation/runs/run_1/artifacts/0.png']);
    expect(result.isError).not.toBe(true);
    const image = result.content.find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expect((image as { mimeType?: string }).mimeType).toBe('image/png');
    const raw = Buffer.from((image as { data?: string }).data ?? '', 'base64');
    expect([...raw]).toEqual([...png]);
  });

  it('get_run_artifact rejects non-PNG artifact names before any API call', async () => {
    const { client, binaryCalls } = createMockClient({});
    await expect(
      defined(toolsWith(client).get('get_run_artifact')).handler({
        runId: 'run_1',
        name: '../../etc/passwd',
      }),
    ).rejects.toThrow(/Artifact name must look like/);
    expect(binaryCalls).toEqual([]);
  });

  it('get_run_artifact surfaces a missing artifact as a tool error', async () => {
    const failing: ApiClientLike = {
      request: <T>(): Promise<T> => Promise.reject(new Error('unexpected')),
      requestBinary: (): Promise<{ data: Uint8Array; contentType: string }> =>
        Promise.reject(new ApiClientError(404, 'ARTIFACT_NOT_FOUND', 'No such artifact')),
    };
    const result = await defined(toolsWith(failing).get('get_run_artifact')).handler({
      runId: 'run_1',
      name: '0.png',
    });

    expect(result.isError).toBe(true);
    const text = toolText(result);
    expect(text).toContain('ARTIFACT_NOT_FOUND');
  });

  it('cancel_job calls POST /v1/automation/jobs/:id/cancel', async () => {
    const { client, calls } = createMockClient({
      'POST /v1/automation/jobs/job_1/cancel': {
        job: { id: 'job_1', name: 'demo run', status: 'cancelled' },
        cancelledRuns: 2,
      },
    });
    const result = await defined(toolsWith(client).get('cancel_job')).handler({ jobId: 'job_1' });

    expect(calls).toEqual([
      { method: 'POST', path: '/v1/automation/jobs/job_1/cancel', body: undefined },
    ]);
    const text = toolText(result);
    expect(text).toContain('status=cancelled');
    expect(text).toContain('cancelledRuns=2');
  });

  it('API errors surface as tool errors carrying the API code and message', async () => {
    const failing: ApiClientLike = {
      request: <T>(): Promise<T> =>
        Promise.reject(new ApiClientError(404, 'PROFILE_NOT_FOUND', 'No such profile')),
      requestBinary: (): Promise<{ data: Uint8Array; contentType: string }> =>
        Promise.reject(new Error('unexpected binary call')),
    };
    const result = await defined(toolsWith(failing).get('get_profile_status')).handler({
      profileId: 'nope',
    });

    expect(result.isError).toBe(true);
    const text = toolText(result);
    expect(text).toContain('PROFILE_NOT_FOUND');
    expect(text).toContain('No such profile');
  });

  it('tool output never contains the API token', async () => {
    const { client } = createMockClient({
      'GET /v1/profiles': { profiles: [sampleProfile] },
      'GET /v1/profiles/prof_1': { profile: sampleProfile },
    });
    const tools = toolsWith(client);
    const listResult = await defined(tools.get('list_profiles')).handler({});
    const statusResult = await defined(tools.get('get_profile_status')).handler({
      profileId: 'prof_1',
    });

    expect(JSON.stringify(listResult)).not.toContain(TOKEN);
    expect(JSON.stringify(statusResult)).not.toContain(TOKEN);
  });

  it('whoami reports identity, roles, permissions, and scopes', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/auth/me': {
        identity: {
          kind: 'user',
          userId: 'user_1',
          tokenId: 'tok_1',
          legacy: false,
          isAdmin: false,
          permissions: ['profiles:read', 'profiles:launch', 'audit:read'],
          scopes: ['profiles:read'],
          user: { id: 'user_1', name: 'Op', email: 'op@example.com', roles: ['operator'] },
        },
      },
    });
    const result = await defined(toolsWith(client).get('whoami')).handler({});

    expect(calls).toEqual([{ method: 'GET', path: '/v1/auth/me', body: undefined }]);
    const text = toolText(result);
    expect(text).toContain('kind: user');
    expect(text).toContain('op@example.com');
    expect(text).toContain('operator');
    expect(text).toContain('profiles:read');
    expect(result.isError).not.toBe(true);
  });

  it('audit_log queries GET /v1/audit-log with filters and renders entries', async () => {
    const { client, calls } = createMockClient({
      'GET /v1/audit-log?action=profile.launch&limit=10': {
        entries: [
          {
            id: 'audit_1',
            at: '2026-09-20T10:00:00.000Z',
            actorType: 'user',
            actorId: 'user_1',
            action: 'profile.launch',
            entityType: 'profile',
            entityId: 'prof_1',
            ip: '127.0.0.1',
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      },
    });
    const result = await defined(toolsWith(client).get('audit_log')).handler({
      action: 'profile.launch',
      limit: 10,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/audit-log?action=profile.launch&limit=10');
    const text = toolText(result);
    expect(text).toContain('profile.launch');
    expect(text).toContain('actor=user:user_1');
  });

  it('audit_log surfaces a 403 as a clear tool error (scoped token without audit:read)', async () => {
    const failing: ApiClientLike = {
      request: <T>(): Promise<T> =>
        Promise.reject(new ApiClientError(403, 'FORBIDDEN', 'Missing permission: audit:read')),
      requestBinary: (): Promise<{ data: Uint8Array; contentType: string }> =>
        Promise.reject(new Error('unexpected binary call')),
    };
    const result = await defined(toolsWith(failing).get('audit_log')).handler({});

    expect(result.isError).toBe(true);
    const text = toolText(result);
    expect(text).toContain('FORBIDDEN');
    expect(text).toContain('audit:read');
  });
});
