/**
 * Automation repository tests: script versioning, job/run lifecycle,
 * error cases, and boot reconciliation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import {
  createJob,
  createScript,
  createScriptVersion,
  getJob,
  getRun,
  getScript,
  JobNotFoundError,
  listJobs,
  listQueuedRuns,
  listRuns,
  listRunsForJob,
  listScripts,
  listScriptVersions,
  reconcileInterruptedRuns,
  RunNotFoundError,
  ScriptNotFoundError,
  updateJobStatus,
  updateRun,
} from './repository.js';

const STEPS = [{ type: 'wait', ms: 10 }];

describe('automation repository', () => {
  let dir: string;
  let db: Kysely<DatabaseSchema>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-autorepo-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    await migrateToLatest(db);
  });

  afterEach(async () => {
    await closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates scripts at v1 and publishes new versions', async () => {
    const created = await createScript(db, { name: 'login', steps: STEPS });
    expect(created.version).toBe(1);
    expect(created.steps).toEqual(STEPS);

    const v2 = await createScriptVersion(db, created.id, { steps: [...STEPS, ...STEPS] });
    expect(v2.version).toBe(2);
    expect(v2.name).toBe('login');

    // getScript without version returns the latest.
    expect((await getScript(db, created.id)).version).toBe(2);
    expect((await getScript(db, created.id, 1)).version).toBe(1);
    expect(await listScriptVersions(db, created.id)).toEqual([1, 2]);

    const summaries = await listScripts(db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.versionCount).toBe(2);
  });

  it('rejects invalid scripts and unknown script ids', async () => {
    await expect(createScript(db, { name: 'bad', steps: [{ type: 'nope' }] })).rejects.toThrow();
    await expect(getScript(db, 'missing')).rejects.toBeInstanceOf(ScriptNotFoundError);
    await expect(getScript(db, 'missing', 3)).rejects.toBeInstanceOf(ScriptNotFoundError);
    await expect(createScriptVersion(db, 'missing', { steps: STEPS })).rejects.toBeInstanceOf(
      ScriptNotFoundError,
    );
  });

  it('creates a job with its first run queued', async () => {
    const script = await createScript(db, { name: 's', steps: STEPS });
    const { job, run } = await createJob(db, {
      name: 'nightly',
      scriptId: script.id,
      profileId: 'profile-1',
      createdBy: 'token-1',
    });
    expect(job.status).toBe('queued');
    expect(job.scriptVersion).toBe(1);
    expect(job.timeoutMs).toBe(120_000);
    expect(run.status).toBe('queued');
    expect(run.jobId).toBe(job.id);
    expect(run.logs).toEqual([]);

    await expect(
      createJob(db, { name: 'x', scriptId: 'missing', profileId: 'p' }),
    ).rejects.toBeInstanceOf(ScriptNotFoundError);
    await expect(
      createJob(db, { name: 'x', scriptId: script.id, profileId: 'p', timeoutMs: 5 }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(getJob(db, 'missing')).rejects.toBeInstanceOf(JobNotFoundError);
    await expect(getRun(db, 'missing')).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('pins the requested script version', async () => {
    const script = await createScript(db, { name: 's', steps: STEPS });
    await createScriptVersion(db, script.id, { steps: STEPS });
    const { job } = await createJob(db, {
      name: 'pinned',
      scriptId: script.id,
      scriptVersion: 1,
      profileId: 'p',
    });
    expect(job.scriptVersion).toBe(1);
    await expect(
      createJob(db, { name: 'x', scriptId: script.id, scriptVersion: 9, profileId: 'p' }),
    ).rejects.toBeInstanceOf(ScriptNotFoundError);
  });

  it('updates run and job statuses, lists and filters runs', async () => {
    const script = await createScript(db, { name: 's', steps: STEPS });
    const { job, run } = await createJob(db, { name: 'j', scriptId: script.id, profileId: 'p1' });
    const updated = await updateRun(db, run.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      logs: [{ at: new Date().toISOString(), stepIndex: -1, message: 'hi' }],
    });
    expect(updated.status).toBe('running');
    expect(updated.logs).toHaveLength(1);

    await updateJobStatus(db, job.id, 'running');
    expect((await getJob(db, job.id)).status).toBe('running');

    expect((await listJobs(db)).map((j) => j.id)).toContain(job.id);
    expect(await listRuns(db, { jobId: job.id })).toHaveLength(1);
    expect(await listRuns(db, { status: 'running' })).toHaveLength(1);
    expect(await listRuns(db, { status: 'queued' })).toHaveLength(0);
    expect(await listRunsForJob(db, job.id)).toHaveLength(1);
    await expect(listRunsForJob(db, 'missing')).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it('lists queued runs oldest-first', async () => {
    const script = await createScript(db, { name: 's', steps: STEPS });
    const first = await createJob(db, { name: 'a', scriptId: script.id, profileId: 'p' });
    const second = await createJob(db, { name: 'b', scriptId: script.id, profileId: 'p' });
    const queued = await listQueuedRuns(db);
    expect(queued.map((r) => r.id)).toEqual([first.run.id, second.run.id]);
  });

  it('reconcileInterruptedRuns fails stuck running runs', async () => {
    const script = await createScript(db, { name: 's', steps: STEPS });
    const { job, run } = await createJob(db, { name: 'j', scriptId: script.id, profileId: 'p' });
    await updateRun(db, run.id, { status: 'running', startedAt: new Date().toISOString() });

    expect(await reconcileInterruptedRuns(db)).toBe(1);
    const after = await getRun(db, run.id);
    expect(after.status).toBe('failed');
    expect(after.finishedAt).not.toBeNull();
    expect(after.error).toMatch(/restarted/);
    expect((await getJob(db, job.id)).status).toBe('failed');
    expect(await reconcileInterruptedRuns(db)).toBe(0);
  });
});
