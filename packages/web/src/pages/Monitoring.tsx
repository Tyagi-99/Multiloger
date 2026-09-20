/**
 * Monitoring page (Phase 4a): operational metrics plus the active alert
 * list. Refreshes on every dashboard event and every 30s.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../api.js';
import { messageOf } from '../api.js';
import type { MonitoringAlert, MonitoringSummary } from '../types.js';
import { EmptyState, ErrorBanner, formatBytes } from '../ui.js';

function AlertRow({ alert }: { alert: MonitoringAlert }): React.JSX.Element {
  const color =
    alert.severity === 'critical'
      ? 'border-red-800 bg-red-950/40 text-red-200'
      : 'border-amber-800 bg-amber-950/40 text-amber-200';
  return (
    <div className={`rounded border p-3 text-sm ${color}`}>
      <div className="font-medium uppercase tracking-wide text-xs opacity-80">
        {alert.severity} · {alert.id}
      </div>
      <div className="mt-1">{alert.message}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

export function MonitoringPage({
  client,
  eventCount,
}: {
  client: ApiClient;
  eventCount: number;
}): React.JSX.Element {
  const [summary, setSummary] = useState<MonitoringSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await client.monitoringSummary());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, eventCount]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  const m = summary?.metrics;
  const alerts = summary?.alerts ?? [];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Monitoring</h2>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}

      <section>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-400">
          Active alerts {alerts.length > 0 && `(${String(alerts.length)})`}
        </h3>
        {alerts.length === 0 ? (
          <EmptyState message="No active alerts. Thresholds are evaluated every 30s." />
        ) : (
          <div className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </div>
        )}
      </section>

      {m && (
        <section className="space-y-4">
          <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Metrics</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Uptime" value={`${String(Math.floor(m.uptimeSec / 3600))}h ${String(Math.floor((m.uptimeSec % 3600) / 60))}m`} />
            <Stat label="Profiles" value={String(m.profiles.total)} />
            <Stat label="Running" value={String(m.profiles.byState.running ?? 0)} />
            <Stat label="Queue depth" value={String(m.queue.depth)} />
            <Stat
              label="Disk free"
              value={m.disk.freeBytes === null ? 'unknown' : formatBytes(m.disk.freeBytes)}
            />
            <Stat
              label="Disk total"
              value={m.disk.totalBytes === null ? 'unknown' : formatBytes(m.disk.totalBytes)}
            />
            <Stat label="Sessions (24h)" value={String(m.sessions.started)} />
            <Stat
              label="Crashed/errored (24h)"
              value={String(m.sessions.crashed + m.sessions.errored)}
            />
            <Stat label="Runs (24h)" value={String(m.runs.total)} />
            <Stat label="Run failure rate" value={`${String(Math.round(m.runs.failureRate * 100))}%`} />
            <Stat label="Backups" value={String(m.backups.count)} />
            <Stat label="Backup bytes" value={formatBytes(m.backups.totalBytes)} />
          </div>
          <p className="text-xs text-zinc-600">
            Snapshot at {m.at} · profile states: {Object.entries(m.profiles.byState).map(([s, n]) => `${s}=${String(n)}`).join(', ') || 'none'}
          </p>
        </section>
      )}
    </div>
  );
}
