/**
 * FIFO launch queue with per-request timeouts.
 *
 * Pure queue mechanics live here; the ResourceManager owns slot accounting
 * and emits the domain events (queued/admitted/timeout) via profileEvents.
 */

export class LaunchQueueTimeoutError extends Error {
  constructor(
    public readonly profileId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Launch of profile ${profileId} timed out after ${String(timeoutMs)}ms waiting for a resource slot`);
    this.name = 'LaunchQueueTimeoutError';
  }
}

interface QueuedRequest {
  profileId: string;
  enqueuedAtMs: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LaunchQueue {
  private readonly waiting: QueuedRequest[] = [];

  constructor(private readonly timeoutMs: number) {}

  get length(): number {
    return this.waiting.length;
  }

  /** Profile ids in FIFO order (for status endpoints). */
  queuedIds(): string[] {
    return this.waiting.map((request) => request.profileId);
  }

  /** 1-based position, or 0 when not queued. */
  positionOf(profileId: string): number {
    const index = this.waiting.findIndex((request) => request.profileId === profileId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * Enqueue and wait until dequeued (slot transferred) or the timeout fires.
   * A profile may only appear once; re-enqueueing returns the original
   * waiter's promise so a double Launch click doesn't double-queue.
   */
  enqueue(profileId: string): Promise<void> {
    const existing = this.waiting.find((request) => request.profileId === profileId);
    if (existing) {
      return existing.promise;
    }
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: QueuedRequest = {
      profileId,
      enqueuedAtMs: Date.now(),
      promise,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.remove(profileId);
        reject(new LaunchQueueTimeoutError(profileId, this.timeoutMs));
      }, this.timeoutMs),
    };
    // Don't keep the process alive for a queued launch alone.
    entry.timer.unref();
    this.waiting.push(entry);
    return promise;
  }

  /** Remove and return the head request, cancelling its timeout. */
  dequeue(): QueuedRequest | undefined {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
    }
    return next;
  }

  /** Remove a specific request (timeout path, shutdown). */
  remove(profileId: string): boolean {
    const index = this.waiting.findIndex((request) => request.profileId === profileId);
    if (index === -1) {
      return false;
    }
    const [removed] = this.waiting.splice(index, 1);
    if (removed) {
      clearTimeout(removed.timer);
    }
    return true;
  }

  /** Reject everyone waiting (used on close). */
  clear(error: Error): void {
    for (const request of this.waiting.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}
