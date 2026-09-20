/**
 * ResourceManager: concurrency cap, FIFO launch queue, disk watermark,
 * and conservative opt-in idle shutdown.
 *
 * Slot lifecycle (owned by ProfileManager):
 * - `acquire(profileId)` before lock acquisition: disk watermark first
 *   (fail fast), then immediate admission when under the cap, else FIFO
 *   queue with timeout. Resolves once a slot is HELD.
 * - `release(profileId)` when the profile stops or crashes: the slot
 *   transfers directly to the queue head (no steal race); idempotent.
 *
 * Idle shutdown is DISABLED by default (`idleShutdownMs: 0`). When enabled,
 * "idle" means no manager interaction (launch/stop/noteActivity) for the
 * period — a conservative, documented definition. The `onIdleProfile`
 * callback (wired by the server) decides whether the profile is actually
 * in a stoppable state; the manager never stops blindly from here.
 */

import { profileEvents } from '../profiles/events.js';
import { assertDiskWatermark } from './disk.js';
import { LaunchQueue, LaunchQueueTimeoutError } from './queue.js';

export { InsufficientDiskSpaceError } from './disk.js';
export { LaunchQueueTimeoutError } from './queue.js';

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
export const DEFAULT_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface ResourceManagerOptions {
  /** Root dir checked for the disk watermark. */
  dataDir: string;
  /** Max concurrently RUNNING Chromium instances. Default 4. */
  maxConcurrent?: number;
  /** Max ms a launch waits for a slot. Default 60s. */
  queueTimeoutMs?: number;
  /** Stop profiles idle longer than this. 0 = disabled (default). */
  idleShutdownMs?: number;
  /** Refuse launches below this free space. Default 1 GiB. 0 disables. */
  minFreeDiskBytes?: number;
  /** Check the watermark before every launch. Default true. */
  checkDiskBeforeLaunch?: boolean;
  /**
   * Called when a profile has been idle past idleShutdownMs. The callback
   * (not this manager) verifies stoppability and stops it.
   */
  onIdleProfile?: (profileId: string, idleMs: number) => void;
}

export interface ResourceStatus {
  maxConcurrent: number;
  running: number;
  queued: string[];
  idleShutdownMs: number;
  minFreeDiskBytes: number;
}

export class ResourceManager {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private readonly idleShutdownMs: number;
  private readonly minFreeDiskBytes: number;
  private readonly checkDisk: boolean;
  /**
   * Called when a profile has been idle past idleShutdownMs. The server
   * assigns this after the ProfileManager exists; the manager never stops
   * blindly — the callback verifies stoppability and stops it.
   */
  public onIdleProfile: ((profileId: string, idleMs: number) => void) | undefined;
  private readonly dataDir: string;

  private readonly queue: LaunchQueue;
  private readonly held = new Set<string>();
  private runningCount = 0;
  private readonly lastActivity = new Map<string, number>();
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: ResourceManagerOptions) {
    this.dataDir = options.dataDir;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.idleShutdownMs = options.idleShutdownMs ?? 0;
    this.minFreeDiskBytes = options.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
    this.checkDisk = options.checkDiskBeforeLaunch ?? true;
    this.onIdleProfile = options.onIdleProfile;
    this.queue = new LaunchQueue(this.queueTimeoutMs);

    if (this.idleShutdownMs > 0) {
      const interval = Math.min(Math.max(1000, Math.floor(this.idleShutdownMs / 2)), 30_000);
      this.idleTimer = setInterval(() => {
        try {
          this.reapIdle();
        } catch {
          // A failing reaper must not kill the interval loop.
        }
      }, interval);
      this.idleTimer.unref();
    }
  }

  /**
   * Hold a slot for profileId. Disk watermark first (fail fast), then
   * immediate admission or FIFO queue. Throws InsufficientDiskSpaceError
   * or LaunchQueueTimeoutError. Idempotent for already-held ids.
   */
  async acquire(profileId: string): Promise<void> {
    if (this.closed) {
      throw new Error('ResourceManager is closed');
    }
    if (this.held.has(profileId)) {
      return;
    }
    if (this.checkDisk) {
      await assertDiskWatermark(this.dataDir, this.minFreeDiskBytes);
    }
    if (this.runningCount < this.maxConcurrent) {
      this.runningCount += 1;
      this.held.add(profileId);
      this.touch(profileId);
      return;
    }
    const position = this.queue.length + 1;
    profileEvents.emit({
      type: 'profile.launch-queued',
      profileId,
      position,
      at: new Date().toISOString(),
    });
    const enqueuedAt = Date.now();
    try {
      await this.queue.enqueue(profileId);
    } catch (error) {
      if (error instanceof LaunchQueueTimeoutError) {
        profileEvents.emit({
          type: 'profile.launch-queue-timeout',
          profileId,
          timeoutMs: this.queueTimeoutMs,
          at: new Date().toISOString(),
        });
      }
      throw error;
    }
    // The slot was transferred to us by release(): runningCount unchanged.
    this.held.add(profileId);
    this.touch(profileId);
    profileEvents.emit({
      type: 'profile.launch-admitted',
      profileId,
      waitedMs: Date.now() - enqueuedAt,
      at: new Date().toISOString(),
    });
  }

  /**
   * Release a slot. The head of the queue inherits it directly, so a
   * freed slot can never be stolen by a fresh acquire. Idempotent.
   */
  release(profileId: string): void {
    if (!this.held.delete(profileId)) {
      return;
    }
    this.lastActivity.delete(profileId);
    const next = this.queue.dequeue();
    if (!next) {
      this.runningCount = Math.max(0, this.runningCount - 1);
      return;
    }
    // Slot transfer: runningCount stays the same; the waiter takes it.
    next.resolve();
  }

  /** Record manager-level interaction (launch/stop/API action). */
  noteActivity(profileId: string): void {
    if (this.held.has(profileId)) {
      this.touch(profileId);
    }
  }

  get status(): ResourceStatus {
    return {
      maxConcurrent: this.maxConcurrent,
      running: this.runningCount,
      queued: this.queue.queuedIds(),
      idleShutdownMs: this.idleShutdownMs,
      minFreeDiskBytes: this.minFreeDiskBytes,
    };
  }

  /** Stop the idle timer and reject everyone still queued. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.queue.clear(new Error('ResourceManager is closed'));
  }

  private touch(profileId: string): void {
    this.lastActivity.set(profileId, Date.now());
  }

  private reapIdle(): void {
    if (this.idleShutdownMs <= 0 || !this.onIdleProfile) {
      return;
    }
    const now = Date.now();
    // Snapshot: the callback may release() and mutate the map.
    for (const [profileId, last] of [...this.lastActivity]) {
      const idleMs = now - last;
      if (idleMs >= this.idleShutdownMs && this.held.has(profileId)) {
        try {
          this.onIdleProfile(profileId, idleMs);
        } catch {
          // A failing callback must not kill the reaper loop.
        }
      }
    }
  }
}
