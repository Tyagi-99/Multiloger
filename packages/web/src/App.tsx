/**
 * Dashboard shell: token gate, sidebar nav, live resource pill, and a single
 * authenticated WebSocket subscription whose events refresh the pages.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthProvider, useAuth } from './auth.js';
import { messageOf } from './api.js';
import type { DomainEvent, ResourceStatus } from './types.js';
import { useEvents, type EventsStatus } from './events.js';
import { ProfilesPage } from './pages/Profiles.js';
import { ClientsPage } from './pages/Clients.js';
import { ProxiesPage } from './pages/Proxies.js';
import { TokensPage } from './pages/Tokens.js';
import { BackupsPage } from './pages/Backups.js';
import { TeamPage } from './pages/Team.js';
import { AuditPage } from './pages/Audit.js';
import { Button, Field, inputClass } from './ui.js';
import type { IdentityInfo } from './types.js';

type Page = 'profiles' | 'clients' | 'proxies' | 'backups' | 'tokens' | 'team' | 'audit';

const ALL_NAV: { id: Page; label: string; permission: string }[] = [
  { id: 'profiles', label: 'Profiles', permission: 'profiles:read' },
  { id: 'clients', label: 'Clients', permission: 'clients:read' },
  { id: 'proxies', label: 'Proxies', permission: 'proxies:read' },
  { id: 'backups', label: 'Backups', permission: 'backups:read' },
  { id: 'tokens', label: 'API tokens', permission: 'tokens:read' },
  { id: 'team', label: 'Team', permission: 'users:manage' },
  { id: 'audit', label: 'Audit log', permission: 'audit:read' },
];

type LoginMode = 'token' | 'password';

function LoginScreen(): React.JSX.Element {
  const { login, loginWithPassword } = useAuth();
  const [mode, setMode] = useState<LoginMode>('token');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'token') {
        await login(token);
      } else {
        await loginWithPassword(email, password);
      }
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div>
          <h1 className="text-xl font-semibold">Multiloger</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {mode === 'token'
              ? 'Enter an API token to manage your browser profiles.'
              : 'Sign in with your team account to receive an API token.'}
          </p>
        </div>
        <div className="flex gap-2">
          {(['token', 'password'] as LoginMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                mode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {m === 'token' ? 'API token' : 'Email + password'}
            </button>
          ))}
        </div>
        {mode === 'token' ? (
          <Field label="API token">
            <input
              className={`${inputClass} font-mono`}
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
              }}
              placeholder="mlt_…"
              autoComplete="off"
              autoFocus
            />
          </Field>
        ) : (
          <>
            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="Password">
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                autoComplete="current-password"
                required
              />
            </Field>
          </>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button
          variant="primary"
          submit
          disabled={
            busy ||
            (mode === 'token'
              ? token.trim().length === 0
              : email.trim().length === 0 || password.length === 0)
          }
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <p className="text-xs text-zinc-600">
          {mode === 'token'
            ? 'Create a token with the bootstrap token via POST /v1/tokens, then sign in here. Tokens are stored in this browser\u2019s local storage only.'
            : 'An admin creates your account and sends you an invitation. Your password never leaves this form except over your API connection.'}
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
  const label = status === 'connected' ? 'live' : status === 'disabled' ? 'signed out' : status;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-zinc-400"
      title={`WebSocket: ${status}`}
    >
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
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);

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

  useEffect(() => {
    client
      .getIdentity()
      .then((res) => {
        setIdentity(res.identity);
      })
      .catch(() => {
        setIdentity(null);
      });
  }, [client]);

  const nav = useMemo(
    () =>
      ALL_NAV.filter((item) => {
        if (!identity) {
          return true; // unknown yet: show everything, API still enforces
        }
        return (
          identity.legacy || identity.isAdmin || identity.permissions.includes(item.permission)
        );
      }),
    [identity],
  );

  useEffect(() => {
    if (identity && !nav.some((item) => item.id === page)) {
      setPage(nav[0]?.id ?? 'profiles');
    }
  }, [identity, nav, page]);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-4">
        <h1 className="mb-6 text-lg font-bold tracking-tight">Multiloger</h1>
        <nav className="flex flex-col gap-1">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setPage(item.id);
              }}
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
          {identity?.user && (
            <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-400">
              <div className="truncate font-medium text-zinc-300">{identity.user.name}</div>
              <div className="truncate text-zinc-500">{identity.user.email}</div>
              <div className="mt-1 text-zinc-500">{identity.user.roles.join(', ')}</div>
            </div>
          )}
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
        {page === 'team' && <TeamPage client={client} identity={identity} />}
        {page === 'audit' && <AuditPage client={client} />}
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
