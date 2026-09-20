/**
 * /v1/automation route handlers (Phase 2a).
 *
 * Scripts are versioned declarative step lists; jobs pin a script version
 * against one profile; runs are the executions. Creating a job enqueues its
 * first run with the AutomationRunner (see automation/runner.ts).
 *
 * Permission model (Phase 2; Phase 3 refines with RBAC): every route needs a
 * valid API token (enforced by the server), and job creation requires the
 * profile to exist AND be live (running) — a stopped profile gets a 409
 * PROFILE_NOT_RUNNING instead of a run that could never execute.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { getProfile } from '../profiles/repository.js';
import {
  createJob,
  createScript,
  createScriptVersion,
  getJob,
  getRun,
  getScript,
  listJobs,
  listRuns,
  listRunsForJob,
  listScripts,
  listScriptVersions,
  RUN_STATUSES,
  type AutomationJob,
  type AutomationRun,
  type AutomationScript,
  type ScriptSummary,
} from '../automation/repository.js';
import {
  defineRoute,
  getStringField,
  requireObjectBody,
  sendJson,
  ValidationError,
  type Route,
  type RouteContext,
} from './router.js';

/** Thrown when a job targets a profile with no live browser instance. */
export class ProfileNotRunningError extends Error {
  constructor(readonly profileId: string) {
    super(`Profile is not running: ${profileId}`);
    this.name = 'ProfileNotRunningError';
  }
}

/** Thrown when an artifact name fails the generated-name allowlist. */
export class InvalidArtifactNameError extends Error {
  constructor(readonly artifactName: string) {
    super(`Invalid artifact name: ${artifactName}`);
    this.name = 'InvalidArtifactNameError';
  }
}

/** Thrown when the artifact file does not exist for a known run. */
export class ArtifactNotFoundError extends Error {
  constructor(readonly artifactName: string) {
    super(`Artifact not found: ${artifactName}`);
    this.name = 'ArtifactNotFoundError';
  }
}

function publicScript(script: AutomationScript | ScriptSummary): Record<string, unknown> {
  return {
    id: script.id,
    name: script.name,
    version: script.version,
    description: script.description,
    steps: script.steps,
    createdBy: script.createdBy,
    createdAt: script.createdAt,
    updatedAt: script.updatedAt,
    ...('versionCount' in script ? { versionCount: script.versionCount } : {}),
  };
}

function publicJob(job: AutomationJob): Record<string, unknown> {
  return { ...job };
}

function publicRun(run: AutomationRun): Record<string, unknown> {
  return { ...run };
}

function validatedName(body: Record<string, unknown>, field: string): string {
  const name = getStringField(body, field, { required: true, maxLength: 200 });
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`Field must not be blank: ${field}`);
  }
  return trimmed;
}

// ---------------------------------------------------------------- scripts

async function createScriptRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = validatedName(body, 'name');
  const description = getStringField(body, 'description', { maxLength: 2000 });
  if (body.steps === undefined) {
    throw new ValidationError('Missing required field: steps');
  }
  const createdBy = ctx.token?.id;
  const script = await createScript(ctx.db, {
    name,
    ...(description !== undefined ? { description } : {}),
    steps: body.steps,
    ...(createdBy !== undefined ? { createdBy } : {}),
  });
  sendJson(ctx.res, 201, { script: publicScript(script) });
}

async function createScriptVersionRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const description = getStringField(body, 'description', { maxLength: 2000 });
  if (body.steps === undefined) {
    throw new ValidationError('Missing required field: steps');
  }
  const createdBy = ctx.token?.id;
  const script = await createScriptVersion(ctx.db, ctx.params.id ?? '', {
    ...(description !== undefined ? { description } : {}),
    steps: body.steps,
    ...(createdBy !== undefined ? { createdBy } : {}),
  });
  sendJson(ctx.res, 201, { script: publicScript(script) });
}

async function listScriptsRoute(ctx: RouteContext): Promise<void> {
  const scripts = await listScripts(ctx.db);
  sendJson(ctx.res, 200, { scripts: scripts.map(publicScript) });
}

async function getScriptRoute(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  const versionRaw = ctx.query.get('version');
  let version: number | undefined;
  if (versionRaw !== null) {
    version = Number.parseInt(versionRaw, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new ValidationError('Query parameter "version" must be a positive integer');
    }
  }
  const script = await getScript(ctx.db, id, version);
  const versions = await listScriptVersions(ctx.db, id);
  sendJson(ctx.res, 200, { script: publicScript(script), versions });
}

// ---------------------------------------------------------------- jobs

const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 1_800_000;

