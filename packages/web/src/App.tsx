/**
 * Dashboard shell: token gate, sidebar nav, live resource pill, and a single
 * authenticated WebSocket subscription whose events refresh the pages.
 */

import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth.js';
import { messageOf } from './api.js';
import type { DomainEvent, ResourceStatus } from './types.js';
import { useEvents, type EventsStatus } from './events.js';
import { ProfilesPage } from './pages/Profiles.js';
import { ClientsPage } from './pages/Clients.js';
import { ProxiesPage } from './pages/Proxies.js';
import { TokensPage } from './pages/Tokens.js';
import { BackupsPage } from './pages/Backups.js';
import { Button, Field, inputClass } from './ui.js';

type Page = 'profiles' | 'clients' | 'proxies' | 'backups' | 'tokens';

const NAV: { id: Page; label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'clients', label: 'Clients' },
  { id: 'proxies', label: 'Proxies' },
  { id: 'backups', label: 'Backups' },
  { id: 'tokens', label: 'API tokens' },
];

function LoginScreen(): React.JSX.Element {
  const { login } = useAuth();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          login(token)
            .catch((err: unknown) => { setError(messageOf(err)); })
            .finally(() => { setBusy(false); });
        }}
      >
        <div>
          <h1 className="text-xl font-semibold">Multiloger</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Enter an API token to manage your browser profiles.
          </p>
        </div>
        <Field label="API token">
          <input
            className={`${inputClass} font-mono`}
            type="password"
            value={token}
            onChange={(e) => { setToken(e.target.value); }}
            placeholder="mlt_…"
            autoComplete="off"
            autoFocus
          />
        </Field>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button variant="primary" submit disabled={busy || token.trim().length === 0}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <p className="text-xs text-zinc-600">
          Create a token with the bootstrap token via <code>POST /v1/tokens</code>, then sign in
          here. Tokens are stored in this browser&apos;s local storage only.
        </p>
      </form>
    </div>
  );
}

function statusDot(status: EventsStatus): React.JSX.Element {
  const color =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'disabled'
        ? 'bg-zinc-600'
        : 'bg-yellow-500';
  const label =
    status === 'connected'
      ? 'live'
      : status === 'disabled'
        ? 'signed out'
        : status;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400" title={`WebSocket: ${status}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function Dashboard(): React.JSX.Element {
  const { token, client, logout } = useAuth();
  const [page, setPage] = useState<Page>('profiles');
  const [eventCount, setEventCount] = useState(0);
  const [resources, setResources] = useState<ResourceStatus | null>(null);

  const onEvent = useCallback((_event: DomainEvent) => {
    setEventCount((n) => n + 1);
  }, []);
  const eventsStatus = useEvents(token, onEvent);

  const refreshResources = useCallback(async () => {
    try {
      setResources(await client.resourceStatus());
    } catch {
      setResources(null);
    }
  }, [client]);

  useEffect(() => {
    void refreshResources();
  }, [refreshResources, eventCount]);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-4">
        <h1 className="mb-6 text-lg font-bold tracking-tight">Multiloger</h1>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setPage(item.id); }}
              className={`rounded px-3 py-2 text-left text-sm font-medium transition-colors ${
                page === item.id
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3 pt-6">
          <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-400">
            <div className="mb-1 font-medium uppercase tracking-wide text-zinc-500">Resources</div>
            {resources?.enabled ? (
              <div>
                running {String(resources.running ?? 0)}/{String(resources.maxConcurrent ?? '?')}
                {' · '}queued {String(resources.queued?.length ?? 0)}
              </div>
            ) : (
              <div>governor disabled</div>
            )}
            <div className="mt-1">{statusDot(eventsStatus)}</div>
          </div>
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        {page === 'profiles' && <ProfilesPage client={client} eventCount={eventCount} />}
        {page === 'clients' && <ClientsPage client={client} />}
        {page === 'proxies' && <ProxiesPage client={client} />}
        {page === 'backups' && <BackupsPage client={client} eventCount={eventCount} />}
        {page === 'tokens' && <TokensPage client={client} />}
      </main>
    </div>
  );
}

function Shell(): React.JSX.Element {
  const { token } = useAuth();
  return token ? <Dashboard /> : <LoginScreen />;
}

export function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
