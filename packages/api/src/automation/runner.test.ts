/**
 * Runner tests: state machine, cancellation, timeout, log capping, output
 * capping, and failure paths — all against a fake CDP layer so no browser
 * is needed. Real-Chromium coverage lives in automation.e2e.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { automationEvents, type AutomationDomainEvent } from './events.js';
import { createJob, createScript, getJob, getRun, type AutomationRun } from './repository.js';
import {
  AutomationRunner,
  type AutomationCdp,
  type CdpPage,
  type OpenedTab,
  type RunnerProfileSource,
} from './runner.js';
import type { AutomationStep } from './script.js';

// ---------------------------------------------------------------- fakes

type SendHandler = (params: Record<string, unknown> | undefined) => unknown;

class FakePage implements CdpPage {
  readonly sent: { method: string; params: Record<string, unknown> | undefined }[] = [];
  readonly handlers = new Map<string, SendHandler>();
  private readonly eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  closed = false;

  on(method: string, handler: SendHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  send(method: string, params?: Record<string, unknown>, _timeoutMs?: number): Promise<unknown> {
    this.sent.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) {
      return Promise.reject(new Error(`FakePage: unexpected CDP call ${method}`));
    }
    return Promise.resolve().then(() => handler(params));
  }

  onEvent(event: string, handler: (params: unknown) => void): void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
  }

  fire(event: string, params: unknown = {}): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      handler(params);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function evaluateResult(value: unknown): unknown {
  return { result: { type: typeof value, value } };
}

/** A page that behaves like a loaded blank tab for the common steps. */
function standardPage(overrides: { evaluate?: (expression: string) => unknown } = {}): FakePage {
  const page = new FakePage();
  page.on('Page.navigate', () => {
    setTimeout(() => {
      page.fire('Page.loadEventFired');
    }, 5);
    return {};
  });
  page.on('Runtime.evaluate', (params) => {
    const rawExpression = params?.expression;
    const expression = typeof rawExpression === 'string' ? rawExpression : '';
    if (overrides.evaluate) {
      return evaluateResult(overrides.evaluate(expression));
    }
    if (expression.includes('document.title')) {
      return evaluateResult('Fake Title');
    }
    if (expression.startsWith('!!document.querySelector')) {
      return evaluateResult(true);
    }
    if (expression.includes('innerText')) {
      return evaluateResult('hello world');
    }
    return evaluateResult(null);
  });
  page.on('Page.captureScreenshot', () => ({
    data: Buffer.from('fake-png-bytes').toString('base64'),
  }));
  return page;
}

class FakeCdp implements AutomationCdp {
  openedTabs = 0;
  closedTabs = 0;
  constructor(private readonly makePage: () => FakePage) {}

  openTab(_cdpHttpUrl: string, _timeoutMs: number): Promise<OpenedTab> {
    this.openedTabs += 1;
    const page = this.makePage();
    return Promise.resolve({
      page,
      closeTab: () => {
        this.closedTabs += 1;
        page.close();
        return Promise.resolve();
      },
    });
  }
}

const LIVE: RunnerProfileSource = {
  listLive: () => [{ profileId: 'profile-1', cdpUrl: 'http://127.0.0.1:19999' }],
};
const NOTHING_LIVE: RunnerProfileSource = { listLive: () => [] };

// ---------------------------------------------------------------- harness

