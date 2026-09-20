/** Proxies page: list, add (credentials never shown back), health check, delete. */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type { PublicProxy } from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, formatTime, inputClass } from '../ui.js';

export function ProxiesPage({ client }: { client: ApiClient }): React.JSX.Element {
  const [proxies, setProxies] = useState<PublicProxy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    scheme: 'http',
    host: '',
    port: '8080',
    username: '',
    password: '',
    bypass: '',
    notes: '',
  });

  const refresh = useCallback(async () => {
    try {
      const res = await client.listProxies();
      setProxies(res.proxies);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const set =
    (key: keyof typeof form) =>
    (e: { target: { value: string } }): void => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    };

  async function healthCheck(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const res = await client.checkProxyHealth(id);
      const health = res.health as { ok?: boolean; latencyMs?: number; error?: string };
      window.alert(
        health.ok === true
          ? `Proxy is reachable${typeof health.latencyMs === 'number' ? ` (${String(health.latencyMs)} ms)` : ''}.`
          : `Health check failed: ${typeof health.error === 'string' ? health.error : 'unknown error'}`,
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proxies</h1>
        <Button variant="primary" onClick={(): void => {
          setShowCreate(true);
        }}>Add proxy</Button>
      </div>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={(): void => {
            setError(null);
          }}
        />
      )}
      {proxies.length === 0 ? (
        <EmptyState message="No proxies configured." />
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Endpoint</th>
                <th className="px-4 py-2">Auth</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800">
                  <td className="px-4 py-2 font-medium">{p.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-400">
                    {p.scheme}://{p.host}:{String(p.port)}
                  </td>
                  <td className="px-4 py-2 text-zinc-400">
                    {p.has_credentials ? `yes${p.username ? ` (${p.username})` : ''}` : 'no'}
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{formatTime(p.created_at)}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void healthCheck(p.id)}
                      >
                        {busy === p.id ? '…' : 'Health'}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm(`Delete proxy ${p.name}?`)) {
                            setBusy(p.id);
                            client
                              .deleteProxy(p.id)
                              .then((): void => {
                              void refresh();
                            })
                              .catch((err: unknown): void => {
                              setError(messageOf(err));
                            })
                              .finally((): void => {
                              setBusy(null);
                            });
                          }
                        }}
                      >
                        Delete
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
        <Modal title="Add proxy" onClose={(): void => {
          setShowCreate(false);
        }}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const port = Number.parseInt(form.port, 10);
              const payload = {
                name: form.name.trim(),
                scheme: form.scheme,
                host: form.host.trim(),
                port,
                ...(form.username.trim() ? { username: form.username.trim() } : {}),
                ...(form.password ? { password: form.password } : {}),
                ...(form.bypass.trim() ? { bypass: form.bypass.trim() } : {}),
                ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
              };
              setShowCreate(false);
              setForm({ name: '', scheme: 'http', host: '', port: '8080', username: '', password: '', bypass: '', notes: '' });
              setError(null);
              client
                .createProxy(payload)
                .then((): void => {
                              void refresh();
                            })
                .catch((err: unknown): void => {
                              setError(messageOf(err));
                            });
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name">
                <input className={inputClass} value={form.name} onChange={set('name')} required maxLength={100} autoFocus />
              </Field>
              <Field label="Scheme">
                <select className={inputClass} value={form.scheme} onChange={set('scheme')}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                  <option value="socks5">socks5</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Host">
                <input className={inputClass} value={form.host} onChange={set('host')} required maxLength={255} />
              </Field>
              <Field label="Port">
                <input
                  className={inputClass}
                  value={form.port}
                  onChange={set('port')}
                  required
                  inputMode="numeric"
                  pattern="[0-9]+"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Username (optional)">
                <input className={inputClass} value={form.username} onChange={set('username')} maxLength={100} />
              </Field>
              <Field label="Password (optional)">
                <input
                  className={inputClass}
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  maxLength={500}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <Field label="Bypass (optional, comma-separated hosts)">
              <input className={inputClass} value={form.bypass} onChange={set('bypass')} maxLength={500} />
            </Field>
            <p className="text-xs text-zinc-500">
              Credentials are stored server-side and never displayed again. Note:
              proxy authentication is not supported in this build — a proxy with
              credentials configured will refuse launches (fail-closed).
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={(): void => {
                setShowCreate(false);
              }}>Cancel</Button>
              <Button variant="primary" submit>Add proxy</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
