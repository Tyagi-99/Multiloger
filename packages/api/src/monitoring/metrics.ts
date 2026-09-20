/**
 * Monitoring metrics collection + alert threshold evaluation (Phase 4a).
 *
 * Metrics are cheap by construction: a handful of indexed COUNT queries,
 * the in-memory launch queue depth, and one `df` call for disk space (which
 * is why callers cache the result briefly — see monitoring/service.ts).
 * Disk measurement is FAIL-OPEN: when `df` is unavailable the disk fields
 * come back null and no disk alert fires, exactly like the launch
 * watermark — a broken parser must never page anyone.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { getDiskSpace, nearestExistingAncestor, type DiskSpace } from '../resources/disk.js';
import type { MonitoringAlertPayload } from './events.js';

export interface MonitoringThresholds {
  /** Warn when free disk bytes drop below this. Default 2 GiB. */
  diskWarnBytes: number;
  /** Critical when free disk bytes drop below this. Default 1 GiB. */
  diskCriticalBytes: number;
  /** Warn when more than this many launches are queued. Default 10. */
  queueBacklogWarn: number;
  /** Warn when this many sessions ended crashed/errored inside the window. */
  launchFailureWarn: number;
  /** Warn when the run failure rate inside the window reaches this (0-1). */
  runFailureRateWarn: number;
  /** Minimum finished runs inside the window before the rate alert fires. */
  runFailureMinRuns: number;
  /** Lookback window for failure counts. Default 24h. */
  failureWindowMs: number;
}

export const DEFAULT_THRESHOLDS: MonitoringThresholds = {
  diskWarnBytes: 2 * 1024 * 1024 * 1024,
  diskCriticalBytes: 1024 * 1024 * 1024,
  queueBacklogWarn: 10,
  launchFailureWarn: 5,
  runFailureRateWarn: 0.5,
  runFailureMinRuns: 3,
  failureWindowMs: 24 * 60 * 60 * 1000,
};

