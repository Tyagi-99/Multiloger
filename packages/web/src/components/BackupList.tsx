/**
 * Backup list with verify / restore / delete actions. Used by the profile
 * detail drawer and the Backups page.
 */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type { Backup } from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, formatBytes, formatTime, inputClass } from '../ui.js';

export function BackupList({
  client,
  profileId,
  profileName,
  onChanged,
}: {
  client: ApiClient;
  profileId: string;
  profileName: string;
  onChanged: () => void;
}): React.JSX.Element {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreName, setRestoreName] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await client.listBackups(profileId);
      setBackups(res.backups);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client, profileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(id: string, fn: () => Promise<unknown>, after?: () => void): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
      after?.();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">Backups</h3>
        <Button
          variant="primary"
          disabled={busy !== null}
          onClick={() => void run('create', () => client.createBackup(profileId))}
        >
          {busy === 'create' ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => { setError(null); }} />}
      {backups.length === 0 ? (
        <EmptyState message={`No backups for ${profileName} yet.`} />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3">Created</th>
              <th className="py-2 pr-3">Size</th>
              <th className="py-2 pr-3">SHA-256</th>
              <th className="py-2 pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id} className="border-t border-zinc-800">
                <td className="py-2 pr-3">{formatTime(b.createdAt)}</td>
                <td className="py-2 pr-3">{formatBytes(b.sizeBytes)}</td>
                <td className="py-2 pr-3 font-mono text-xs text-zinc-400" title={b.sha256}>
                  {b.sha256.slice(0, 12)}…
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void run(`verify:${b.id}`, () => client.verifyBackup(b.id))}
                    >
                      Verify
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setRestoreTarget(b);
                        setRestoreName(`${profileName}-restored`);
                      }}
                    >
                      Restore…
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(`Delete backup from ${formatTime(b.createdAt)}?`)) {
                          void run(`delete:${b.id}`, () => client.deleteBackup(b.id));
                        }
                      }}
                    >
                      {busy === `delete:${b.id}` ? '…' : 'Delete'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoreTarget && (
        <Modal title="Restore backup" onClose={() => { setRestoreTarget(null); }}>
          <p className="mb-4 text-sm text-zinc-400">
            Restores into a <strong>new</strong> profile. The source profile and the backup are left
            untouched.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const target = restoreTarget;
              setRestoreTarget(null);
              void run(`restore:${target.id}`, () =>
                client.restoreBackup(target.id, restoreName.trim()),
              );
            }}
          >
            <Field label="New profile name">
              <input
                className={inputClass}
                value={restoreName}
                onChange={(e) => { setRestoreName(e.target.value); }}
                required
                minLength={1}
                maxLength={100}
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setRestoreTarget(null); }}>
                Cancel
              </Button>
              <Button variant="primary" submit disabled={restoreName.trim().length === 0}>
                Restore
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
