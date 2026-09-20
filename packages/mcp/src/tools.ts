/**
 * MCP tool definitions for the Multiloger MCP server.
 *
 * Every tool is a thin wrapper over the Multiloger REST API: tools NEVER
 * spawn browsers, NEVER touch the SQLite database, and NEVER import from
 * @multiloger/api. They only call through the injected ApiClientLike, which
 * keeps them unit-testable with a mock client.
 *
 * Tools never accept or return the API token; auth lives entirely in the
 * client, which was constructed from process env in index.ts.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ApiClientError,
  type ApiAutomationJob,
  type ApiAutomationRun,
  type ApiAutomationScript,
  type ApiClientLike,
  type ApiProfile,
} from './api-client.js';

/** A single MCP tool: name, description, zod input shape, and handler. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod raw shape; wrapped with z.object() by the MCP server on registration. */
  inputSchema: z.ZodRawShape;
  /**
   * Receives the raw tool arguments, re-validates them against the tool's
   * own zod schema, performs exactly one API call, and returns a
   * human-readable result.
   */
  handler: (args: unknown) => Promise<CallToolResult>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Map any failure into a clear tool error, surfacing the API's code+message. */
function toToolError(err: unknown): CallToolResult {
  if (err instanceof ApiClientError) {
    return errText(`API error [${err.code}] (HTTP ${String(err.status)}): ${err.message}`);
  }
  if (err instanceof z.ZodError) {
    return errText(`Invalid tool arguments: ${err.message}`);
  }
  if (err instanceof Error) {
    return errText(`Unexpected error: ${err.message}`);
  }
  return errText(`Unexpected error: ${String(err)}`);
}

/** Runs the API call and converts the outcome into a tool result. */
async function apiTool(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return okText(await run());
  } catch (err) {
    return toToolError(err);
  }
}

function oneLineProfile(p: ApiProfile): string {
  return (
    `${p.name} (${p.id}): state=${p.state}, client=${p.clientId}, ` +
    `proxyRequired=${String(p.proxyRequired)}, lastPid=${String(p.lastPid ?? '-')}, ` +
    `lastCdpPort=${String(p.lastCdpPort ?? '-')}, lastLaunchedAt=${p.lastLaunchedAt ?? '-'}`
  );
}

/* ------------------------------------------------------------------ */
/* Input schemas                                                      */
/* ------------------------------------------------------------------ */

const profileIdInput = z.object({
  profileId: z.string().min(1).describe('The profile id, e.g. "prof_abc123".'),
});

const httpUrl = z
  .string()
  .min(1)
  .refine(
    (u) => u.startsWith('http://') || u.startsWith('https://') || u.startsWith('data:text/html,'),
    {
      message: 'URL must start with http://, https://, or data:text/html,',
    },
  );

/** Declarative automation step language executed by the API's step engine. */
const stepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('navigate'),
    url: httpUrl.describe(
      'Page to open: http(s) URL, or a data:text/html, URL for a hermetic synthetic page.',
    ),
  }),
  z.object({
    type: z.literal('wait'),
    ms: z.number().int().nonnegative().describe('Fixed pause in milliseconds.'),
  }),
  z.object({
    type: z.literal('waitForSelector'),
    selector: z.string().min(1).describe('CSS selector to wait for.'),
    timeoutMs: z.number().int().positive().optional().describe('Max wait; defaults server-side.'),
  }),
  z.object({
    type: z.literal('evaluate'),
    expression: z.string().min(1).describe('JavaScript expression evaluated in the page.'),
    timeoutMs: z.number().int().positive().optional().describe('Max wait; defaults server-side.'),
  }),
  z.object({
    type: z.literal('getText'),
    selector: z.string().min(1).describe('CSS selector whose text content is returned.'),
    timeoutMs: z.number().int().positive().optional().describe('Max wait; defaults server-side.'),
  }),
  z.object({
    type: z.literal('screenshot'),
    fullPage: z.boolean().optional().describe('Capture the full scrollable page.'),
  }),
]);

const createScriptInput = z.object({
  name: z.string().min(1).describe('Human-readable script name.'),
  description: z.string().optional().describe('What the script does.'),
  steps: z
    .array(stepSchema)
    .min(1)
    .describe(
      'Ordered automation steps. Each step is one of: navigate {url}, wait {ms}, ' +
        'waitForSelector {selector, timeoutMs?}, evaluate {expression, timeoutMs?}, ' +
        'getText {selector, timeoutMs?}, screenshot {fullPage?}. Steps run in order ' +
        "via the API's declarative step engine — no arbitrary code leaves this process.",
    ),
});

