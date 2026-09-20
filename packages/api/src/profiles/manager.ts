/**
 * ProfileManager — the single owner of browser processes.
 *
 * Launch flow:  acquire lock → launching → spawn Chromium → CDP ready →
 * running. The lock is held for the whole session and heartbeated, so no
 * second manager (or API request) can double-launch a profile.
 *
 * Stop flow: running/launching → stopping → SIGTERM (graceful) → SIGKILL
 * escalation → stopped. Chromium treats SIGTERM as a clean shutdown
 * request, so this is equivalent to CDP Browser.close without needing a
 * WebSocket client in the MVP.
 *
 * Crash detection: the child 'exit' event fires on any unexpected death
 * (→ crashed); a monitor interval additionally watches process liveness
 * and CDP health as a backstop.
 */

import type { ChildProcess } from 'node:child_process';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import type { LaunchedBrowser } from '../browser/launcher.js';
import type { ProxyFlagOptions } from '../browser/flags.js';
import { killBrowserGroup, launchChromium, pingCdp } from '../browser/launcher.js';
import { getState, transitionState } from './stateMachine.js';
import { IllegalTransitionError } from './states.js';
import { acquireLock, heartbeatLock, newOwnerToken, releaseLock } from './lock.js';
import { getProfile } from './repository.js';
import { endSession, startSession, type SessionExitReason } from './sessions.js';

export class AlreadyRunningError extends Error {
  readonly code = 'ALREADY_RUNNING';
  constructor(readonly profileId: string) {
    super(`Profile ${profileId} is already running in this manager`);
    this.name = 'AlreadyRunningError';
  }
}

export class ProfileBusyError extends Error {
  readonly code = 'PROFILE_BUSY';
  constructor(readonly profileId: string) {
    super(`Profile ${profileId} is locked by another owner`);
    this.name = 'ProfileBusyError';
  }
}

export class ProfileNotManagedError extends Error {
  readonly code = 'NOT_MANAGED';
  constructor(
    readonly profileId: string,
    readonly state: string,
  ) {
    super(
      `Profile ${profileId} is in state '${state}' but not managed by this process; ` +
        'run the startup reaper to reconcile it',
    );
    this.name = 'ProfileNotManagedError';
  }
}

export class ProfileStopTimeoutError extends Error {
  readonly code = 'STOP_TIMEOUT';
  constructor(readonly profileId: string) {
    super(`Profile ${profileId} browser did not die after SIGKILL`);
    this.name = 'ProfileStopTimeoutError';
  }
}

export interface LiveProfileInfo {
  profileId: string;
  pid: number;
  port: number;
  cdpUrl: string;
}

interface LiveProfile extends LiveProfileInfo {
  owner: string;
  process: ChildProcess;
  sessionId: string;
  /** True once stopProfile() has been called — the exit event then finalizes a stop, not a crash. */
  stopping: boolean;
  /** Guards finalize/crash paths against double execution. */
  settled: boolean;
  consecutiveCdpFailures: number;
}

/** Task 6 seam: resolves proxy flags for a profile before launch. */
export type ProxyResolver = (profileId: string) => Promise<ProxyFlagOptions | undefined>;

export interface ProfileManagerOptions {
  /** Root directory all profile user-data dirs live under (used for orphan scans). */
  dataDir: string;
  /** Lock TTL in ms; heartbeated at TTL/3 while a profile is live. Default 30s. */
  lockTtlMs?: number;
  /** Default headless mode for launches. Default true. */
  headless?: boolean;
  /** How often to check process liveness + CDP health. Default 10s. */
  monitorIntervalMs?: number;
  /** Optional proxy resolution hook (wired by Task 6). */
  resolveProxy?: ProxyResolver;
}

export type LaunchResult = LiveProfileInfo;

function nowIso(): string {
  return new Date().toISOString();
}

