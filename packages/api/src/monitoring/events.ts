/**
 * Typed domain events for monitoring/alerting (Phase 4a).
 *
 * The MonitoringService evaluates thresholds on an interval and emits
 * raised/cleared events; the server bridges them to the dashboard
 * WebSocket hub like the other domain events.
 */

export interface MonitoringAlertPayload {
  /** Stable alert id, e.g. 'disk-critical'. */
  id: string;
  severity: 'warning' | 'critical';
  message: string;
  /** ISO-8601 timestamp of the evaluation that produced it. */
  at: string;
}

export interface MonitoringAlertEvent {
  type: 'monitoring.alert-raised' | 'monitoring.alert-cleared';
  alert: MonitoringAlertPayload;
  at: string;
}

export type MonitoringEventListener = (event: MonitoringAlertEvent) => void;

export class MonitoringEventEmitter {
  private readonly listeners = new Set<MonitoringEventListener>();

  emit(event: MonitoringAlertEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the emitter for others.
      }
    }
  }

  on(listener: MonitoringEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const monitoringEvents = new MonitoringEventEmitter();