const runJobInput = z.object({
  name: z.string().min(1).describe('Human-readable job name.'),
  scriptId: z.string().min(1).describe('Automation script id to execute.'),
  scriptVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Pinned script version; defaults to the latest.'),
  profileId: z.string().min(1).describe('Profile whose running browser executes the job.'),
  timeoutMs: z.number().int().positive().optional().describe('Job timeout; defaults server-side.'),
});

/* ------------------------------------------------------------------ */
/* Response envelopes (structural; extra fields are ignored)            */
/* ------------------------------------------------------------------ */

interface ProfilesResponse {
  profiles: ApiProfile[];
}

interface ProfileResponse {
  profile: ApiProfile;
}

interface ScriptsResponse {
  scripts: ApiAutomationScript[];
}

interface ScriptResponse {
  script: ApiAutomationScript;
}

interface JobsResponse {
  jobs: ApiAutomationJob[];
}

interface JobResponse {
  job: ApiAutomationJob;
  run?: { id: string; jobId: string; profileId: string; status: string };
}

interface RunResponse {
  run: ApiAutomationRun;
}

interface CancelResponse {
  job: ApiAutomationJob;
  cancelledRuns: number;
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                   */
/* ------------------------------------------------------------------ */

function buildListProfiles(client: ApiClientLike): ToolDefinition {
  const input = z.object({});
  return {
    name: 'list_profiles',
    description:
      'List all Multiloger browser profiles with their state (idle, launching, running, stopping, error, locked). Read-only.',
    inputSchema: input.shape,
    handler: async (rawArgs) => {
      input.parse(rawArgs);
      return apiTool(async () => {
        const { profiles } = await client.request<ProfilesResponse>('GET', '/v1/profiles');
        if (profiles.length === 0) return 'No profiles found.';
        const lines = profiles.map((p) => `- ${oneLineProfile(p)}`);
        return `${String(profiles.length)} profile(s):\n${lines.join('\n')}`;
      });
    },
  };
}

function buildGetProfileStatus(client: ApiClientLike): ToolDefinition {
  return {
    name: 'get_profile_status',
    description:
      'Get the full status of one profile: state, proxy requirement, last PID/CDP port and last launch time. Read-only.',
    inputSchema: profileIdInput.shape,
    handler: async (rawArgs) => {
      const args = profileIdInput.parse(rawArgs);
      return apiTool(async () => {
        const { profile } = await client.request<ProfileResponse>(
          'GET',
          `/v1/profiles/${encodeURIComponent(args.profileId)}`,
        );
        return `Profile status:\n${oneLineProfile(profile)}\n\nFull record:\n${pretty(profile)}`;
      });
    },
  };
}

function buildLaunchProfile(client: ApiClientLike): ToolDefinition {
  return {
    name: 'launch_profile',
    description:
      'Launch the Chromium browser for a profile via the Multiloger API. ' +
      'This tool only calls the API — it never spawns a browser process itself, ' +
      'and it never exposes the raw CDP endpoint: all browser interaction stays ' +
      'behind the API (use run_job for automation).',
    inputSchema: profileIdInput.shape,
    handler: async (rawArgs) => {
      const args = profileIdInput.parse(rawArgs);
      return apiTool(async () => {
        // The API also returns the CDP endpoint (pid/port/cdpUrl); we
        // deliberately do NOT surface it. Handing a raw CDP URL to an agent
        // would let it drive the browser outside the API control plane.
        const { profile } = await client.request<ProfileResponse>(
          'POST',
          `/v1/profiles/${encodeURIComponent(args.profileId)}/launch`,
        );
        return `Launched profile ${profile.name} (${profile.id}): state=${profile.state}`;
      });
    },
  };
}

function buildStopProfile(client: ApiClientLike): ToolDefinition {
  return {
    name: 'stop_profile',
    description:
      'Stop the running Chromium browser for a profile via the Multiloger API. This tool only calls the API — it never manages browser processes itself.',
    inputSchema: profileIdInput.shape,
    handler: async (rawArgs) => {
      const args = profileIdInput.parse(rawArgs);
      return apiTool(async () => {
        const { profile } = await client.request<ProfileResponse>(
          'POST',
          `/v1/profiles/${encodeURIComponent(args.profileId)}/stop`,
        );
        return `Stopped profile ${profile.name} (${profile.id}): state=${profile.state}`;
      });
    },
  };
}

function buildListScripts(client: ApiClientLike): ToolDefinition {
  return {
    name: 'list_scripts',
    description: 'List all saved automation scripts (id, name, version, description). Read-only.',
    inputSchema: z.object({}).shape,
    handler: async (rawArgs) => {
      z.object({}).parse(rawArgs);
      return apiTool(async () => {
        const { scripts } = await client.request<ScriptsResponse>('GET', '/v1/automation/scripts');
        if (scripts.length === 0) return 'No automation scripts found.';
        const lines = scripts.map(
          (s) =>
            `- ${s.name} (${s.id}) v${String(s.version)}` +
            (s.description ? ` — ${s.description}` : '') +
            ` [${String(s.steps.length)} step(s)]`,
        );
        return `${String(scripts.length)} script(s):\n${lines.join('\n')}`;
      });
    },
  };
}

function buildCreateScript(client: ApiClientLike): ToolDefinition {
  return {
    name: 'create_script',
    description:
      'Create a reusable automation script: an ordered list of declarative steps ' +
      '(navigate, wait, waitForSelector, evaluate, getText, screenshot). Steps execute ' +
      "inside the API's sandboxed step engine against a profile's already-running browser; " +
      'this tool performs no browsing itself.',
    inputSchema: createScriptInput.shape,
    handler: async (rawArgs) => {
      const args = createScriptInput.parse(rawArgs);
      return apiTool(async () => {
        const body: { name: string; description?: string; steps: unknown[] } = {
          name: args.name,
          steps: args.steps,
        };
        if (args.description !== undefined) body.description = args.description;
        const { script } = await client.request<ScriptResponse>(
          'POST',
          '/v1/automation/scripts',
          body,
        );
        return (
          `Created script ${script.name} (${script.id}) v${String(script.version)} ` +
          `with ${String(script.steps.length)} step(s).\n${pretty(script)}`
        );
      });
    },
  };
}

function buildRunJob(client: ApiClientLike): ToolDefinition {
  return {
    name: 'run_job',
    description:
      'Start an automation job that runs a saved script against a profile. SAFETY: the job ' +
      "only runs against the profile's already-running browser — this tool never launches " +
      'a browser, and it never runs unless that profile is already in "running" state. ' +
      'Returns the job and its first run; poll get_run_status for completion.',
    inputSchema: runJobInput.shape,
    handler: async (rawArgs) => {
      const args = runJobInput.parse(rawArgs);
      return apiTool(async () => {
        const body: {
          name: string;
          scriptId: string;
          scriptVersion?: number;
          profileId: string;
          timeoutMs?: number;
        } = { name: args.name, scriptId: args.scriptId, profileId: args.profileId };
        if (args.scriptVersion !== undefined) body.scriptVersion = args.scriptVersion;
        if (args.timeoutMs !== undefined) body.timeoutMs = args.timeoutMs;
        const { job, run } = await client.request<JobResponse>('POST', '/v1/automation/jobs', body);
        const runLine = run
          ? `Run ${run.id}: status=${run.status}, profile=${run.profileId}`
          : 'No run started yet.';
        return (
          `Started job ${job.name} (${job.id}): status=${job.status}, ` +
          `script=${job.scriptId} (v${String(job.scriptVersion ?? 'latest')}), profile=${job.profileId}\n${runLine}`
        );
      });
    },
  };
}

function buildListJobs(client: ApiClientLike): ToolDefinition {
  return {
    name: 'list_jobs',
    description: 'List all automation jobs with their current status. Read-only.',
    inputSchema: z.object({}).shape,
    handler: async (rawArgs) => {
      z.object({}).parse(rawArgs);
      return apiTool(async () => {
        const { jobs } = await client.request<JobsResponse>('GET', '/v1/automation/jobs');
        if (jobs.length === 0) return 'No automation jobs found.';
        const lines = jobs.map(
          (j) =>
            `- ${j.name} (${j.id}): status=${j.status}, script=${j.scriptId} ` +
            `(v${String(j.scriptVersion ?? 'latest')}), profile=${j.profileId}`,
        );
        return `${String(jobs.length)} job(s):\n${lines.join('\n')}`;
      });
    },
  };
}

function stepSummary(run: ApiAutomationRun): string {
  if (run.result === null || run.result.steps.length === 0) return 'No step results yet.';
  return run.result.steps
    .map(
      (s) =>
        `  [${String(s.index)}] ${s.type}: ${s.ok ? 'ok' : 'FAILED'} (${String(s.durationMs)}ms)` +
        (s.output !== undefined ? ` output=${JSON.stringify(s.output)}` : ''),
    )
    .join('\n');
}

function artifactSummary(run: ApiAutomationRun): string {
  const artifacts = run.result?.artifacts ?? [];
  if (artifacts.length === 0) return 'Artifacts: none.';
  const lines = artifacts.map((a) => `  - ${a.name} (${String(a.sizeBytes)} bytes)`);
  return `Artifacts (${String(artifacts.length)}):\n${lines.join('\n')}\nUse get_run_artifact to download one.`;
}

function buildGetRunStatus(client: ApiClientLike): ToolDefinition {
  const input = z.object({
    runId: z.string().min(1).describe('The automation run id, e.g. "run_abc123".'),
  });
  return {
    name: 'get_run_status',
    description:
      "Get an automation run's status, start/finish times, error (if any), per-step summary " +
      '(index, type, ok, durationMs), and the list of captured artifacts (e.g. screenshots). Read-only.',
    inputSchema: input.shape,
    handler: async (rawArgs) => {
      const args = input.parse(rawArgs);
      return apiTool(async () => {
        const { run } = await client.request<RunResponse>(
          'GET',
          `/v1/automation/runs/${encodeURIComponent(args.runId)}`,
        );
        const header =
          `Run ${run.id} (job ${run.jobId}, profile ${run.profileId}): status=${run.status}\n` +
          `startedAt=${run.startedAt ?? '-'} finishedAt=${run.finishedAt ?? '-'}`;
        const errorLine = run.error !== null ? `\nerror: ${run.error}` : '';
        return `${header}${errorLine}\nSteps:\n${stepSummary(run)}\n${artifactSummary(run)}`;
      });
    },
  };
}

function buildGetRunLogs(client: ApiClientLike): ToolDefinition {
  const input = z.object({
    runId: z.string().min(1).describe('The automation run id, e.g. "run_abc123".'),
  });
  return {
    name: 'get_run_logs',
    description:
      'Get the timestamped log lines of an automation run (at, stepIndex, message). Read-only.',
    inputSchema: input.shape,
    handler: async (rawArgs) => {
      const args = input.parse(rawArgs);
      return apiTool(async () => {
        const { run } = await client.request<RunResponse>(
          'GET',
          `/v1/automation/runs/${encodeURIComponent(args.runId)}`,
        );
        if (run.logs.length === 0) return `Run ${run.id}: no log lines yet.`;
        const lines = run.logs.map((l) => `[${l.at}] step ${String(l.stepIndex)}: ${l.message}`);
        return `Run ${run.id} logs (${String(run.logs.length)} line(s)):\n${lines.join('\n')}`;
      });
    },
  };
}

function buildGetRunArtifact(client: ApiClientLike): ToolDefinition {
  const input = z.object({
    runId: z.string().min(1).describe('The automation run id, e.g. "run_abc123".'),
    name: z
      .string()
      .regex(/^\d+\.png$/, { message: 'Artifact name must look like "0.png", "1.png", …' })
      .describe('Artifact file name as listed by get_run_status (e.g. "0.png").'),
  });
  return {
    name: 'get_run_artifact',
    description:
      'Download one screenshot artifact from an automation run and return it as an image ' +
      'so you can see what the browser captured. Read-only.',
    inputSchema: input.shape,
    handler: async (rawArgs) => {
      const args = input.parse(rawArgs);
      try {
        const { data, contentType } = await client.requestBinary(
          `/v1/automation/runs/${encodeURIComponent(args.runId)}/artifacts/${args.name}`,
        );
        if (contentType !== 'image/png') {
          return errText(`Unexpected artifact content type: ${contentType}`);
        }
        return {
          content: [
            {
              type: 'image' as const,
              data: Buffer.from(data).toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text' as const,
              text: `Screenshot ${args.name} from run ${args.runId} (${String(data.length)} bytes).`,
            },
          ],
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  };
}

function buildCancelJob(client: ApiClientLike): ToolDefinition {
  const input = z.object({
    jobId: z.string().min(1).describe('The automation job id, e.g. "job_abc123".'),
  });
  return {
    name: 'cancel_job',
    description:
      'Cancel an automation job and its in-flight runs. Returns the job status and the number of runs cancelled.',
    inputSchema: input.shape,
    handler: async (rawArgs) => {
      const args = input.parse(rawArgs);
      return apiTool(async () => {
        const { job, cancelledRuns } = await client.request<CancelResponse>(
          'POST',
          `/v1/automation/jobs/${encodeURIComponent(args.jobId)}/cancel`,
        );
        return `Cancelled job ${job.name} (${job.id}): status=${job.status}, cancelledRuns=${String(cancelledRuns)}`;
      });
    },
  };
}

/** Build all tool definitions bound to the given API client. */
export function buildTools(client: ApiClientLike): ToolDefinition[] {
  return [
    buildListProfiles(client),
    buildGetProfileStatus(client),
    buildLaunchProfile(client),
    buildStopProfile(client),
    buildListScripts(client),
    buildCreateScript(client),
    buildRunJob(client),
    buildListJobs(client),
    buildGetRunStatus(client),
    buildGetRunLogs(client),
    buildGetRunArtifact(client),
    buildCancelJob(client),
  ];
}