/** True when a PID exists (EPERM counts as alive — it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class ProfileManager {
  private readonly db: Kysely<DatabaseSchema>;
  private readonly dataDir: string;
  private readonly lockTtlMs: number;
  private readonly headless: boolean;
  private readonly monitorIntervalMs: number;
  private readonly resolveProxy: ProxyResolver | undefined;
  private readonly live = new Map<string, LiveProfile>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(db: Kysely<DatabaseSchema>, options: ProfileManagerOptions) {
    this.db = db;
    this.dataDir = options.dataDir;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.headless = options.headless ?? true;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 10_000;
    this.resolveProxy = options.resolveProxy;
  }

  get managedDataDir(): string {
    return this.dataDir;
  }

  /** Start heartbeat + monitor loops. Call once after construction. */
  start(): void {
    if (this.heartbeatTimer || this.closed) {
      return;
    }
    const beatEvery = Math.max(1000, Math.floor(this.lockTtlMs / 3));
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatAll();
    }, beatEvery);
    this.heartbeatTimer.unref();
    this.monitorTimer = setInterval(() => {
      void this.monitorAll();
    }, this.monitorIntervalMs);
    this.monitorTimer.unref();
  }

  /** Stop every live browser and shut down the loops. Safe to call in tests. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    const ids = [...this.live.keys()];
    await Promise.allSettled(ids.map((id) => this.stopProfile(id)));
  }

  listLive(): LiveProfileInfo[] {
    return [...this.live.values()].map(({ profileId, pid, port, cdpUrl }) => ({
      profileId,
      pid,
      port,
      cdpUrl,
    }));
  }

  isLive(profileId: string): boolean {
    return this.live.has(profileId);
  }

  // ---------------------------------------------------------------- launch

  async launchProfile(profileId: string, headless?: boolean): Promise<LaunchResult> {
    if (this.live.has(profileId)) {
      throw new AlreadyRunningError(profileId);
    }
    const profile = await getProfile(this.db, profileId);

    const owner = newOwnerToken();
    const locked = await acquireLock(this.db, profileId, owner, this.lockTtlMs);
    if (!locked) {
      throw new ProfileBusyError(profileId);
    }

    const releaseOnFailure = async (): Promise<void> => {
      await releaseLock(this.db, profileId, owner);
    };

    try {
      await transitionState(this.db, profileId, 'launching');
    } catch (error) {
      await releaseOnFailure();
      throw error;
    }

    const proxy = this.resolveProxy ? await this.resolveProxy(profileId) : undefined;
    let browser: LaunchedBrowser;
    try {
      browser = await launchChromium({
        userDataDir: profile.user_data_dir,
        headless: headless ?? this.headless,
        proxy,
      });
    } catch (error) {
      await this.markLaunchFailed(profileId, owner, 'error');
      throw error;
    }

    // Register before marking running so a crash in the gap is handled.
    const sessionId = await startSession(this.db, profileId, browser.pid, browser.port);
    const entry: LiveProfile = {
      profileId,
      owner,
      process: browser.process,
      pid: browser.pid,
      port: browser.port,
      cdpUrl: browser.cdpUrl,
      sessionId,
      stopping: false,
      settled: false,
      consecutiveCdpFailures: 0,
    };
    browser.process.on('exit', () => {
      void this.handleProcessExit(entry);
    });
    this.live.set(profileId, entry);

    try {
      await transitionState(this.db, profileId, 'running');
    } catch (error) {
      await this.abortLaunchedEntry(entry);
      throw error;
    }

    await this.db
      .updateTable('profiles')
      .set({ last_pid: browser.pid, last_cdp_port: browser.port, last_launched_at: nowIso() })
      .where('id', '=', profileId)
      .execute();

    return { profileId, pid: browser.pid, port: browser.port, cdpUrl: browser.cdpUrl };
  }

  private async markLaunchFailed(
    profileId: string,
    owner: string,
    state: 'error',
  ): Promise<void> {
    try {
      const current = await getState(this.db, profileId);
      if (current === 'launching') {
        await transitionState(this.db, profileId, state);
      }
    } catch {
      // Best effort: the launch already failed; don't mask the original error.
    }
    await releaseLock(this.db, profileId, owner);
  }

  /** Kill a browser whose launch succeeded but bookkeeping failed. */
  private async abortLaunchedEntry(entry: LiveProfile): Promise<void> {
    this.live.delete(entry.profileId);
    entry.settled = true;
    killBrowserGroup(entry.pid, 'SIGKILL');
    await endSession(this.db, entry.sessionId, 'error').catch(() => undefined);
    try {
      const state = await getState(this.db, entry.profileId);
      if (state === 'launching') {
        await transitionState(this.db, entry.profileId, 'error');
      }
    } catch {
      // Best effort: the launch already failed; don't mask the original error.
    }
    await releaseLock(this.db, entry.profileId, entry.owner);
  }

  // ----------------------------------------------------------------- stop

  /**
   * Stop a profile. Idempotent for stopped profiles; acknowledges crashed /
   * error profiles by moving them to stopped. Throws ProfileNotManagedError
   * when the DB says running/launching/stopping but this manager has no live
   * entry (a previous manager died — run the reaper).
   */
  async stopProfile(profileId: string, timeoutMs = 5000): Promise<void> {
    const entry = this.live.get(profileId);
    if (!entry) {
      await this.stopUnmanaged(profileId);
      return;
    }
    entry.stopping = true;

    const state = await getState(this.db, profileId);
    if (state === 'running' || state === 'launching') {
      await transitionState(this.db, profileId, 'stopping');
    }
    // From 'error'/'crashed'/'stopping' we go straight to termination; the
    // final transition lands on 'stopped', which is legal from all of them.

    await this.terminateEntry(entry, timeoutMs);
    await this.finalizeStop(entry, 'stopped');
  }

  private async stopUnmanaged(profileId: string): Promise<void> {
    const state = await getState(this.db, profileId);
    if (state === 'stopped' || state === 'created') {
      // Never launched, or already stopped: stopping is a no-op.
      return;
    }
    if (state === 'crashed' || state === 'error') {
      const owner = newOwnerToken();
      if (!(await acquireLock(this.db, profileId, owner, this.lockTtlMs))) {
        throw new ProfileBusyError(profileId);
      }
      try {
        await transitionState(this.db, profileId, 'stopped');
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) {
          throw error;
        }
      } finally {
        await releaseLock(this.db, profileId, owner);
      }
      return;
    }
    throw new ProfileNotManagedError(profileId, state);
  }

  /**
   * SIGTERM (graceful — Chromium shuts down cleanly on it), wait, then
   * SIGKILL. Polls PID liveness instead of relying on the child's 'exit'
   * event so there is exactly one finalization path (stopProfile below);
   * the exit handler stands down while `stopping` is set.
   */
  private async terminateEntry(entry: LiveProfile, timeoutMs: number): Promise<void> {
    if (!pidAlive(entry.pid)) {
      return;
    }
    try {
      // Negative PID = whole process group.
      process.kill(-entry.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
      return;
    }

    if (await this.waitForDeath(entry.pid, timeoutMs)) {
      return;
    }
    killBrowserGroup(entry.pid, 'SIGKILL');
    if (!(await this.waitForDeath(entry.pid, 5000))) {
      throw new ProfileStopTimeoutError(entry.profileId);
    }
  }

  private async waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!pidAlive(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !pidAlive(pid);
  }

  private async finalizeStop(entry: LiveProfile, reason: SessionExitReason): Promise<void> {
    if (entry.settled || !this.live.has(entry.profileId)) {
      return;
    }
    entry.settled = true;
    this.live.delete(entry.profileId);

    await endSession(this.db, entry.sessionId, reason).catch(() => undefined);
    try {
      await transitionState(this.db, entry.profileId, 'stopped');
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) {
        throw error;
      }
    }
    await this.db
      .updateTable('profiles')
      .set({ last_pid: null, last_cdp_port: null })
      .where('id', '=', entry.profileId)
      .execute()
      .catch(() => undefined);
    await releaseLock(this.db, entry.profileId, entry.owner);
  }

  async restartProfile(profileId: string, headless?: boolean): Promise<LaunchResult> {
    await this.stopProfile(profileId);
    return this.launchProfile(profileId, headless);
  }

  // ---------------------------------------------------------------- crash

  private async handleProcessExit(entry: LiveProfile): Promise<void> {
    if (entry.stopping) {
      // stopProfile() owns finalization: it polls PID death itself and then
      // finalizes exactly once. Standing down here removes the race between
      // the floating exit handler and stopProfile's return.
      return;
    }
    await this.handleCrash(entry);
  }

  private async handleCrash(entry: LiveProfile): Promise<void> {
    if (entry.settled || !this.live.has(entry.profileId)) {
      return;
    }
    entry.settled = true;
    this.live.delete(entry.profileId);

    await endSession(this.db, entry.sessionId, 'crashed').catch(() => undefined);
    try {
      const state = await getState(this.db, entry.profileId);
      if (state === 'launching' || state === 'running' || state === 'stopping') {
        await transitionState(this.db, entry.profileId, 'crashed');
      }
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) {
        throw error;
      }
    }
    await releaseLock(this.db, entry.profileId, entry.owner);
  }

  // ------------------------------------------------------- loops

  private async heartbeatAll(): Promise<void> {
    for (const entry of this.live.values()) {
      const ok = await heartbeatLock(this.db, entry.profileId, entry.owner).catch(
        () => false,
      );
      if (!ok) {
        // Lock lost (should not happen) — log loudly; the profile keeps
        // running but a new launch could now double-start it.
        console.error(
          `[multiloger] lost lock heartbeat for profile ${entry.profileId}; ` +
            'lock may be stolen — investigate',
        );
      }
    }
  }

  private async monitorAll(): Promise<void> {
    for (const entry of [...this.live.values()]) {
      if (entry.stopping || entry.settled) {
        continue;
      }
      if (!pidAlive(entry.pid)) {
        await this.handleCrash(entry);
        continue;
      }
      const cdpOk = await pingCdp(entry.cdpUrl, 2000);
      if (cdpOk) {
        entry.consecutiveCdpFailures = 0;
        continue;
      }
      entry.consecutiveCdpFailures += 1;
      if (entry.consecutiveCdpFailures >= 3) {
        // Browser alive but CDP wedged — mark error; stopProfile still works.
        try {
          const state = await getState(this.db, entry.profileId);
          if (state === 'running') {
            await transitionState(this.db, entry.profileId, 'error');
          }
        } catch {
          // Best effort; the next cycle retries.
        }
      }
    }
  }
}
