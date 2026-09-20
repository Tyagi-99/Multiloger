/**
 * Tests for monitoring metrics collection, threshold evaluation, alert
 * transitions, and the opt-in webhook (Phase 4a). Written first.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import type { DatabaseSchema } from '../db/schema.js';
import { monitoringEvents } from './events.js';
import {
  collectMetrics,
  evaluateAlerts,
  resolveThresholds,
  type MetricsDeps,
  type SystemMetrics,
} from './metrics.js';
import { MonitoringService } from './service.js';

let dir: string;
let db: Kysely<DatabaseSchema>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'multiloger-monitoring-test-'));
  db = openDatabase({ path: join(dir, 'test.db') });
  await migrateToLatest(db);
});

afterEach(async () => {
  await closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    db,
    dataDir: dir,
    startedAtMs: Date.now() - 60_000,
    queueInfo: () => ({ depth: 0, queuedIds: [] }),
    watermarkBytes: () => 1024 * 1024 * 1024,
    getDiskSpace: () =>
      Promise.resolve({ freeBytes: 50 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 }),
    ...overrides,
  };
}

function blankMetrics(): SystemMetrics {
  return {
    at: new Date().toISOString(),
    uptimeSec: 60,
    profiles: { total: 0, byState: {} },
    queue: { depth: 0, queuedIds: [] },
    disk: { freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, watermarkBytes: 1024 ** 3, belowWatermark: false },
    sessions: { started: 0, crashed: 0, errored: 0 },
    runs: { total: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0, failureRate: 0 },
    backups: { count: 0, totalBytes: 0 },
  };
}

describe('resolveThresholds', () => {
  it('rejects negative values and an inverted disk pair', () => {
    expect(() => resolveThresholds({ diskWarnBytes: -1 })).toThrow();
    expect(() =>
      resolveThresholds({ diskWarnBytes: 1024, diskCriticalBytes: 2048 }),
    ).toThrow();
    expect(() => resolveThresholds({ runFailureRateWarn: 1.5 })).toThrow();
  });
});

describe('evaluateAlerts', () => {
  const thresholds = resolveThresholds();

  it('is quiet when everything is healthy', () => {
    expect(evaluateAlerts(blankMetrics(), thresholds)).toEqual([]);
  });

  it('raises disk warning vs critical at the right boundaries', () => {
    const warn = { ...blankMetrics(), disk: { freeBytes: 1.5 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, watermarkBytes: 1024 ** 3, belowWatermark: false } };
    const warnAlerts = evaluateAlerts(warn, thresholds);
    expect(warnAlerts.map((a) => a.id)).toEqual(['disk-warning']);
    expect(warnAlerts[0]?.severity).toBe('warning');

    const crit = { ...blankMetrics(), disk: { freeBytes: 100, totalBytes: 100 * 1024 ** 3, watermarkBytes: 1024 ** 3, belowWatermark: true } };
    const critAlerts = evaluateAlerts(crit, thresholds);
    expect(critAlerts.map((a) => a.id)).toEqual(['disk-critical']);
    expect(critAlerts[0]?.severity).toBe('critical');
  });

  it('never fires a disk alert when the measurement failed (fail-open)', () => {
    const metrics = {
      ...blankMetrics(),
      disk: { freeBytes: null, totalBytes: null, watermarkBytes: 1024 ** 3, belowWatermark: false },
    };
    expect(evaluateAlerts(metrics, thresholds)).toEqual([]);
  });

  it('raises queue-backlog above the threshold only', () => {
    const at = { ...blankMetrics(), queue: { depth: 10, queuedIds: [] } };
    expect(evaluateAlerts(at, thresholds)).toEqual([]);
    const over = { ...blankMetrics(), queue: { depth: 11, queuedIds: [] } };
    expect(evaluateAlerts(over, thresholds).map((a) => a.id)).toEqual(['queue-backlog']);
  });

  it('raises launch-failures on crashed+errored sessions', () => {
    const metrics = { ...blankMetrics(), sessions: { started: 8, crashed: 3, errored: 2 } };
    expect(evaluateAlerts(metrics, thresholds).map((a) => a.id)).toEqual(['launch-failures']);
  });

  it('raises run-failures only with enough finished runs', () => {
    const few = {
      ...blankMetrics(),
      runs: { total: 2, completed: 0, failed: 2, timedOut: 0, cancelled: 0, failureRate: 1 },
    };
    expect(evaluateAlerts(few, thresholds)).toEqual([]);
    const enough = {
      ...blankMetrics(),
      runs: { total: 4, completed: 1, failed: 2, timedOut: 1, cancelled: 0, failureRate: 0.75 },
    };
    expect(evaluateAlerts(enough, thresholds).map((a) => a.id)).toEqual(['run-failures']);
  });
});

describe('collectMetrics', () => {
  it('counts profiles by state, sessions, runs, and backups', async () => {
    const now = new Date().toISOString();
    const clientId = randomUUID();
    await db
      .insertInto('clients')
      .values({ id: clientId, name: 'metrics-client', notes: null, archived_at: null, created_at: now, updated_at: now })
      .execute();
    const profileIds: string[] = [];
    for (const state of ['running', 'running', 'stopped', 'error']) {
      const id = randomUUID();
      profileIds.push(id);
      await db
        .insertInto('profiles')
        .values({
          id,
          client_id: clientId,
          name: `p-${state}-${id.slice(0, 8)}`,
          state,
          locked_by: null,
          locked_at: null,
          user_data_dir: join(dir, randomUUID()),
          last_pid: null,
          last_cdp_port: null,
          last_launched_at: null,
          proxy_required: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    for (const exitReason of ['crashed', 'error', 'stopped', null]) {
      await db
        .insertInto('sessions')
        .values({
          id: randomUUID(),
          profile_id: profileIds[0] ?? randomUUID(),
          started_at: now,
          ended_at: now,
          exit_reason: exitReason,
          pid: null,
          cdp_port: null,
        })
        .execute();
    }
    for (const status of ['completed', 'failed', 'timed_out']) {
      const scriptId = randomUUID();
      await db
        .insertInto('automation_scripts')
        .values({
          id: scriptId,
          name: `script-${status}`,
          version: 1,
          description: null,
          steps: '[]',
          created_by: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const jobId = randomUUID();
      await db
        .insertInto('automation_jobs')
        .values({
          id: jobId,
          name: `job-${status}`,
          script_id: scriptId,
          script_version: 1,
          profile_id: profileIds[0] ?? randomUUID(),
          created_by: null,
          status: 'completed',
          timeout_ms: 1000,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('automation_runs')
        .values({
          id: randomUUID(),
          job_id: jobId,
          profile_id: profileIds[0] ?? randomUUID(),
          status,
          timeout_ms: 1000,
          started_at: now,
          finished_at: now,
          logs: '[]',
          result_json: null,
          error: null,
          artifact_count: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    await db
      .insertInto('backups')
      .values({
        id: randomUUID(),
        profile_id: randomUUID(),
        file_name: 'b.mlbackup',
        size_bytes: 1234,
        sha256: 'abc',
        encryption: 'aes-256-gcm',
        created_at: now,
      })
      .execute();

    const metrics = await collectMetrics(baseDeps());
    expect(metrics.profiles.total).toBe(4);
    expect(metrics.profiles.byState).toMatchObject({ running: 2, stopped: 1, error: 1 });
    expect(metrics.sessions).toMatchObject({ started: 4, crashed: 1, errored: 1 });
    expect(metrics.runs).toMatchObject({ failed: 1, timedOut: 1, completed: 1 });
    expect(metrics.runs.failureRate).toBeCloseTo(2 / 3);
    expect(metrics.backups).toMatchObject({ count: 1, totalBytes: 1234 });
    expect(metrics.uptimeSec).toBeGreaterThanOrEqual(59);
  });

  it('nulls the disk fields when the check fails instead of throwing', async () => {
    const metrics = await collectMetrics(
      baseDeps({
        getDiskSpace: () => Promise.reject(new Error('no df here')),
      }),
    );
    expect(metrics.disk.freeBytes).toBeNull();
    expect(metrics.disk.belowWatermark).toBe(false);
  });
});

describe('MonitoringService', () => {
  it('emits raised/cleared transitions only, and caches metrics', async () => {
    let freeBytes = 50 * 1024 ** 3;
    const service = new MonitoringService({
      ...baseDeps(),
      getDiskSpace: () => Promise.resolve({ freeBytes, totalBytes: 100 * 1024 ** 3 }),
      intervalMs: 0,
    });
    const seen: string[] = [];
    const off = monitoringEvents.on((event) => {
      seen.push(`${event.type}:${event.alert.id}`);
    });
    try {
      await service.evaluate();
      expect(seen).toEqual([]);

      freeBytes = 100; // critical
      await service.evaluate();
      expect(seen).toEqual(['monitoring.alert-raised:disk-critical']);

      await service.evaluate(); // still critical: no repeat event
      expect(seen).toEqual(['monitoring.alert-raised:disk-critical']);

      const summary = await service.getSummary();
      expect(summary.alerts.map((a) => a.id)).toEqual(['disk-critical']);

      freeBytes = 50 * 1024 ** 3; // healthy again
      await service.evaluate();
      expect(seen).toEqual([
        'monitoring.alert-raised:disk-critical',
        'monitoring.alert-cleared:disk-critical',
      ]);
      expect((await service.getSummary()).alerts).toEqual([]);
    } finally {
      off();
      service.close();
    }
  });

  it('POSTs transitions to the webhook only when configured', async () => {
    const received: unknown[] = [];
    const stub: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        received.push(JSON.parse(body) as unknown);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = stub.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      let freeBytes = 50 * 1024 ** 3;
      const service = new MonitoringService({
        ...baseDeps(),
        getDiskSpace: () => Promise.resolve({ freeBytes, totalBytes: 100 * 1024 ** 3 }),
        intervalMs: 0,
        webhookUrl: `http://127.0.0.1:${String(port)}/hook`,
      });
      // No webhook configured → no calls (separate service without URL).
      const quiet = new MonitoringService({
        ...baseDeps(),
        getDiskSpace: () => Promise.resolve({ freeBytes: 100, totalBytes: 100 * 1024 ** 3 }),
        intervalMs: 0,
      });
      await quiet.evaluate();
      quiet.close();
      expect(received).toEqual([]);

      freeBytes = 100;
      await service.evaluate();
      // postWebhook is fire-and-forget; give it a beat to land.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.length).toBe(1);
      const payload = received[0] as { source: string; event: string; alert: { id: string } };
      expect(payload.source).toBe('multiloger');
      expect(payload.event).toBe('alert-raised');
      expect(payload.alert.id).toBe('disk-critical');
      service.close();
    } finally {
      await new Promise<void>((resolve) => {
        stub.close(() => {
          resolve();
        });
      });
    }
  });
});
