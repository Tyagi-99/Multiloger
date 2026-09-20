/**
 * Profiles page: live table of all profiles with launch/stop/restart,
 * a create-profile dialog, and a detail drawer (sessions, proxy, readiness,
 * backups). Refreshes on every domain event from the WebSocket.
 */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type {
  Client,
  IdentityInfo,
  ProfileDetail,
  PublicProxy,
  Session,
  WindowSyncResult,
} from '../types.js';
import { BackupList } from '../components/BackupList.js';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  StateBadge,
  formatTime,
  inputClass,
} from '../ui.js';

function ProfileDrawer({
  client,
  profile,
  clients,
  proxies,
  onClose,
  onChanged,
}: {
  client: ApiClient;
  profile: ProfileDetail;
  clients: Client[];
  proxies: PublicProxy[];
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [readiness, setReadiness] = useState<string>('—');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        client.getSessions(profile.id),
        client.launchReadiness(profile.id),
      ]);
      setSessions(s.sessions);
      setReadiness(r.ready ? 'ready' : `not ready: ${r.reason ?? 'unknown reason'}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client, profile.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const clientName = clients.find((c) => c.id === profile.clientId)?.name ?? profile.clientId;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-zinc-700 bg-zinc-900 p-6"
        onClick={(e) => {
          e.stopPropagation();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={`Profile ${profile.name}`}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold">{profile.name}</h2>
            <p className="font-mono text-xs text-zinc-500">{profile.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close details"
          >
            ✕
          </button>
        </div>

        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => {
              setError(null);
            }}
          />
        )}

        <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-zinc-500">State</dt>
          <dd>
            <StateBadge state={profile.state} />
          </dd>
          <dt className="text-zinc-500">Client</dt>
          <dd>{clientName}</dd>
          <dt className="text-zinc-500">Proxy</dt>
          <dd>
            {profile.proxy
              ? `${profile.proxy.name} (${profile.proxy.scheme}://${profile.proxy.host}:${String(profile.proxy.port)})`
              : 'none'}
          </dd>
          <dt className="text-zinc-500">Proxy required</dt>
          <dd>{profile.proxyRequired ? 'yes' : 'no'}</dd>
          <dt className="text-zinc-500">PID / CDP port</dt>
          <dd>
            {profile.lastPid !== null ? String(profile.lastPid) : '—'}
            {' / '}
            {profile.lastCdpPort !== null ? String(profile.lastCdpPort) : '—'}
          </dd>
          <dt className="text-zinc-500">Lock</dt>
          <dd>{profile.lock.active ? `held by ${profile.lock.owner ?? 'unknown'}` : 'free'}</dd>
          <dt className="text-zinc-500">Launch readiness</dt>
          <dd>{readiness}</dd>
        </dl>

        <div className="mb-6 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void mutate(() => client.launchProfile(profile.id))}
          >
            Launch
          </Button>
          <Button disabled={busy} onClick={() => void mutate(() => client.stopProfile(profile.id))}>
            Stop
          </Button>
          <Button
            disabled={busy}
            onClick={() => void mutate(() => client.restartProfile(profile.id))}
          >
            Restart
          </Button>
        </div>

        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Proxy assignment</h3>
          <div className="flex gap-2">
            <select
              className={inputClass}
              value={profile.proxy?.id ?? ''}
              disabled={busy}
              onChange={(e) => {
                const proxyId = e.target.value;
                if (proxyId) {
                  void mutate(() => client.assignProxy(profile.id, proxyId));
                }
              }}
            >
              <option value="">No proxy</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.scheme}://{p.host}:{String(p.port)})
                </option>
              ))}
            </select>
            {profile.proxy && (
              <Button
                disabled={busy}
                onClick={() => void mutate(() => client.unassignProxy(profile.id))}
              >
                Unassign
              </Button>
            )}
          </div>
        </div>

        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Recent sessions</h3>
          {sessions.length === 0 ? (
            <EmptyState message="No sessions recorded." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-1 pr-3">Started</th>
                  <th className="py-1 pr-3">Ended</th>
                  <th className="py-1 pr-3">Exit</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 10).map((s) => (
                  <tr key={s.id} className="border-t border-zinc-800">
                    <td className="py-1 pr-3">{formatTime(s.started_at)}</td>
                    <td className="py-1 pr-3">{formatTime(s.ended_at)}</td>
                    <td className="py-1 pr-3">{s.exit_reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <BackupList
          client={client}
          profileId={profile.id}
          profileName={profile.name}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}

export function ProfilesPage({
  client,
  eventCount,
  identity,
}: {
  client: ApiClient;
  eventCount: number;
  identity: IdentityInfo | null;
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileDetail[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [proxies, setProxies] = useState<PublicProxy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newClientId, setNewClientId] = useState('');
  // Phase 4c window sync: multi-select profiles, open one URL in each.
  const [selected, setSelected] = useState<string[]>([]);
  const [syncUrl, setSyncUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<WindowSyncResult | null>(null);

  const canSync =
    identity !== null &&
    (identity.legacy || identity.isAdmin || identity.permissions.includes('profiles:sync'));

  const refresh = useCallback(async () => {
    try {
      const [p, c, px] = await Promise.all([
        client.listProfiles(),
        client.listClients(),
        client.listProxies(),
      ]);
      setProfiles(p.profiles);
      setClients(c.clients);
      setProxies(px.proxies);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, eventCount]);

  async function mutate(id: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const clientNameOf = (clientId: string): string =>
    clients.find((c) => c.id === clientId)?.name ?? clientId.slice(0, 8);
  const detailProfile = profiles.find((p) => p.id === detailId) ?? null;

  function toggleSelected(id: string): void {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function syncSelected(): Promise<void> {
    const url = syncUrl.trim();
    if (url.length === 0) {
      setError('Enter a URL to open in the selected profiles.');
      return;
    }
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const result = await client.windowSync(selected, url);
      setSyncResult(result);
      setSelected([]);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Profiles</h1>
        <Button
          variant="primary"
          onClick={() => {
            setShowCreate(true);
          }}
        >
          New profile
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
      {canSync && profiles.length > 0 && (
        <div className="mb-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Field label="Window sync: open this URL in every selected profile">
                <input
                  className={inputClass}
                  value={syncUrl}
                  onChange={(e) => {
                    setSyncUrl(e.target.value);
                  }}
                  placeholder="https://example.com/"
                  disabled={syncing}
                  inputMode="url"
                />
              </Field>
            </div>
            <Button
              variant="primary"
              disabled={syncing || selected.length === 0}
              onClick={() => void syncSelected()}
            >
              {syncing ? 'Syncing…' : `Sync windows (${String(selected.length)})`}
            </Button>
            {selected.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSelected([]);
                }}
              >
                Clear
              </Button>
            )}
          </div>
          {syncResult && (
            <p className="mt-2 text-xs text-zinc-400">
              Synced {String(syncResult.synced.length)} profile(s)
              {syncResult.failed.length > 0 && (
                <>
                  {'; failed: '}
                  {syncResult.failed
                    .map((f) => `${f.profileId.slice(0, 8)} (${f.error})`)
                    .join(', ')}
                </>
              )}
            </p>
          )}
        </div>
      )}
      {profiles.length === 0 ? (
        <EmptyState message="No profiles yet. Create one to get started." />
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                {canSync && (
                  <th className="px-4 py-2">
                    <span className="sr-only">Select</span>
                  </th>
                )}
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2">Proxy</th>
                <th className="px-4 py-2">PID</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                  {canSync && (
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(p.id)}
                        onChange={() => {
                          toggleSelected(p.id);
                        }}
                        aria-label={`Select ${p.name}`}
                      />
                    </td>
                  )}
                  <td className="px-4 py-2 font-medium">{p.name}</td>
                  <td className="px-4 py-2 text-zinc-400">{clientNameOf(p.clientId)}</td>
                  <td className="px-4 py-2">
                    <StateBadge state={p.state} />
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{p.proxy?.name ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-zinc-400">
                    {p.lastPid !== null ? String(p.lastPid) : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void mutate(p.id, () => client.launchProfile(p.id))}
                      >
                        Launch
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void mutate(p.id, () => client.stopProfile(p.id))}
                      >
                        Stop
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDetailId(p.id);
                        }}
                      >
                        Details
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal
          title="New profile"
          onClose={() => {
            setShowCreate(false);
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              const clientId = newClientId;
              setShowCreate(false);
              setNewName('');
              void mutate('create', () => client.createProfile(clientId, name));
            }}
          >
            <Field label="Client">
              <select
                className={inputClass}
                value={newClientId}
                onChange={(e) => {
                  setNewClientId(e.target.value);
                }}
                required
              >
                <option value="">Select a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Profile name">
              <input
                className={inputClass}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                }}
                required
                minLength={1}
                maxLength={100}
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowCreate(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" submit>
                Create
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {detailProfile && (
        <ProfileDrawer
          client={client}
          profile={detailProfile}
          clients={clients}
          proxies={proxies}
          onClose={() => {
            setDetailId(null);
          }}
          onChanged={() => void refresh()}
        />
      )}
      <p className="mt-4 text-xs text-zinc-600">
        Table refreshes live on WebSocket events (launch, stop, crash, queue changes).
      </p>
    </div>
  );
}
