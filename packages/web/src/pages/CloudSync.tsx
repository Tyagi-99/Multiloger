/**
 * Cloud sync page (Phase 4b): configure the S3-compatible target, run a
 * sync, list remote objects, restore one into a new profile, and prune
 * objects past retention. Mutation controls are hidden without
 * `backups:sync`; listing needs only `backups:read`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../api.js';
import { ApiError, messageOf } from '../api.js';
import type {
  Client,
  CloudSyncConfig,
  CloudSyncConfigInput,
  CloudSyncResult,
  IdentityInfo,
  RemoteBackupObject,
} from '../types.js';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  formatBytes,
  formatTime,
  inputClass,
} from '../ui.js';

function canMutate(identity: IdentityInfo | null): boolean {
  if (!identity) {
    return false;
  }
  return identity.legacy || identity.isAdmin || identity.permissions.includes('backups:sync');
}

function ConfigForm({
  client,
  initial,
  onSaved,
}: {
  client: ApiClient;
  initial: CloudSyncConfig | null;
  onSaved: (config: CloudSyncConfig) => void;
}): React.JSX.Element {
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [bucket, setBucket] = useState(initial?.bucket ?? '');
  const [region, setRegion] = useState(initial?.region ?? 'us-east-1');
  const [prefix, setPrefix] = useState(initial?.prefix ?? 'multiloger/');
  const [retentionDays, setRetentionDays] = useState(String(initial?.retentionDays ?? 30));
  const [accessKeySecretName, setAccessKeySecretName] = useState(
    initial?.accessKeySecretName ?? '',
  );
  const [secretKeySecretName, setSecretKeySecretName] = useState(
    initial?.secretKeySecretName ?? '',
  );
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(initial?.allowInsecureHttp ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: CloudSyncConfigInput = {
        endpoint,
        bucket,
        region,
        prefix,
        retentionDays: Number(retentionDays),
        accessKeySecretName,
        secretKeySecretName,
        allowInsecureHttp,
      };
      const { config } = await client.saveCloudSyncConfig(input);
      onSaved(config);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        void save(e);
      }}
      className="space-y-4"
    >
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Endpoint URL">
          <input
            className={inputClass}
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
            }}
            placeholder="https://s3.eu-central-1.amazonaws.com"
            required
          />
        </Field>
        <Field label="Bucket">
          <input
            className={inputClass}
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value);
            }}
            placeholder="multiloger-backups"
            required
          />
        </Field>
        <Field label="Region">
          <input
            className={inputClass}
            value={region}
            onChange={(e) => {
              setRegion(e.target.value);
            }}
          />
        </Field>
        <Field label="Key prefix">
          <input
            className={inputClass}
            value={prefix}
            onChange={(e) => {
              setPrefix(e.target.value);
            }}
            placeholder="multiloger/"
          />
        </Field>
        <Field label="Retention (days)">
          <input
            className={inputClass}
            type="number"
            min={1}
            value={retentionDays}
            onChange={(e) => {
              setRetentionDays(e.target.value);
            }}
            required
          />
        </Field>
        <Field label="Vault secret: access key id">
          <input
            className={inputClass}
            value={accessKeySecretName}
            onChange={(e) => {
              setAccessKeySecretName(e.target.value);
            }}
            placeholder="s3-access-key-id"
            required
          />
        </Field>
        <Field label="Vault secret: secret access key">
          <input
            className={inputClass}
            value={secretKeySecretName}
            onChange={(e) => {
              setSecretKeySecretName(e.target.value);
            }}
            placeholder="s3-secret-access-key"
            required
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={allowInsecureHttp}
          onChange={(e) => {
            setAllowInsecureHttp(e.target.checked);
          }}
        />
        Allow insecure http:// endpoint (local MinIO/testing only)
      </label>
      <p className="text-xs text-zinc-500">
        Credential values live only in the encrypted vault — the config stores secret names, never
        values. Use your vault CLI to store them first.
      </p>
      <Button submit disabled={busy}>
        {busy ? 'Saving…' : initial ? 'Update configuration' : 'Save configuration'}
      </Button>
    </form>
  );
}

function RestoreRow({
  client,
  object,
  clients,
  onRestored,
}: {
  client: ApiClient;
  object: RemoteBackupObject;
  clients: Client[];
  onRestored: (profileId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { profileId } = await client.restoreCloudObject(
        object.key,
        name,
        clientId === '' ? undefined : clientId,
      );
      setOpen(false);
      setName('');
      onRestored(profileId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        Restore…
      </Button>
      {open && (
        <form
          onSubmit={(e) => {
            void restore(e);
          }}
          className="mt-2 space-y-3 rounded border border-zinc-800 bg-zinc-900 p-3"
        >
          {error && (
            <ErrorBanner
              message={error}
              onDismiss={() => {
                setError(null);
              }}
            />
          )}
          <Field label="New profile name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              maxLength={200}
              required
            />
          </Field>
          <Field label="Client (auto when the source profile still exists)">
            <select
              className={inputClass}
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
              }}
            >
              <option value="">Auto</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Button submit disabled={busy || name.trim() === ''}>
            {busy ? 'Restoring…' : 'Restore into new profile'}
          </Button>
        </form>
      )}
    </div>
  );
}

export function CloudSyncPage({
  client,
  identity,
}: {
  client: ApiClient;
  identity: IdentityInfo | null;
}): React.JSX.Element {
  const mutate = canMutate(identity);
  const [config, setConfig] = useState<CloudSyncConfig | null>(null);
  const [configState, setConfigState] = useState<'loading' | 'missing' | 'ready'>('loading');
  const [objects, setObjects] = useState<RemoteBackupObject[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [syncResult, setSyncResult] = useState<CloudSyncResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ config: loaded }, { objects: listed }] = await Promise.all([
        client.cloudSyncConfig().catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'CLOUD_SYNC_NOT_CONFIGURED') {
            return { config: null as CloudSyncConfig | null };
          }
          throw err;
        }),
        client.listCloudObjects().catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'CLOUD_SYNC_NOT_CONFIGURED') {
            return { objects: [] as RemoteBackupObject[] };
          }
          throw err;
        }),
      ]);
      setConfig(loaded);
      setConfigState(loaded ? 'ready' : 'missing');
      setObjects(listed);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    client
      .listClients()
      .then(({ clients: loaded }) => {
        setClients(loaded);
      })
      .catch(() => {
        setClients([]);
      });
  }, [client, refresh]);

  async function syncNow(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.syncCloudNow();
      setSyncResult(result);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function prune(): Promise<void> {
    if (!window.confirm('Delete remote objects older than the retention window?')) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { deleted } = await client.pruneCloudObjects();
      setNotice(
        deleted.length === 0
          ? 'Nothing past retention.'
          : `Deleted ${String(deleted.length)} object(s).`,
      );
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <h2 className="text-xl font-semibold">Cloud sync</h2>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}
      {notice && (
        <div className="rounded border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          {notice}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => {
              setNotice(null);
            }}
          >
            dismiss
          </button>
        </div>
      )}

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Configuration
        </h3>
        {configState === 'loading' && <p className="text-sm text-zinc-500">Loading…</p>}
        {configState === 'missing' && !mutate && (
          <EmptyState message="Cloud sync is not configured." />
        )}
        {configState !== 'loading' && mutate && (
          <ConfigForm
            client={client}
            initial={config}
            onSaved={(saved) => {
              setConfig(saved);
              setConfigState('ready');
              setNotice('Configuration saved.');
            }}
          />
        )}
        {configState === 'ready' && !mutate && config && (
          <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <dt className="text-xs uppercase text-zinc-500">Endpoint</dt>
              <dd className="mt-1 break-all text-zinc-100">{config.endpoint}</dd>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <dt className="text-xs uppercase text-zinc-500">Bucket</dt>
              <dd className="mt-1 text-zinc-100">{config.bucket}</dd>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <dt className="text-xs uppercase text-zinc-500">Region / prefix</dt>
              <dd className="mt-1 text-zinc-100">
                {config.region} · {config.prefix}
              </dd>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <dt className="text-xs uppercase text-zinc-500">Retention</dt>
              <dd className="mt-1 text-zinc-100">{config.retentionDays} days</dd>
            </div>
          </dl>
        )}
      </section>

      {mutate && configState === 'ready' && (
        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Sync</h3>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                void syncNow();
              }}
              disabled={busy}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void prune();
              }}
              disabled={busy}
            >
              Prune past retention
            </Button>
          </div>
          {syncResult && (
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
              <div className="text-zinc-300">
                Uploaded {syncResult.uploaded.length} · skipped {syncResult.skipped.length} · failed{' '}
                {syncResult.failed.length}
              </div>
              {syncResult.failed.length > 0 && (
                <ul className="mt-2 space-y-1 text-red-300">
                  {syncResult.failed.map((f) => (
                    <li key={f.backupId}>
                      {f.backupId}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Remote objects ({objects.length})
        </h3>
        {objects.length === 0 ? (
          <EmptyState message="No remote objects." />
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs uppercase text-zinc-500">
                  <th className="px-3 py-2">Key</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Last modified</th>
                  {mutate && <th className="px-3 py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr key={o.key} className="border-b border-zinc-800/60 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-zinc-200">{o.key}</td>
                    <td className="px-3 py-2 text-zinc-400">{formatBytes(o.size)}</td>
                    <td className="px-3 py-2 text-zinc-400">{formatTime(o.lastModified)}</td>
                    {mutate && (
                      <td className="px-3 py-2">
                        <RestoreRow
                          client={client}
                          object={o}
                          clients={clients}
                          onRestored={(profileId) => {
                            setNotice(`Restored into profile ${profileId}.`);
                          }}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
