/**
 * Automation runner (Phase 2a).
 *
 * Executes queued runs FIFO against RUNNING profiles. The runner never
 * spawns browsers: it resolves the profile's CDP HTTP URL from the
 * ProfileManager's live set (i.e. through the API control plane), opens a
 * fresh tab via Target.createTarget, and drives it through the declarative
 * step language (automation/script.ts). The step set is the entire CDP
 * surface a script can reach — the allowlist is enforced by construction.
 *
 * Safety properties:
 * - Per-run wall-clock timeout (default 120s); timed-out runs are closed
 *   and marked 'timed_out'.
 * - Cancellation: queued runs are dropped; running runs get their CDP
 *   sessions torn down and are marked 'cancelled'.
 * - Run logs are capped (count + per-message length); step outputs are
 *   capped; screenshots go to disk as artifacts, never into the DB.
 * - Every terminal state persists partial logs so failures are debuggable.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { createCdpEventSession, getDebuggerWsUrl, type CdpEventSession } from '../browser/cdp.js';
import { automationEvents } from './events.js';
import {
  getJob,
  getRun,
  getScript,
  listQueuedRuns,
  reconcileInterruptedRuns,
  updateJobStatus,
  updateRun,
  type AutomationJobStatus,
  type AutomationRun,
  type AutomationRunStatus,
} from './repository.js';
import {
  type AutomationLogEntry,
  type AutomationResult,
  type AutomationStep,
  type StepResult,
} from './script.js';

/** Minimal profile-liveness source — the runner only needs CDP URLs. */
export interface RunnerProfileSource {
  listLive(): { profileId: string; cdpUrl: string }[];
}

/** A CDP session bound to one automation tab. */
export interface CdpPage {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onEvent(event: string, handler: (params: unknown) => void): void;
  close(): void;
}

export interface OpenedTab {
  page: CdpPage;
  closeTab(): Promise<void>;
}

/**
 * Opens a fresh tab for a run and hands back a session on it. The default
 * implementation uses raw CDP through the API-resolved debugger URL; tests
 * inject a fake.
 */
export interface AutomationCdp {
  openTab(cdpHttpUrl: string, timeoutMs: number): Promise<OpenedTab>;
}

function adaptSession(session: CdpEventSession): CdpPage {
  return {
    send: (method, params, timeoutMs) => {
      const work = session.send(method, params);
      if (timeoutMs === undefined) {
        return work;
      }
      // Per-call timeout on top of the session-level one: a hanging CDP
      // command must not outlive the step budget that requested it.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`CDP command timed out: ${method}`));
        }, timeoutMs);
      });
      return Promise.race([work, timeout]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
    },
    onEvent: (event, handler) => {
      session.onEvent(event, handler);
    },
    close: () => {
      session.close();
    },
  };
}

/** Raw-CDP tab management: createTarget → attach to the page target → drive. */
export class RawCdpAutomation implements AutomationCdp {
  async openTab(cdpHttpUrl: string, timeoutMs: number): Promise<OpenedTab> {
    const wsUrl = await getDebuggerWsUrl(cdpHttpUrl, timeoutMs);
    const browser = await createCdpEventSession(wsUrl, timeoutMs);
    try {
      const created = (await browser.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId?: string;
      };
      const targetId = created.targetId;
      if (typeof targetId !== 'string' || targetId.length === 0) {
        throw new Error('Target.createTarget returned no targetId');
      }
      const listResponse = await fetch(`${cdpHttpUrl}/json/list`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!listResponse.ok) {
        throw new Error(`CDP /json/list answered HTTP ${String(listResponse.status)}`);
      }
      const targets = (await listResponse.json()) as {
        id?: string;
        webSocketDebuggerUrl?: string;
      }[];
      const pageWs = targets.find((t) => t.id === targetId)?.webSocketDebuggerUrl;
      if (typeof pageWs !== 'string' || pageWs.length === 0) {
        throw new Error('New automation tab has no debugger URL');
      }
      const pageSession = await createCdpEventSession(pageWs, timeoutMs);
      // Page domain must be enabled for load events (navigate waits on
      // Page.loadEventFired) — without this the step would always time out.
      await pageSession.send('Page.enable', {});
      let tabClosed = false;
      const closeTab = async (): Promise<void> => {
        if (tabClosed) {
          return;
        }
        tabClosed = true;
        pageSession.close();
        try {
          await browser.send('Target.closeTarget', { targetId });
        } catch {
          // Best effort: the browser may already be gone.
        }
        browser.close();
      };
      return { page: adaptSession(pageSession), closeTab };
    } catch (error) {
      browser.close();
      throw error;
    }
  }
}

