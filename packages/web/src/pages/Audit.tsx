/**
 * Audit log page: filterable, paginated view of the append-only audit log
 * (Phase 3). Non-admin callers only ever see their own actions — enforced
 * server-side; this page just renders what the API returns.
 */

import { useCallback, useEffect, useState } from 'react';
import { messageOf, type ApiClient } from '../api.js';
import type { AuditEntry } from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, formatTime, inputClass } from '../ui.js';

const PAGE_SIZE = 50;

export function AuditPage({ client }: { client: ApiClient }): React.JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const fetchPage = useCallback(
    async (nextOffset: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await client.queryAuditLog({
          ...(action.trim() ? { action: action.trim() } : {}),
          ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
          ...(entityType.trim() ? { entityType: entityType.trim() } : {}),
          ...(entityId.trim() ? { entityId: entityId.trim() } : {}),
          ...(since ? { since: new Date(since).toISOString() } : {}),
          ...(until ? { until: new Date(until).toISOString() } : {}),
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setEntries(res.entries);
        setTotal(res.total);
        setOffset(res.offset);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [client, action, actorId, entityType, entityId, since, until],
  );

  useEffect(() => {
    void fetchPage(0);
  }, []);

  function actorLabel(e: AuditEntry): string {
    if (e.actorType === 'anonymous') {
      return 'anonymous';
    }
    if (e.actorType === 'token') {
      return `token ${e.actorId?.slice(0, 8) ?? '?'}`;
    }
    return `user ${e.actorId?.slice(0, 8) ?? '?'}`;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void fetchPage(0);
          }}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}

      <form
        className="mb-4 flex flex-wrap items-end gap-3 rounded border border-zinc-800 bg-zinc-900 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void fetchPage(0);
        }}
      >
        <Field label="Action contains">
          <input
            className={inputClass}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
            }}
            placeholder="profile.launch"
          />
        </Field>
        <Field label="Actor id">
          <input
            className={inputClass}
            value={actorId}
            onChange={(e) => {
              setActorId(e.target.value);
            }}
            placeholder="user or token id"
          />
        </Field>
        <Field label="Entity type">
          <input
            className={inputClass}
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
            }}
            placeholder="profile"
          />
        </Field>
        <Field label="Entity id">
          <input
            className={inputClass}
            value={entityId}
            onChange={(e) => {
              setEntityId(e.target.value);
            }}
          />
        </Field>
        <Field label="Since">
          <input
            className={inputClass}
            type="datetime-local"
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
            }}
          />
        </Field>
        <Field label="Until">
          <input
            className={inputClass}
            type="datetime-local"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
            }}
          />
        </Field>
        <Button variant="primary" submit disabled={busy}>
          Filter
        </Button>
      </form>

      {entries.length === 0 ? (
        <EmptyState message={busy ? 'Loading…' : 'No audit entries match.'} />
      ) : (
        <>
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Actor</th>
                  <th className="px-4 py-2">Entity</th>
                  <th className="px-4 py-2">IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-zinc-800">
                    <td className="whitespace-nowrap px-4 py-2 text-zinc-400">
                      {formatTime(e.at)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                    <td className="px-4 py-2 text-zinc-400">{actorLabel(e)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-400">
                      {e.entityType ?? '—'}
                      {e.entityId ? ` ${e.entityId.slice(0, 8)}` : ''}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-zinc-400">
            <span>
              Showing {offset + 1}–{offset + entries.length} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={busy || offset === 0}
                onClick={() => {
                  void fetchPage(Math.max(0, offset - PAGE_SIZE));
                }}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                disabled={busy || offset + entries.length >= total}
                onClick={() => {
                  void fetchPage(offset + PAGE_SIZE);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