describe('AutomationRunner', () => {
  let dir: string;
  let db: Kysely<DatabaseSchema>;
  let events: AutomationDomainEvent[];
  let offEvents: () => void;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-auto-'));
    db = openDatabase({ path: join(dir, 'test.db') });
    await migrateToLatest(db);
    events = [];
    offEvents = automationEvents.on((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    offEvents();
    await closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeJob(
    steps: AutomationStep[],
    opts: { timeoutMs?: number; profileId?: string } = {},
  ): Promise<{ jobId: string; runId: string }> {
    const script = await createScript(db, {
      name: `s-${String(Date.now())}-${String(Math.random())}`,
      steps,
    });
    const { job, run } = await createJob(db, {
      name: 'job',
      scriptId: script.id,
      profileId: opts.profileId ?? 'profile-1',
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return { jobId: job.id, runId: run.id };
  }

  function statuses(runId: string): string[] {
    return events.filter((e) => e.runId === runId).map((e) => e.status);
  }

  it('runs a full script to completion with per-step results and artifacts', async () => {
    const { runId } = await makeJob([
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'wait', ms: 10 },
      { type: 'waitForSelector', selector: 'h1', timeoutMs: 5000 },
      { type: 'evaluate', expression: 'document.title' },
      { type: 'getText', selector: 'h1' },
      { type: 'screenshot' },
    ]);
    const cdp = new FakeCdp(() => standardPage());
    const runner = new AutomationRunner({ db, profiles: LIVE, dataDir: dir, cdp });
    await runner.start();
    runner.enqueueRun(runId);
    await runner.waitForSettled();
    await runner.close();

    const run: AutomationRun = await getRun(db, runId);
    expect(run.status).toBe('completed');
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBeNull();
    expect(run.artifactCount).toBe(1);
    expect(run.result?.steps).toHaveLength(6);
    expect(run.result?.steps.every((s) => s.ok)).toBe(true);
    expect(run.result?.steps[3]?.output).toBe('Fake Title');
    expect(run.result?.steps[4]?.output).toBe('hello world');
    expect(run.result?.steps[5]?.output).toEqual({ artifact: '5.png', bytes: 14 });
    expect(run.result?.artifacts).toEqual([{ name: '5.png', sizeBytes: 14 }]);
    expect(run.logs.length).toBeGreaterThan(0);
    expect(cdp.openedTabs).toBe(1);
    expect(cdp.closedTabs).toBe(1);

    const job = await getJob(db, run.jobId);
    expect(job.status).toBe('completed');
    expect(statuses(runId)).toEqual(['running', 'completed']);
  });

  it('fails fast when the profile is not running', async () => {
    const { runId } = await makeJob([{ type: 'wait', ms: 10 }]);
    const runner = new AutomationRunner({
      db,
      profiles: NOTHING_LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => standardPage()),
    });
    await runner.start();
    runner.enqueueRun(runId);
    await runner.waitForSettled();
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/not running/);
    expect(run.finishedAt).not.toBeNull();
    const job = await getJob(db, run.jobId);
    expect(job.status).toBe('failed');
  });

  it('marks the run timed_out when the timeout elapses', async () => {
    // Bypass createJob's timeout validation: insert a short-timeout run
    // directly so the test stays fast.
    const hangingScript = await createScript(db, {
      name: 'hang-nav',
      steps: [{ type: 'navigate', url: 'https://example.com/' }],
    });
    const { run } = await createJob(db, {
      name: 'hang-job',
      scriptId: hangingScript.id,
      profileId: 'profile-1',
    });
    await db
      .updateTable('automation_runs')
      .set({ timeout_ms: 600 })
      .where('id', '=', run.id)
      .execute();

    const neverLoads = new FakePage();
    neverLoads.on('Page.navigate', () => ({})); // never fires loadEventFired
    const cdp = new FakeCdp(() => neverLoads);

    const runner = new AutomationRunner({ db, profiles: LIVE, dataDir: dir, cdp });
    await runner.start();
    runner.enqueueRun(run.id);
    await runner.waitForSettled();
    await runner.close();

    const finished = await getRun(db, run.id);
    expect(finished.status).toBe('timed_out');
    expect(finished.error).toMatch(/timeout/i);
    expect(statuses(run.id)).toEqual(['running', 'timed_out']);
  });

  it('cancels a running run and tears down the tab', async () => {
    const { runId } = await makeJob([
      { type: 'wait', ms: 30_000 },
      { type: 'wait', ms: 30_000 },
    ]);
    let pageRef: FakePage | undefined;
    const cdp = new FakeCdp(() => {
      pageRef = standardPage();
      return pageRef;
    });
    const runner = new AutomationRunner({ db, profiles: LIVE, dataDir: dir, cdp });
    await runner.start();
    runner.enqueueRun(runId);
    // Wait until the run is actually executing, then cancel.
    for (let i = 0; i < 100 && (await getRun(db, runId)).status !== 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await runner.cancelRun(runId)).toBe(true);
    await runner.waitForSettled();
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('cancelled');
    expect(pageRef?.closed).toBe(true);
    expect(cdp.closedTabs).toBe(1);
    const job = await getJob(db, run.jobId);
    expect(job.status).toBe('cancelled');
  });

  it('cancels a queued run before it starts', async () => {
    const first = await makeJob([{ type: 'wait', ms: 400 }]);
    const second = await makeJob([{ type: 'wait', ms: 10 }]);
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => standardPage()),
      maxConcurrentRuns: 1,
    });
    await runner.start();
    runner.enqueueRun(first.runId);
    runner.enqueueRun(second.runId);
    expect(await runner.cancelRun(second.runId)).toBe(true);
    await runner.waitForSettled();
    await runner.close();

    const cancelled = await getRun(db, second.runId);
    expect(cancelled.status).toBe('cancelled');
    const completed = await getRun(db, first.runId);
    expect(completed.status).toBe('completed');
  });

  it('close() aborts in-flight runs and persists their terminal state', async () => {
    const { runId } = await makeJob([{ type: 'wait', ms: 30_000 }]);
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => standardPage()),
    });
    await runner.start();
    runner.enqueueRun(runId);
    // Wait until the run is actually executing.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const run = await getRun(db, runId);
      if (run.status === 'running') {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('run never started');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('cancelled');
    expect(run.finishedAt).not.toBeNull();
    const job = await getJob(db, run.jobId);
    expect(job.status).toBe('cancelled');
  });

  it('runs queued runs FIFO with the concurrency cap', async () => {
    const a = await makeJob([{ type: 'wait', ms: 300 }]);
    const b = await makeJob([{ type: 'wait', ms: 10 }]);
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => standardPage()),
      maxConcurrentRuns: 1,
    });
    await runner.start();
    runner.enqueueRun(a.runId);
    runner.enqueueRun(b.runId);
    await runner.waitForSettled();
    await runner.close();

    const runA = await getRun(db, a.runId);
    const runB = await getRun(db, b.runId);
    expect(runA.status).toBe('completed');
    expect(runB.status).toBe('completed');
    // FIFO with cap 1: B cannot start before A finishes.
    expect(Date.parse(runB.startedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(runA.finishedAt ?? ''),
    );
  });

  it('records step failure with partial results and logs', async () => {
    const { runId } = await makeJob([
      { type: 'wait', ms: 10 },
      { type: 'getText', selector: '.missing' },
      { type: 'wait', ms: 10 },
    ]);
    const page = standardPage({
      evaluate: (expression) => (expression.includes('innerText') ? null : true),
    });
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => page),
    });
    await runner.start();
    runner.enqueueRun(runId);
    await runner.waitForSettled();
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/No element matches/);
    // Partial result: step 0 ok, step 1 failed, step 2 never ran.
    expect(run.result?.steps).toHaveLength(2);
    expect(run.result?.steps[0]?.ok).toBe(true);
    expect(run.result?.steps[1]?.ok).toBe(false);
    expect(run.logs.some((l) => l.message.includes('FAILED'))).toBe(true);
  });

  it('caps logs and step outputs', async () => {
    const steps: AutomationStep[] = Array.from({ length: 50 }, () => ({ type: 'wait', ms: 1 }));
    const { runId } = await makeJob(steps);
    const big = 'x'.repeat(50_000);
    const page = standardPage({ evaluate: () => big });
    const { runId: runId2 } = await makeJob([{ type: 'evaluate', expression: 'big' }]);
    const pages = [page, standardPage({ evaluate: () => big })];
    let n = 0;
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => {
        const next = pages[n++ % pages.length];
        if (!next) {
          throw new Error('FakeCdp: no page configured');
        }
        return next;
      }),
      maxConcurrentRuns: 2,
    });
    await runner.start();
    runner.enqueueRun(runId);
    runner.enqueueRun(runId2);
    await runner.waitForSettled();
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('completed');
    expect(run.logs.length).toBeLessThanOrEqual(500);

    const run2 = await getRun(db, runId2);
    const output = JSON.stringify(run2.result?.steps[0]?.output ?? null);
    expect(output.length).toBeLessThanOrEqual(10_020);
    expect(output).toMatch(/truncated/);
  });

  it('reconciles interrupted runs on start and requeues queued ones', async () => {
    const { runId } = await makeJob([{ type: 'wait', ms: 10 }]);
    // Simulate a crash: run stuck in 'running'.
    await db
      .updateTable('automation_runs')
      .set({ status: 'running', started_at: new Date().toISOString() })
      .where('id', '=', runId)
      .execute();
    const { runId: queuedId } = await makeJob([{ type: 'wait', ms: 10 }]);

    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => standardPage()),
    });
    await runner.start();
    await runner.waitForSettled();
    await runner.close();

    const interrupted = await getRun(db, runId);
    expect(interrupted.status).toBe('failed');
    expect(interrupted.error).toMatch(/restarted/);
    const requeued = await getRun(db, queuedId);
    expect(requeued.status).toBe('completed');
  });

  it('evaluate failures surface the exception message', async () => {
    const { runId } = await makeJob([{ type: 'evaluate', expression: 'boom(' }]);
    const page = new FakePage();
    page.on('Runtime.evaluate', () => ({
      exceptionDetails: { text: 'SyntaxError: Unexpected token' },
    }));
    const runner = new AutomationRunner({
      db,
      profiles: LIVE,
      dataDir: dir,
      cdp: new FakeCdp(() => page),
    });
    await runner.start();
    runner.enqueueRun(runId);
    await runner.waitForSettled();
    await runner.close();

    const run = await getRun(db, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/SyntaxError/);
  });
});