export class RunTimeoutError extends Error {
  constructor(readonly runId: string) {
    super(`Automation run ${runId} exceeded its timeout`);
    this.name = 'RunTimeoutError';
  }
}

export class RunCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`Automation run ${runId} was cancelled`);
    this.name = 'RunCancelledError';
  }
}

export interface AutomationRunnerOptions {
  db: Kysely<DatabaseSchema>;
  /** Profile liveness/CDP-URL source (ProfileManager in production). */
  profiles: RunnerProfileSource;
  /** Base dir for screenshot artifacts (<dataDir>/automation-artifacts). */
  dataDir: string;
  cdp?: AutomationCdp;
  /** Max runs executing concurrently. Default 4. */
  maxConcurrentRuns?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_ERROR_CHARS = 2000;
const POLL_INTERVAL_MS = 250;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function capOutput(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  // JSON.stringify can return undefined at runtime (functions, symbols);
  // the unknown round-trip keeps the linter from assuming lib types.
  let json: unknown;
  try {
    json = JSON.stringify(value);
  } catch {
    return '[unserializable output]';
  }
  if (typeof json !== 'string') {
    return '[unserializable output]';
  }
  if (json.length > MAX_OUTPUT_CHARS) {
    return `${json.slice(0, MAX_OUTPUT_CHARS)}…[truncated]`;
  }
  return JSON.parse(json) as unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface RunningExecution {
  cancel: () => void;
}

export class AutomationRunner {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly profiles: RunnerProfileSource;
  private readonly dataDir: string;
  private readonly cdp: AutomationCdp;
  private readonly maxConcurrentRuns: number;
  private readonly queue: string[] = [];
  private readonly running = new Map<string, RunningExecution>();
  private started = false;
  private closed = false;

  constructor(options: AutomationRunnerOptions) {
    this.db = options.db;
    this.profiles = options.profiles;
    this.dataDir = options.dataDir;
    this.cdp = options.cdp ?? new RawCdpAutomation();
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
  }

  /**
   * Start the runner: reconcile runs orphaned by a previous crash, requeue
   * anything still 'queued', and begin draining.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const interrupted = await reconcileInterruptedRuns(this.db);
    if (interrupted > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[multiloger] automation: marked ${String(interrupted)} interrupted runs as failed`,
      );
    }
    const queued = await listQueuedRuns(this.db);
    for (const run of queued) {
      this.enqueueRun(run.id);
    }
  }

  /** Queue a run id for execution (idempotent). */
  enqueueRun(runId: string): void {
    if (this.closed || this.queue.includes(runId) || this.running.has(runId)) {
      return;
    }
    this.queue.push(runId);
    this.pump();
  }

  /**
   * Whether the profile currently has a live browser instance. The API
   * layer uses this to fail job creation fast with PROFILE_NOT_RUNNING
   * instead of queueing a run that could never execute.
   */
  isProfileLive(profileId: string): boolean {
    return this.profiles.listLive().some((live) => live.profileId === profileId);
  }

  /**
   * Cancel a run. Queued runs are dropped immediately; running runs get
   * their abort flag set and CDP sessions closed. Returns true when the
   * run was queued or running (i.e. the cancel had an effect).
   */
  async cancelRun(runId: string): Promise<boolean> {
    const queuedIndex = this.queue.indexOf(runId);
    if (queuedIndex !== -1) {
      this.queue.splice(queuedIndex, 1);
      await this.finishCancelled(runId, 'cancelled before execution started');
      return true;
    }
    if (this.running.has(runId)) {
      const run = await getRun(this.db, runId).catch(() => null);
      if (run?.status === 'queued') {
        // Claimed by the pump but not started yet: finish directly so the
        // pending claim skips it.
        this.running.delete(runId);
        await this.finishCancelled(runId, 'cancelled before execution started');
        this.pump();
        return true;
      }
      this.running.get(runId)?.cancel();
      return true;
    }
    return false;
  }

  /** Stop the runner: queued runs are cancelled, running runs aborted. */
  async close(): Promise<void> {
    this.closed = true;
    const queued = [...this.queue];
    this.queue.length = 0;
    for (const runId of queued) {
      await this.finishCancelled(runId, 'runner shut down');
    }
    for (const execution of this.running.values()) {
      execution.cancel();
    }
    // Let in-flight executions persist their terminal state before the
    // server closes the database underneath them. If an execution is stuck
    // in a non-abortable await, start-up reconciliation marks it failed.
    await this.waitForSettled(60_000).catch(() => undefined);
  }

  /** Test helper: resolves when the queue is empty and nothing is running. */
  async waitForSettled(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.queue.length === 0 && this.running.size === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error('AutomationRunner.waitForSettled timed out');
      }
      await sleep(50);
    }
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.maxConcurrentRuns && this.queue.length > 0) {
      const runId = this.queue.shift();
      if (!runId) {
        return;
      }
      // Register synchronously: after pump() returns, waitForSettled() and
      // enqueueRun() must see the run as in-flight, never as vanished.
      const execution: RunningExecution = { cancel: () => undefined };
      this.running.set(runId, execution);
      void this.runClaimed(runId, execution);
    }
  }

  /**
   * The async half of the pump: skip runs that are no longer queued
   * (cancelled while claimed, or closed), otherwise execute.
   */
  private async runClaimed(runId: string, execution: RunningExecution): Promise<void> {
    // Checked before AND after the DB round-trip: cancelRun() / close() can
    // interleave while we await.
    const stillClaimed = (): boolean => !this.closed && this.running.has(runId);
    try {
      if (!stillClaimed()) {
        return;
      }
      // Skip runs that are no longer queued (cancelled externally).
      const run = await getRun(this.db, runId).catch(() => null);
      if (!stillClaimed() || run?.status !== 'queued') {
        return;
      }
      await this.executeRun(runId, execution);
    } catch (error: unknown) {
      // executeRun persists a terminal state for every failure path; this
      // is a last-resort guard against a bug leaving a run stuck.
      console.error(
        `[multiloger] automation run ${runId} escaped with:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.running.delete(runId);
      this.pump();
    }
  }

  private async finishCancelled(runId: string, reason: string): Promise<void> {
    const run = await getRun(this.db, runId).catch(() => null);
    if (!run || (run.status !== 'queued' && run.status !== 'running')) {
      return;
    }
    const now = new Date().toISOString();
    await updateRun(this.db, runId, {
      status: 'cancelled',
      finishedAt: run.startedAt === null ? null : now,
      error: reason,
    });
    await updateJobStatus(this.db, run.jobId, 'cancelled');
    automationEvents.emit({
      type: 'automation.run-status',
      runId,
      jobId: run.jobId,
      profileId: run.profileId,
      status: 'cancelled',
      at: now,
    });
  }

  private emitStatus(run: AutomationRun, status: AutomationRunStatus): void {
    automationEvents.emit({
      type: 'automation.run-status',
      runId: run.id,
      jobId: run.jobId,
      profileId: run.profileId,
      status,
      at: new Date().toISOString(),
    });
  }

  private async executeRun(runId: string, execution: RunningExecution): Promise<void> {
    let run = await getRun(this.db, runId);
    const job = await getJob(this.db, run.jobId);
    const script = await getScript(this.db, job.scriptId, job.scriptVersion);

    const abortState = { aborted: false };
    const tabRef: { tab: OpenedTab | null } = { tab: null };
    const requestCancel = (): void => {
      abortState.aborted = true;
      tabRef.tab?.page.close();
    };
    execution.cancel = requestCancel;

    const logs: AutomationLogEntry[] = [];
    const log = (stepIndex: number, message: string): void => {
      if (logs.length >= MAX_LOG_ENTRIES) {
        return;
      }
      logs.push({
        at: new Date().toISOString(),
        stepIndex,
        message: truncate(message, MAX_LOG_MESSAGE_CHARS),
      });
    };

    const startedAt = new Date().toISOString();
    run = await updateRun(this.db, runId, { status: 'running', startedAt, logs });
    await updateJobStatus(this.db, job.id, 'running');
    this.emitStatus(run, 'running');
    log(
      -1,
      `Run started: script '${script.name}' v${String(script.version)} (${String(script.steps.length)} steps)`,
    );

    const persistProgress = async (
      result: AutomationResult,
      artifactCount: number,
    ): Promise<void> => {
      run = await updateRun(this.db, runId, { logs, result, artifactCount });
    };

    const fail = async (message: string, status: AutomationRunStatus): Promise<void> => {
      const finishedAt = new Date().toISOString();
      log(-1, `Run ${status}: ${message}`);
      run = await updateRun(this.db, runId, {
        status,
        finishedAt,
        error: truncate(message, MAX_ERROR_CHARS),
        logs,
        result: run.result,
      });
      const jobStatus: AutomationJobStatus =
        status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
      await updateJobStatus(this.db, job.id, jobStatus);
      this.emitStatus(run, status);
    };

    const checkAborted = (): void => {
      if (abortState.aborted) {
        throw new RunCancelledError(runId);
      }
    };

    const runWithTimeout = async <T>(work: () => Promise<T>): Promise<T> => {
      const remaining = Math.max(1, run.timeoutMs - (Date.now() - Date.parse(startedAt)));
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new RunTimeoutError(runId));
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };

    try {
      await runWithTimeout(async () => {
        const live = this.profiles.listLive().find((p) => p.profileId === run.profileId);
        if (!live) {
          throw new Error(
            `Profile ${run.profileId} is not running — launch it before running automation`,
          );
        }
        log(-1, 'Opening automation tab');
        tabRef.tab = await this.cdp.openTab(live.cdpUrl, CONNECT_TIMEOUT_MS);
        const page = tabRef.tab.page;
        const result: AutomationResult = { steps: [], artifacts: [] };
        let artifactCount = 0;

        for (let index = 0; index < script.steps.length; index++) {
          checkAborted();
          const step = script.steps[index];
          if (!step) {
            continue;
          }
          const stepStarted = Date.now();
          log(index, `Step ${String(index)} (${step.type}): started`);
          try {
            const output = await this.executeStep(page, step, runId, index, checkAborted);
            checkAborted();
            const stepResult: StepResult = {
              index,
              type: step.type,
              ok: true,
              durationMs: Date.now() - stepStarted,
              ...(output === undefined ? {} : { output: capOutput(output) }),
            };
            if (step.type === 'screenshot') {
              artifactCount += 1;
              // Mirror the artifact into the result so API/MCP consumers can
              // list downloads without parsing step outputs.
              if (typeof output === 'object' && output !== null) {
                const record = output as { artifact?: unknown; bytes?: unknown };
                if (typeof record.artifact === 'string' && typeof record.bytes === 'number') {
                  result.artifacts.push({ name: record.artifact, sizeBytes: record.bytes });
                }
              }
            }
            result.steps.push(stepResult);
            log(
              index,
              `Step ${String(index)} (${step.type}): ok in ${String(stepResult.durationMs)}ms`,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.steps.push({
              index,
              type: step.type,
              ok: false,
              durationMs: Date.now() - stepStarted,
            });
            log(index, `Step ${String(index)} (${step.type}): FAILED — ${message}`);
            await persistProgress(result, artifactCount);
            throw error;
          }
          await persistProgress(result, artifactCount);
        }

        const finishedAt = new Date().toISOString();
        log(-1, `Run completed: ${String(result.steps.length)} steps ok`);
        run = await updateRun(this.db, runId, {
          status: 'completed',
          finishedAt,
          logs,
          result,
          artifactCount,
        });
        await updateJobStatus(this.db, job.id, 'completed');
        this.emitStatus(run, 'completed');
      });
    } catch (error) {
      if (error instanceof RunTimeoutError) {
        await fail(`Run exceeded its ${String(run.timeoutMs)}ms timeout`, 'timed_out');
      } else if (error instanceof RunCancelledError || abortState.aborted) {
        await this.finishCancelled(runId, 'cancelled during execution');
      } else {
        await fail(error instanceof Error ? error.message : String(error), 'failed');
      }
    } finally {
      if (tabRef.tab) {
        await tabRef.tab.closeTab().catch(() => undefined);
      }
    }
  }

  private artifactPath(runId: string, name: string): string {
    return join(this.dataDir, 'automation-artifacts', runId, name);
  }

  private async executeStep(
    page: CdpPage,
    step: AutomationStep,
    runId: string,
    stepIndex: number,
    checkAborted: () => void,
  ): Promise<unknown> {
    switch (step.type) {
      case 'navigate': {
        return this.stepNavigate(page, step.url, checkAborted);
      }
      case 'wait': {
        await this.abortableSleep(step.ms, checkAborted);
        return undefined;
      }
      case 'waitForSelector': {
        await this.stepWaitForSelector(page, step.selector, step.timeoutMs ?? 10_000, checkAborted);
        return undefined;
      }
      case 'evaluate': {
        return this.stepEvaluate(page, step.expression, step.timeoutMs ?? 30_000, checkAborted);
      }
      case 'getText': {
        const text = await this.stepEvaluate(
          page,
          `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); return el === null ? null : el.innerText; })()`,
          step.timeoutMs ?? 10_000,
          checkAborted,
        );
        if (text === null) {
          throw new Error(`No element matches selector '${step.selector}'`);
        }
        return text;
      }
      case 'screenshot': {
        const response = (await page.send(
          'Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: step.fullPage ?? false },
          30_000,
        )) as { data?: string };
        if (typeof response.data !== 'string' || response.data.length === 0) {
          throw new Error('Page.captureScreenshot returned no image data');
        }
        const name = `${String(stepIndex)}.png`;
        const path = this.artifactPath(runId, name);
        await mkdir(join(this.dataDir, 'automation-artifacts', runId), { recursive: true });
        const png = Buffer.from(response.data, 'base64');
        await writeFile(path, png);
        return { artifact: name, bytes: png.byteLength };
      }
    }
  }

  private async abortableSleep(ms: number, checkAborted: () => void): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      checkAborted();
      await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    }
    checkAborted();
  }

  private async stepNavigate(
    page: CdpPage,
    url: string,
    checkAborted: () => void,
  ): Promise<{ url: string }> {
    const loadState = { loaded: false };
    page.onEvent('Page.loadEventFired', () => {
      loadState.loaded = true;
    });
    await page.send('Page.navigate', { url }, 30_000);
    const deadline = Date.now() + 30_000;
    while (!loadState.loaded && Date.now() < deadline) {
      checkAborted();
      await sleep(POLL_INTERVAL_MS);
    }
    if (!loadState.loaded) {
      throw new Error(`Timed out waiting for page load: ${url}`);
    }
    return { url };
  }

  private async stepWaitForSelector(
    page: CdpPage,
    selector: string,
    timeoutMs: number,
    checkAborted: () => void,
  ): Promise<void> {
    const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      checkAborted();
      const found = await this.evaluateRaw(page, expression, 10_000);
      if (found === true) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for selector '${selector}'`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async stepEvaluate(
    page: CdpPage,
    expression: string,
    timeoutMs: number,
    checkAborted: () => void,
  ): Promise<unknown> {
    checkAborted();
    // The abort flag is also checked by the caller between steps; an
    // in-flight evaluate is bounded by its own timeout.
    return this.evaluateRaw(page, expression, timeoutMs);
  }

  private async evaluateRaw(
    page: CdpPage,
    expression: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = (await page.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    )) as {
      result?: { type?: string; value?: unknown };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails) {
      throw new Error(`Evaluate failed: ${response.exceptionDetails.text ?? 'unknown error'}`);
    }
    return response.result?.value;
  }
}
