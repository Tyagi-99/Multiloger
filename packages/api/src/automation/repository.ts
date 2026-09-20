/**
 * Automation persistence: versioned scripts, jobs, and runs.
 *
 * Conventions follow the existing repositories:
 * - UUIDs generated in application code; ISO-8601 UTC timestamps.
 * - Public shapes are camelCase; the DB stays snake_case.
 * - Domain errors are typed classes mapped to HTTP in server/errors.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type {
  AutomationJobsTable,
  AutomationRunsTable,
  AutomationScriptsTable,
  DatabaseSchema,
} from '../db/schema.js';
import {
  validateSteps,
  type AutomationLogEntry,
  type AutomationResult,
  type AutomationStep,
} from './script.js';

export type AutomationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomationRunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export const JOB_STATUSES: readonly string[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];
export const RUN_STATUSES: readonly string[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

export class ScriptNotFoundError extends Error {
  readonly code = 'SCRIPT_NOT_FOUND';
  constructor(
    readonly scriptId: string,
    readonly version?: number,
  ) {
    super(
      version === undefined
        ? `Automation script not found: ${scriptId}`
        : `Automation script not found: ${scriptId} v${String(version)}`,
    );
    this.name = 'ScriptNotFoundError';
  }
}

export class JobNotFoundError extends Error {
  readonly code = 'JOB_NOT_FOUND';
  constructor(readonly jobId: string) {
    super(`Automation job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

export class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND';
  constructor(readonly runId: string) {
    super(`Automation run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export interface AutomationScript {
  id: string;
  name: string;
  version: number;
  description: string | null;
  steps: AutomationStep[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationJob {
  id: string;
  name: string;
  scriptId: string;
  scriptVersion: number;
  profileId: string;
  createdBy: string | null;
  status: AutomationJobStatus;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  jobId: string;
  profileId: string;
  status: AutomationRunStatus;
  timeoutMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  logs: AutomationLogEntry[];
  result: AutomationResult | null;
  error: string | null;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
}

function toScript(row: AutomationScriptsTable): AutomationScript {
  let steps: AutomationStep[];
  try {
    steps = validateSteps(JSON.parse(row.steps) as unknown);
  } catch {
    // Stored scripts were validated at write time; a corrupt row fails
    // loudly here rather than executing something unexpected.
    throw new Error(`Automation script ${row.id} v${String(row.version)} has corrupt steps JSON`);
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    steps,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJob(row: AutomationJobsTable): AutomationJob {
  return {
    id: row.id,
    name: row.name,
    scriptId: row.script_id,
    scriptVersion: row.script_version,
    profileId: row.profile_id,
    createdBy: row.created_by,
    status: row.status as AutomationJobStatus,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseLogs(raw: string, runId: string): AutomationLogEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('not an array');
    }
    return parsed as AutomationLogEntry[];
  } catch {
    throw new Error(`Automation run ${runId} has corrupt logs JSON`);
  }
}

function toRun(row: AutomationRunsTable): AutomationRun {
  return {
    id: row.id,
    jobId: row.job_id,
    profileId: row.profile_id,
    status: row.status as AutomationRunStatus,
    timeoutMs: row.timeout_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    logs: parseLogs(row.logs, row.id),
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as AutomationResult),
    error: row.error,
    artifactCount: row.artifact_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- scripts

export interface CreateScriptInput {
  name: string;
  description?: string;
  steps: unknown;
  createdBy?: string;
}

async function latestVersion(db: Kysely<DatabaseSchema>, id: string): Promise<number> {
  const row = await db
    .selectFrom('automation_scripts')
    .select('version')
    .where('id', '=', id)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.version ?? 0;
}

async function insertScriptVersion(
  db: Kysely<DatabaseSchema>,
  id: string,
  version: number,
  input: CreateScriptInput,
  steps: AutomationStep[],
): Promise<AutomationScript> {
  const now = nowIso();
  // The node:sqlite dialect has no RETURNING support: insert, then select.
  await db
    .insertInto('automation_scripts')
    .values({
      id,
      name: input.name,
      version,
      description: input.description ?? null,
      steps: JSON.stringify(steps),
      created_by: input.createdBy ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return getScript(db, id, version);
}

/** Create a new script at version 1. */
export async function createScript(
  db: Kysely<DatabaseSchema>,
  input: CreateScriptInput,
): Promise<AutomationScript> {
  const steps = validateSteps(input.steps);
  return insertScriptVersion(db, randomUUID(), 1, input, steps);
}