export function resolveThresholds(
  overrides: Partial<MonitoringThresholds> = {},
): MonitoringThresholds {
  const merged = { ...DEFAULT_THRESHOLDS, ...overrides };
  for (const [key, value] of Object.entries(merged) as [keyof MonitoringThresholds, number][]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Monitoring threshold must be a non-negative number: ${key}`);
    }
  }
  if (merged.runFailureRateWarn > 1) {
    throw new Error('Monitoring threshold runFailureRateWarn must be within 0-1');
  }
  if (merged.diskCriticalBytes > merged.diskWarnBytes) {
    throw new Error('diskCriticalBytes must not exceed diskWarnBytes');
  }
  return merged;
}

export interface QueueInfo {
  depth: number;
  queuedIds: string[];
}

export interface SystemMetrics {
  at: string;
  uptimeSec: number;
  profiles: { total: number; byState: Record<string, number> };
  queue: QueueInfo;
  disk: {
    freeBytes: number | null;
    totalBytes: number | null;
    watermarkBytes: number;
    /** True when measured free space is below the launch watermark. */
    belowWatermark: boolean;
  };
  sessions: { started: number; crashed: number; errored: number };
  runs: {
    total: number;
    completed: number;
    failed: number;
    timedOut: number;
    cancelled: number;
    /** failed+timedOut over total finished; 0 when nothing finished. */
    failureRate: number;
  };
  backups: { count: number; totalBytes: number };
}

export interface MetricsDeps {
  db: Kysely<DatabaseSchema>;
  dataDir: string;
  /** Epoch ms the server started (for uptime). */
  startedAtMs: number;
  queueInfo: () => QueueInfo;
  watermarkBytes: () => number;
  /**
   * Disk measurement, injectable for tests. Defaults to measuring the
   * dataDir's filesystem; resolves null when the check fails (fail-open).
   */
  getDiskSpace?: () => Promise<DiskSpace | null>;
  now?: () => number;
}

async function countWhere(
  db: Kysely<DatabaseSchema>,
  table: 'sessions' | 'automation_runs',
  column: 'exit_reason' | 'status',
  values: readonly string[],
  sinceIso: string,
  startedColumn: 'started_at' | 'created_at',
): Promise<number> {
  const query = db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('n'))
    .where(column, 'in', values as string[])
    .where(startedColumn, '>=', sinceIso);
  const row = await query.executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Collect one metrics snapshot. Never throws on disk failure (nulls out). */
export async function collectMetrics(deps: MetricsDeps): Promise<SystemMetrics> {
  const nowMs = deps.now?.() ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - DEFAULT_THRESHOLDS.failureWindowMs).toISOString();
  const { db } = deps;

  const profileRows = await db
    .selectFrom('profiles')
    .select(['state', (eb) => eb.fn.countAll().as('n')])
    .groupBy('state')
    .execute();
  const byState: Record<string, number> = {};
  let profileTotal = 0;
  for (const row of profileRows) {
    const n = Number(row.n);
    byState[row.state] = n;
    profileTotal += n;
  }

  const sessionsStarted = await db
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('started_at', '>=', sinceIso)
    .executeTakeFirst()
    .then((row) => Number(row?.n ?? 0));
  const sessionsCrashed = await countWhere(db, 'sessions', 'exit_reason', ['crashed'], sinceIso, 'started_at');
  const sessionsErrored = await countWhere(db, 'sessions', 'exit_reason', ['error'], sinceIso, 'started_at');

  const runRows = await db
    .selectFrom('automation_runs')
    .select(['status', (eb) => eb.fn.countAll().as('n')])
    .where('created_at', '>=', sinceIso)
    .groupBy('status')
    .execute();
  const runsByStatus: Record<string, number> = {};
  for (const row of runRows) {
    runsByStatus[row.status] = Number(row.n);
  }
  const completed = runsByStatus.completed ?? 0;
  const failed = runsByStatus.failed ?? 0;
  const timedOut = runsByStatus.timed_out ?? 0;
  const cancelled = runsByStatus.cancelled ?? 0;
  const finishedTotal = completed + failed + timedOut + cancelled;
  const failureRate = finishedTotal === 0 ? 0 : (failed + timedOut) / finishedTotal;

  const backupRow = await db
    .selectFrom('backups')
    .select([(eb) => eb.fn.countAll().as('n'), (eb) => eb.fn.sum('size_bytes').as('bytes')])
    .executeTakeFirst();

  let disk: DiskSpace | null = null;
  if (deps.getDiskSpace) {
    disk = await deps.getDiskSpace().catch(() => null);
  } else {
    try {
      disk = await getDiskSpace(nearestExistingAncestor(deps.dataDir));
    } catch {
      disk = null;
    }
  }
  const watermarkBytes = deps.watermarkBytes();

  return {
    at,
    uptimeSec: Math.max(0, Math.floor((nowMs - deps.startedAtMs) / 1000)),
    profiles: { total: profileTotal, byState },
    queue: deps.queueInfo(),
    disk: {
      freeBytes: disk?.freeBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      watermarkBytes,
      belowWatermark: disk !== null && watermarkBytes > 0 && disk.freeBytes < watermarkBytes,
    },
    sessions: { started: sessionsStarted, crashed: sessionsCrashed, errored: sessionsErrored },
    runs: {
      total: finishedTotal + (runsByStatus.queued ?? 0) + (runsByStatus.running ?? 0),
      completed,
      failed,
      timedOut,
      cancelled,
      failureRate,
    },
    backups: {
      count: Number(backupRow?.n ?? 0),
      totalBytes: Number(backupRow?.bytes ?? 0),
    },
  };
}

/**
 * Evaluate thresholds against a metrics snapshot. Pure: no I/O, easy to
 * test. Alert ids are stable across evaluations so the service can detect
 * raised/cleared transitions.
 */
export function evaluateAlerts(
  metrics: SystemMetrics,
  thresholds: MonitoringThresholds,
  nowIso?: string,
): MonitoringAlertPayload[] {
  const at = nowIso ?? new Date().toISOString();
  const alerts: MonitoringAlertPayload[] = [];

  const free = metrics.disk.freeBytes;
  if (free !== null) {
    if (free < thresholds.diskCriticalBytes) {
      alerts.push({
        id: 'disk-critical',
        severity: 'critical',
        message:
          `Disk space critically low: ${formatBytes(free)} free ` +
          `(critical below ${formatBytes(thresholds.diskCriticalBytes)})`,
        at,
      });
    } else if (free < thresholds.diskWarnBytes) {
      alerts.push({
        id: 'disk-warning',
        severity: 'warning',
        message:
          `Disk space low: ${formatBytes(free)} free ` +
          `(warning below ${formatBytes(thresholds.diskWarnBytes)})`,
        at,
      });
    }
  }

  if (metrics.queue.depth > thresholds.queueBacklogWarn) {
    alerts.push({
      id: 'queue-backlog',
      severity: 'warning',
      message:
        `Launch queue backlog: ${String(metrics.queue.depth)} launches waiting ` +
        `(warning above ${String(thresholds.queueBacklogWarn)})`,
      at,
    });
  }

  const launchFailures = metrics.sessions.crashed + metrics.sessions.errored;
  if (launchFailures >= thresholds.launchFailureWarn) {
    alerts.push({
      id: 'launch-failures',
      severity: 'warning',
      message:
        `${String(launchFailures)} sessions crashed or errored in the last 24h ` +
        `(warning at ${String(thresholds.launchFailureWarn)})`,
      at,
    });
  }

  const finishedRuns =
    metrics.runs.completed + metrics.runs.failed + metrics.runs.timedOut + metrics.runs.cancelled;
  if (
    finishedRuns >= thresholds.runFailureMinRuns &&
    metrics.runs.failureRate >= thresholds.runFailureRateWarn
  ) {
    alerts.push({
      id: 'run-failures',
      severity: 'warning',
      message:
        `Automation failure rate ${String(Math.round(metrics.runs.failureRate * 100))}% ` +
        `over ${String(finishedRuns)} runs in the last 24h ` +
        `(warning at ${String(Math.round(thresholds.runFailureRateWarn * 100))}%)`,
      at,
    });
  }

  return alerts;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KiB';
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === 'TiB') {
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}
