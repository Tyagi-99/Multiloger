/**
 * MonitoringService (Phase 4a).
 *
 * - Evaluates alert thresholds on a background interval (default 30s) and
 *   emits `monitoring.alert-raised` / `monitoring.alert-cleared` events on
 *   transitions only (no flapping spam).
 * - `getSummary()` serves the cached metrics snapshot (10s TTL) plus the
 *   currently active alerts — cheap for the dashboard poll loop.
 * - Optional generic webhook: when `webhookUrl` is configured (opt-in),
 *   raised/cleared transitions are POSTed as JSON. Delivery is
 *   fire-and-forget with a bounded timeout; a dead webhook never breaks
 *   monitoring or the request path.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import type { DiskSpace } from '../resources/disk.js';
import { monitoringEvents, type MonitoringAlertPayload } from './events.js';
import {
  collectMetrics,
  evaluateAlerts,
  resolveThresholds,
  type MetricsDeps,
  type MonitoringThresholds,
  type QueueInfo,
  type SystemMetrics,
} from './metrics.js';

export interface MonitoringServiceOptions {
  db: Kysely<DatabaseSchema>;
  dataDir: string;
  startedAtMs: number;
  queueInfo: () => QueueInfo;
  watermarkBytes: () => number;
  getDiskSpace?: () => Promise<DiskSpace | null>;
  thresholds?: Partial<MonitoringThresholds>;
  /** Evaluation interval ms. Default 30_000. 0 disables the background loop (tests). */
  intervalMs?: number;
  /** Metrics cache TTL ms. Default 10_000. */
  metricsCacheMs?: number;
  /** Opt-in generic webhook URL for alert transitions. Unset = no webhook. */
  webhookUrl?: string;
  /** Webhook POST timeout ms. Default 5_000. */
  webhookTimeoutMs?: number;
  now?: () => number;
}

export interface MonitoringSummary {
  metrics: SystemMetrics;
  alerts: MonitoringAlertPayload[];
}

export class MonitoringService {
  private readonly deps: MetricsDeps;
  private readonly thresholds: MonitoringThresholds;
  private readonly intervalMs: number;
  private readonly metricsCacheMs: number;
  private readonly webhookUrl: string | undefined;
  private readonly webhookTimeoutMs: number;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | undefined;
  private cached: { atMs: number; metrics: SystemMetrics } | undefined;
  private activeAlerts = new Map<string, MonitoringAlertPayload>();
  private closed = false;

  constructor(options: MonitoringServiceOptions) {
    this.thresholds = resolveThresholds(options.thresholds);
    this.intervalMs = options.intervalMs ?? 30_000;
    this.metricsCacheMs = options.metricsCacheMs ?? 10_000;
    this.webhookUrl = options.webhookUrl;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.deps = {
      db: options.db,
      dataDir: options.dataDir,
      startedAtMs: options.startedAtMs,
      queueInfo: options.queueInfo,
      watermarkBytes: options.watermarkBytes,
      ...(options.getDiskSpace !== undefined ? { getDiskSpace: options.getDiskSpace } : {}),
      now: this.now,
    };
  }

  /** Start the background evaluation loop. Safe to call once. */
  start(): void {
    if (this.timer !== undefined || this.intervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.evaluate().catch((error: unknown) => {
        // Monitoring must never take the server down.
        console.error(
          '[multiloger] monitoring evaluation failed:',
          error instanceof Error ? error.message : error,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Cheap: serves the cached snapshot (10s TTL) + current active alerts. */
  async getSummary(): Promise<MonitoringSummary> {
    const metrics = await this.getMetrics();
    return { metrics, alerts: [...this.activeAlerts.values()] };
  }

  private async getMetrics(): Promise<SystemMetrics> {
    const nowMs = this.now();
    if (this.cached && nowMs - this.cached.atMs < this.metricsCacheMs) {
      return this.cached.metrics;
    }
    const metrics = await collectMetrics(this.deps);
    this.cached = { atMs: nowMs, metrics };
    return metrics;
  }

  /**
   * Evaluate thresholds now, emit raised/cleared transitions, and refresh
   * the active set. Public so tests and the first request can drive it
   * without waiting for the interval.
   */
  async evaluate(): Promise<MonitoringAlertPayload[]> {
    if (this.closed) {
      return [...this.activeAlerts.values()];
    }
    const metrics = await collectMetrics(this.deps);
    this.cached = { atMs: this.now(), metrics };
    const found = evaluateAlerts(metrics, this.thresholds, metrics.at);
    const next = new Map(found.map((alert) => [alert.id, alert]));

    for (const [id, alert] of next) {
      if (!this.activeAlerts.has(id)) {
        monitoringEvents.emit({ type: 'monitoring.alert-raised', alert, at: metrics.at });
        void this.postWebhook('alert-raised', alert, metrics.at);
      }
    }
    for (const [id, alert] of this.activeAlerts) {
      if (!next.has(id)) {
        monitoringEvents.emit({ type: 'monitoring.alert-cleared', alert, at: metrics.at });
        void this.postWebhook('alert-cleared', alert, metrics.at);
      }
    }
    this.activeAlerts = next;
    return found;
  }

  private async postWebhook(
    event: 'alert-raised' | 'alert-cleared',
    alert: MonitoringAlertPayload,
    at: string,
  ): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'multiloger', event, alert, at }),
        signal: AbortSignal.timeout(this.webhookTimeoutMs),
      });
      if (!response.ok) {
        console.error(
          `[multiloger] monitoring webhook answered HTTP ${String(response.status)}`,
        );
      }
    } catch (error) {
      console.error(
        '[multiloger] monitoring webhook delivery failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