/** Publish a new version of an existing script (version = max + 1). */
export async function createScriptVersion(
  db: Kysely<DatabaseSchema>,
  scriptId: string,
  input: Omit<CreateScriptInput, 'name'>,
): Promise<AutomationScript> {
  const current = await latestVersion(db, scriptId);
  if (current === 0) {
    throw new ScriptNotFoundError(scriptId);
  }
  const existing = await db
    .selectFrom('automation_scripts')
    .select('name')
    .where('id', '=', scriptId)
    .limit(1)
    .executeTakeFirstOrThrow();
  const steps = validateSteps(input.steps);
  return insertScriptVersion(db, scriptId, current + 1, { ...input, name: existing.name }, steps);
}

/** Fetch one script version; latest when `version` is omitted. */
export async function getScript(
  db: Kysely<DatabaseSchema>,
  scriptId: string,
  version?: number,
): Promise<AutomationScript> {
  let query = db.selectFrom('automation_scripts').selectAll().where('id', '=', scriptId);
  if (version !== undefined) {
    query = query.where('version', '=', version);
  } else {
    query = query.orderBy('version', 'desc').limit(1);
  }
  const row = await query.executeTakeFirst();
  if (!row) {
    throw new ScriptNotFoundError(scriptId, version);
  }
  return toScript(row);
}

export interface ScriptSummary extends AutomationScript {
  versionCount: number;
}

/** Latest version of every script, newest first. */
export async function listScripts(db: Kysely<DatabaseSchema>): Promise<ScriptSummary[]> {
  const rows = await db
    .selectFrom('automation_scripts')
    .selectAll()
    .orderBy('updated_at', 'desc')
    .execute();
  const byId = new Map<string, AutomationScriptsTable[]>();
  for (const row of rows) {
    const list = byId.get(row.id) ?? [];
    list.push(row);
    byId.set(row.id, list);
  }
  const summaries: ScriptSummary[] = [];
  for (const versions of byId.values()) {
    versions.sort((a, b) => b.version - a.version);
    const latest = versions[0];
    if (!latest) {
      continue;
    }
    summaries.push({ ...toScript(latest), versionCount: versions.length });
  }
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return summaries;
}

/** All version numbers published for a script, ascending. */
export async function listScriptVersions(
  db: Kysely<DatabaseSchema>,
  scriptId: string,
): Promise<number[]> {
  const rows = await db
    .selectFrom('automation_scripts')
    .select('version')
    .where('id', '=', scriptId)
    .orderBy('version', 'asc')
    .execute();
  if (rows.length === 0) {
    throw new ScriptNotFoundError(scriptId);
  }
  return rows.map((row) => row.version);
}

// ---------------------------------------------------------------- jobs

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MIN_RUN_TIMEOUT_MS = 10_000;
export const MAX_RUN_TIMEOUT_MS = 1_800_000;

export interface CreateJobInput {
  name: string;
  scriptId: string;
  scriptVersion?: number;
  profileId: string;
  createdBy?: string;
  timeoutMs?: number;
}

/**
 * Create a job (status 'queued') plus its first run (status 'queued').
 * The caller must hand the run to the runner (or rely on boot requeue).
 */
