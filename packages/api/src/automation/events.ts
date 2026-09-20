/**
 * Automation domain events (Phase 2a).
 *
 * The runner emits through this process-wide singleton; the API server
 * subscribes and forwards to the WebSocket hub so dashboard clients see
 * run status changes live. Same hand-rolled typed-emitter pattern as
 * profiles/events.ts.
 */

import type { AutomationRunStatus } from './repository.js';

export interface AutomationRunStatusEvent {
  type: 'automation.run-status';
  runId: string;
  jobId: string;
  profileId: string;
  /** The run's new status. */
  status: AutomationRunStatus;
  /** ISO-8601 timestamp of the transition. */
  at: string;
}

export type AutomationDomainEvent = AutomationRunStatusEvent;

export type AutomationEventListener = (event: AutomationDomainEvent) => void;

class AutomationEventEmitter {
  private readonly listeners = new Set<AutomationEventListener>();

  on(listener: AutomationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AutomationDomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the runner.
      }
    }
  }
}

/** Process-wide singleton. */
export const automationEvents = new AutomationEventEmitter();
