/** API tokens page: list, create (plaintext shown exactly once), revoke. */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type { ApiToken } from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, formatTime, inputClass } from '../ui.js';

export function TokensPage({ client }: { client: ApiClient }): React.JSX.Element {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await client.listTokens();
      setTokens(res.tokens);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(id: string, tokenName: string): Promise<void> {
    if (!window.confirm(`Revoke token "${tokenName}"? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.revokeToken(id);
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">API tokens</h1>
        <Button variant="primary" onClick={(): void => {
          setShowCreate(true);
        }}>New token</Button>
      </div>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={(): void => {
            setError(null);
          }}
        />
      )}
      {tokens.length === 0 ? (
        <EmptyState message="No API tokens." />
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Prefix</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-t border-zinc-800">
                  <td className="px-4 py-2 font-medium">{t.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-400">{t.prefix}…</td>
                  <td className="px-4 py-2 text-zinc-400">{formatTime(t.createdAt)}</td>
                  <td className="px-4 py-2 text-zinc-400">{formatTime(t.lastUsedAt)}</td>
                  <td className="px-4 py-2">
                    {t.revokedAt ? (
                      <span className="text-red-400">revoked</span>
                    ) : (
                      <span className="text-green-400">active</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {!t.revokedAt && (
                      <Button variant="danger" disabled={busy} onClick={(): void => {
                        void revoke(t.id, t.name);
                      }}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal title="New API token" onClose={(): void => {
            setShowCreate(false);
            setPlaintext(null);
          }}>
          {plaintext ? (
            <div>
              <p className="mb-2 text-sm text-amber-300">
                Copy this token now — it will never be shown again.
              </p>
              <code className="block break-all rounded border border-amber-800 bg-amber-950/40 p-3 font-mono text-sm text-amber-200">
                {plaintext}
              </code>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" onClick={(): void => {
                  setShowCreate(false);
                  setPlaintext(null);
                }}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = name.trim();
                setName('');
                setError(null);
                client
                  .createToken(trimmed)
                  .then((res) => {
                    setPlaintext(res.plaintext);
                    return refresh();
                  })
                  .catch((err: unknown) => {
                    setError(messageOf(err));
                    setShowCreate(false);
                  });
              }}
            >
              <Field label="Token name">
                <input
                  className={inputClass}
                  value={name}
                  onChange={(e): void => {
                    setName(e.target.value);
                  }}
                  required
                  minLength={1}
                  maxLength={100}
                  autoFocus
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={(): void => {
                  setShowCreate(false);
                }}>Cancel</Button>
                <Button variant="primary" submit>Create token</Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