async function createJobRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = validatedName(body, 'name');
  const scriptId = getStringField(body, 'scriptId', { required: true });
  const profileId = getStringField(body, 'profileId', { required: true });
  const versionRaw = body.scriptVersion;
  let scriptVersion: number | undefined;
  if (versionRaw !== undefined) {
    if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw) || versionRaw < 1) {
      throw new ValidationError('Field must be a positive integer: scriptVersion');
    }
    scriptVersion = versionRaw;
  }
  const timeoutRaw = body.timeoutMs;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (
      typeof timeoutRaw !== 'number' ||
      !Number.isInteger(timeoutRaw) ||
      timeoutRaw < MIN_TIMEOUT_MS ||
      timeoutRaw > MAX_TIMEOUT_MS
    ) {
      throw new ValidationError(
        `Field must be an integer ${String(MIN_TIMEOUT_MS)}-${String(MAX_TIMEOUT_MS)}: timeoutMs`,
      );
    }
    timeoutMs = timeoutRaw;
  }
  // Fail fast on unknown profiles and scripts: same 404 semantics as the
  // profile routes. Script existence is checked before profile liveness so
  // a bad script id reports SCRIPT_NOT_FOUND even for a stopped profile.
  await getProfile(ctx.db, profileId ?? '');
  await getScript(ctx.db, scriptId ?? '', scriptVersion);
  // Fail fast on stopped profiles: a run could never execute, so queueing
  // it would only produce a confusing failure later.
  if (!ctx.automation.isProfileLive(profileId ?? '')) {
    throw new ProfileNotRunningError(profileId ?? '');
  }
  const createdBy = ctx.token?.id;
  const { job, run } = await createJob(ctx.db, {
    name,
    scriptId: scriptId ?? '',
    ...(scriptVersion !== undefined ? { scriptVersion } : {}),
    profileId: profileId ?? '',
    ...(createdBy !== undefined ? { createdBy } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  ctx.automation.enqueueRun(run.id);
  sendJson(ctx.res, 201, { job: publicJob(job), run: publicRun(run) });
}

async function listJobsRoute(ctx: RouteContext): Promise<void> {
  const jobs = await listJobs(ctx.db);
  sendJson(ctx.res, 200, { jobs: jobs.map(publicJob) });
}

async function getJobRoute(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  const job = await getJob(ctx.db, id);
  const runs = await listRunsForJob(ctx.db, id);
  sendJson(ctx.res, 200, { job: publicJob(job), runs: runs.map(publicRun) });
}

async function cancelJobRoute(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  // listRunsForJob 404s on unknown jobs.
  const runs = await listRunsForJob(ctx.db, id);
  let cancelledRuns = 0;
  for (const run of runs) {
    if (run.status === 'queued' || run.status === 'running') {
      if (await ctx.automation.cancelRun(run.id)) {
        cancelledRuns += 1;
      }
    }
  }
  sendJson(ctx.res, 200, { job: publicJob(await getJob(ctx.db, id)), cancelledRuns });
}

// ---------------------------------------------------------------- runs

async function listRunsRoute(ctx: RouteContext): Promise<void> {
  const jobId = ctx.query.get('jobId') ?? undefined;
  const profileId = ctx.query.get('profileId') ?? undefined;
  const status = ctx.query.get('status') ?? undefined;
  if (status !== undefined && !RUN_STATUSES.includes(status)) {
    throw new ValidationError(
      `Query parameter "status" must be one of: ${RUN_STATUSES.join(', ')}`,
    );
  }
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ValidationError('Query parameter "limit" must be an integer 1-200');
  }
  const runs = await listRuns(ctx.db, {
    ...(jobId !== undefined ? { jobId } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(status !== undefined ? { status } : {}),
    limit,
  });
  sendJson(ctx.res, 200, { runs: runs.map(publicRun) });
}

async function getRunRoute(ctx: RouteContext): Promise<void> {
  const run = await getRun(ctx.db, ctx.params.id ?? '');
  sendJson(ctx.res, 200, { run: publicRun(run) });
}

/** Artifact file names are server-generated (`<stepIndex>.png`); the strict
 * pattern below makes path traversal impossible. */
const ARTIFACT_NAME_PATTERN = /^[0-9]+\.png$/;

async function getArtifactRoute(ctx: RouteContext): Promise<void> {
  const runId = ctx.params.id ?? '';
  const name = ctx.params.name ?? '';
  await getRun(ctx.db, runId); // 404 when unknown
  if (!ARTIFACT_NAME_PATTERN.test(name)) {
    throw new InvalidArtifactNameError(name);
  }
  const base = resolve(join(ctx.dataDir, 'automation-artifacts', runId));
  const file = resolve(join(base, name));
  if (!file.startsWith(base + sep)) {
    // Unreachable given the pattern above; defense in depth.
    throw new InvalidArtifactNameError(name);
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    throw new ArtifactNotFoundError(name);
  }
  ctx.res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': info.size,
    'cache-control': 'private, max-age=3600',
  });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file);
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      ctx.res.off('close', onResClose);
      stream.destroy();
      if (err) {
        reject(err);
      } else {
        resolvePromise();
      }
    };
    // Client disconnect: stop reading the file and release the handler
    // instead of hanging on a dead socket. 'close' also fires after a
    // normal completion; done() is idempotent so the first event wins.
    const onResClose = (): void => {
      done();
    };
    ctx.res.on('close', onResClose);
    stream.on('error', done);
    stream.on('end', () => {
      done();
    });
    stream.pipe(ctx.res);
  });
}

export function buildAutomationRoutes(): Route[] {
  return [
    defineRoute('POST', '/v1/automation/scripts', createScriptRoute),
    defineRoute('POST', '/v1/automation/scripts/:id/versions', createScriptVersionRoute),
    defineRoute('GET', '/v1/automation/scripts', listScriptsRoute),
    defineRoute('GET', '/v1/automation/scripts/:id', getScriptRoute),
    defineRoute('POST', '/v1/automation/jobs', createJobRoute),
    defineRoute('GET', '/v1/automation/jobs', listJobsRoute),
    defineRoute('GET', '/v1/automation/jobs/:id', getJobRoute),
    defineRoute('POST', '/v1/automation/jobs/:id/cancel', cancelJobRoute),
    defineRoute('GET', '/v1/automation/runs', listRunsRoute),
    defineRoute('GET', '/v1/automation/runs/:id', getRunRoute),
    defineRoute('GET', '/v1/automation/runs/:id/artifacts/:name', getArtifactRoute),
  ];
}