export async function createJob(
  db: Kysely<DatabaseSchema>,
  input: CreateJobInput,
): Promise<{ job: AutomationJob; run: AutomationRun }> {
  // Fail fast on unknown script/version before creating anything.
  const script = await getScript(db, input.scriptId, input.scriptVersion);
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_RUN_TIMEOUT_MS ||
    timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer ${String(MIN_RUN_TIMEOUT_MS)}-${String(MAX_RUN_TIMEOUT_MS)}`,
    );
  }
  const now = nowIso();
  const jobId = randomUUID();
  const runId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('automation_jobs')
      .values({
        id: jobId,
        name: input.name,
        script_id: script.id,
        script_version: script.version,
        profile_id: input.profileId,
        created_by: input.createdBy ?? null,
        status: 'queued',
        timeout_ms: timeoutMs,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('automation_runs')
      .values({
        id: runId,
        job_id: jobId,
        profile_id: input.profileId,
        status: 'queued',
        timeout_ms: timeoutMs,
        started_at: null,
        finished_at: null,
        logs: '[]',
        result_json: null,
        error: null,
        artifact_count: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
  return { job: await getJob(db, jobId), run: await getRun(db, runId) };
}

export async function getJob(db: Kysely<DatabaseSchema>, jobId: string): Promise<AutomationJob> {
  const row = await db
    .selectFrom('automation_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!row) {
    throw new JobNotFoundError(jobId);
  }
  return toJob(row);
}

export async function listJobs(db: Kysely<DatabaseSchema>): Promise<AutomationJob[]> {
  const rows = await db
    .selectFrom('automation_jobs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toJob);
}

export async function updateJobStatus(
  db: Kysely<DatabaseSchema>,
  jobId: string,
  status: AutomationJobStatus,
): Promise<AutomationJob> {
  await db
    .updateTable('automation_jobs')
    .set({ status, updated_at: nowIso() })
    .where('id', '=', jobId)
    .execute();
  return getJob(db, jobId);
}

// ---------------------------------------------------------------- runs

export async function getRun(db: Kysely<DatabaseSchema>, runId: string): Promise<AutomationRun> {
  const row = await db
    .selectFrom('automation_runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!row) {
    throw new RunNotFoundError(runId);
  }
  return toRun(row);
}

export interface ListRunsFilter {
  jobId?: string;
  profileId?: string;
  status?: string;
  limit?: number;
}

export async function listRuns(
  db: Kysely<DatabaseSchema>,
  filter: ListRunsFilter = {},
): Promise<AutomationRun[]> {
  let query = db.selectFrom('automation_runs').selectAll();
  if (filter.jobId !== undefined) {
    query = query.where('job_id', '=', filter.jobId);
  }
  if (filter.profileId !== undefined) {
    query = query.where('profile_id', '=', filter.profileId);
  }
  if (filter.status !== undefined) {
    query = query.where('status', '=', filter.status);
  }
  const limit = filter.limit ?? 50;
  const rows = await query.orderBy('created_at', 'desc').limit(limit).execute();
  return rows.map(toRun);
}

export async function listRunsForJob(
  db: Kysely<DatabaseSchema>,
  jobId: string,
): Promise<AutomationRun[]> {
  await getJob(db, jobId); // 404 when unknown
  return listRuns(db, { jobId, limit: 200 });
}

export interface UpdateRunPatch {
  status?: AutomationRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  logs?: AutomationLogEntry[];
  result?: AutomationResult | null;
  error?: string | null;
  artifactCount?: number;
}

export async function updateRun(
  db: Kysely<DatabaseSchema>,
  runId: string,
  patch: UpdateRunPatch,
): Promise<AutomationRun> {
  const set: Partial<AutomationRunsTable> = { updated_at: nowIso() };
  if (patch.status !== undefined) {
    set.status = patch.status;
  }
  if (patch.startedAt !== undefined) {
    set.started_at = patch.startedAt;
  }
  if (patch.finishedAt !== undefined) {
    set.finished_at = patch.finishedAt;
  }
  if (patch.logs !== undefined) {
    set.logs = JSON.stringify(patch.logs);
  }
  if (patch.result !== undefined) {
    set.result_json = patch.result === null ? null : JSON.stringify(patch.result);
  }
  if (patch.error !== undefined) {
    set.error = patch.error;
  }
  if (patch.artifactCount !== undefined) {
    set.artifact_count = patch.artifactCount;
  }
  const row = await db
    .updateTable('automation_runs')
    .set(set)
    .where('id', '=', runId)
    .executeTakeFirst();
  if (row.numUpdatedRows === 0n) {
    throw new RunNotFoundError(runId);
  }
  return getRun(db, runId);
}

/**
 * Boot reconcile: runs left 'running' by a crashed server can never finish —
 * mark them failed. 'queued' runs are left alone; the runner requeues them.
 */
export async function reconcileInterruptedRuns(db: Kysely<DatabaseSchema>): Promise<number> {
  const now = nowIso();
  const interrupted = await db
    .selectFrom('automation_runs')
    .select(['id', 'job_id'])
    .where('status', '=', 'running')
    .execute();
  for (const row of interrupted) {
    await db
      .updateTable('automation_runs')
      .set({
        status: 'failed',
        finished_at: now,
        error: 'Server restarted while the run was executing',
        updated_at: now,
      })
      .where('id', '=', row.id)
      .execute();
    await updateJobStatus(db, row.job_id, 'failed');
  }
  return interrupted.length;
}

/** Runs currently waiting for a runner slot, oldest first. */
export async function listQueuedRuns(db: Kysely<DatabaseSchema>): Promise<AutomationRun[]> {
  const rows = await db
    .selectFrom('automation_runs')
    .selectAll()
    .where('status', '=', 'queued')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toRun);
}
