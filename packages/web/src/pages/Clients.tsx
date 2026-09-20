/** Clients page: list + create. */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type { Client } from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, formatTime, inputClass } from '../ui.js';

export function ClientsPage({ client }: { client: ApiClient }): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await client.listClients();
      setClients(res.clients);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Button variant="primary" onClick={() => { setShowCreate(true); }}>New client</Button>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => { setError(null); }} />}
      {clients.length === 0 ? (
        <EmptyState message="No clients yet." />
      ) : (
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Notes</th>
                <th className="px-4 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-t border-zinc-800">
                  <td className="px-4 py-2 font-medium">{c.name}</td>
                  <td className="px-4 py-2 text-zinc-400">{c.notes ?? '—'}</td>
                  <td className="px-4 py-2 text-zinc-400">{formatTime(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showCreate && (
        <Modal title="New client" onClose={() => { setShowCreate(false); }}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              const trimmedNotes = notes.trim();
              setShowCreate(false);
              setName('');
              setNotes('');
              setError(null);
              client
                .createClient(trimmed, trimmedNotes ? trimmedNotes : undefined)
                .then(() => refresh())
                .catch((err: unknown) => { setError(messageOf(err)); });
            }}
          >
            <Field label="Name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => { setName(e.target.value); }}
                required
                minLength={1}
                maxLength={100}
                autoFocus
              />
            </Field>
            <Field label="Notes (optional)">
              <input
                className={inputClass}
                value={notes}
                onChange={(e) => { setNotes(e.target.value); }}
                maxLength={500}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setShowCreate(false); }}>Cancel</Button>
              <Button variant="primary" submit>Create</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
