/**
 * Team page: user management, role assignment, client/profile scoping,
 * per-user tokens, and invitations (Phase 3).
 */

import { useCallback, useEffect, useState } from 'react';
import { messageOf, type ApiClient } from '../api.js';
import type {
  Client,
  IdentityInfo,
  InvitationInfo,
  ProfileDetail,
  RoleInfo,
  TeamUser,
} from '../types.js';
import { Button, EmptyState, ErrorBanner, Field, Modal, formatTime, inputClass } from '../ui.js';

const PERMISSION_CATALOG = [
  'profiles:read',
  'profiles:create',
  'profiles:launch',
  'profiles:stop',
  'profiles:delete',
  'profiles:proxy',
  'clients:read',
  'clients:manage',
  'proxies:read',
  'proxies:manage',
  'automation:read',
  'automation:scripts:manage',
  'automation:run',
  'backups:read',
  'backups:create',
  'backups:restore',
  'backups:delete',
  'tokens:read',
  'tokens:manage',
  'users:manage',
  'audit:read',
];

function ManageUserModal({
  client,
  user,
  clients,
  profiles,
  roles,
  onClose,
  onChanged,
}: {
  client: ApiClient;
  user: TeamUser;
  clients: Client[];
  profiles: ProfileDetail[];
  roles: RoleInfo[];
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userRoles, setUserRoles] = useState<string[]>(user.roles);
  const [grants, setGrants] = useState<{ clients: string[]; profiles: string[] } | null>(null);
  const [tokenName, setTokenName] = useState('');
  const [tokenScopes, setTokenScopes] = useState('');
  const [issued, setIssued] = useState<string | null>(null);

  useEffect(() => {
    client
      .getUserScopes(user.id)
      .then((res) => {
        setGrants(res.scopes);
      })
      .catch((e: unknown) => {
        setError(messageOf(e));
      });
  }, [client, user.id]);

  async function run(fn: () => Promise<unknown>): Promise<void> {
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

  async function toggleRole(roleId: string, has: boolean): Promise<void> {
    await run(async () => {
      if (has) {
        const res = await client.removeRole(user.id, roleId);
        setUserRoles(res.user.roles);
      } else {
        const res = await client.assignRole(user.id, roleId);
        setUserRoles(res.user.roles);
      }
    });
  }

  async function toggleClientAccess(clientId: string, has: boolean): Promise<void> {
    await run(async () => {
      if (has) {
        await client.revokeClientAccess(user.id, clientId);
      } else {
        await client.grantClientAccess(user.id, clientId);
      }
      setGrants((g) =>
        g === null
          ? g
          : {
              clients: has ? g.clients.filter((c) => c !== clientId) : [...g.clients, clientId],
              profiles: g.profiles,
            },
      );
    });
  }

  async function toggleProfileAccess(profileId: string, has: boolean): Promise<void> {
    await run(async () => {
      if (has) {
        await client.revokeProfileAccess(user.id, profileId);
      } else {
        await client.grantProfileAccess(user.id, profileId);
      }
      setGrants((g) =>
        g === null
          ? g
          : {
              clients: g.clients,
              profiles: has
                ? g.profiles.filter((p) => p !== profileId)
                : [...g.profiles, profileId],
            },
      );
    });
  }

  async function issueToken(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const scopes = tokenScopes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await run(async () => {
      const res = await client.issueUserToken(
        user.id,
        tokenName.trim(),
        scopes.length > 0 ? scopes : undefined,
      );
      setIssued(res.token);
      setTokenName('');
      setTokenScopes('');
    });
  }

  return (
    <Modal title={`Manage ${user.name}`} onClose={onClose}>
      <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-1">
        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => {
              setError(null);
            }}
          />
        )}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Roles</h3>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => {
              const has = userRoles.includes(r.id);
              return (
                <label
                  key={r.id}
                  className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm ${
                    has ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-800 text-zinc-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={has}
                    disabled={busy}
                    onChange={() => {
                      void toggleRole(r.id, has);
                    }}
                  />
                  {r.name}
                </label>
              );
            })}
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Client access</h3>
          {grants === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => {
                const has = grants.clients.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm ${
                      has
                        ? 'border-zinc-500 bg-zinc-800 text-white'
                        : 'border-zinc-800 text-zinc-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={has}
                      disabled={busy}
                      onChange={() => {
                        void toggleClientAccess(c.id, has);
                      }}
                    />
                    {c.name}
                  </label>
                );
              })}
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">
            Profile access{' '}
            <span className="font-normal text-zinc-500">
              (direct grants; client access covers the rest)
            </span>
          </h3>
          {grants === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {profiles.map((p) => {
                const has = grants.profiles.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm ${
                      has
                        ? 'border-zinc-500 bg-zinc-800 text-white'
                        : 'border-zinc-800 text-zinc-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={has}
                      disabled={busy}
                      onChange={() => {
                        void toggleProfileAccess(p.id, has);
                      }}
                    />
                    {p.name}
                  </label>
                );
              })}
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Issue API token</h3>
          {issued ? (
            <div>
              <p className="mb-2 text-sm text-amber-300">
                Copy this token now — it will never be shown again.
              </p>
              <code className="block break-all rounded border border-amber-800 bg-amber-950/40 p-3 font-mono text-sm text-amber-200">
                {issued}
              </code>
              <div className="mt-2 flex justify-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setIssued(null);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                void issueToken(e);
              }}
            >
              <Field label="Token name">
                <input
                  className={inputClass}
                  value={tokenName}
                  onChange={(e) => {
                    setTokenName(e.target.value);
                  }}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="Scopes (comma-separated, optional)">
                <input
                  className={inputClass}
                  value={tokenScopes}
                  onChange={(e) => {
                    setTokenScopes(e.target.value);
                  }}
                  placeholder="profiles:read, automation:read"
                />
              </Field>
              <Button variant="primary" submit disabled={busy || tokenName.trim().length === 0}>
                Issue
              </Button>
            </form>
          )}
          <p className="mt-1 text-xs text-zinc-600">
            Scopes can only narrow the user&apos;s role permissions, never widen them.
          </p>
        </section>
      </div>
    </Modal>
  );
}

function InviteDialog({
  client,
  roles,
  clients,
  onClose,
  onChanged,
}: {
  client: ApiClient;
  roles: RoleInfo[];
  clients: Client[];
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('viewer');
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [expiresInHours, setExpiresInHours] = useState('72');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ token: string; email: string } | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const hours = Number(expiresInHours);
      const input: {
        email: string;
        roleId: string;
        clientIds?: string[];
        expiresInHours?: number;
      } = {
        email: email.trim(),
        roleId,
      };
      if (clientIds.length > 0) {
        input.clientIds = clientIds;
      }
      if (Number.isFinite(hours) && hours > 0) {
        input.expiresInHours = hours;
      }
      const res = await client.createInvitation(input);
      setIssued({ token: res.token, email: res.invitation.email });
      onChanged();
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Invite user" onClose={onClose}>
      {issued ? (
        <div>
          <p className="mb-2 text-sm text-zinc-300">
            Invitation created for <span className="font-medium">{issued.email}</span>. Deliver this
            token to them yourself — Multiloger does not send email.
          </p>
          <p className="mb-2 text-sm text-amber-300">
            This token is shown exactly once. They redeem it at{' '}
            <code className="font-mono">POST /v1/invitations/redeem</code> with a name and password.
          </p>
          <code className="block break-all rounded border border-amber-800 bg-amber-950/40 p-3 font-mono text-sm text-amber-200">
            {issued.token}
          </code>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          {error && (
            <ErrorBanner
              message={error}
              onDismiss={() => {
                setError(null);
              }}
            />
          )}
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              required
              autoFocus
            />
          </Field>
          <Field label="Role">
            <select
              className={inputClass}
              value={roleId}
              onChange={(e) => {
                setRoleId(e.target.value);
              }}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <div>
            <span className="mb-1 block text-sm text-zinc-400">Client access</span>
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={clientIds.includes(c.id)}
                    onChange={() => {
                      setClientIds((prev) =>
                        prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                      );
                    }}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
          <Field label="Expires in (hours)">
            <input
              className={inputClass}
              type="number"
              min={1}
              value={expiresInHours}
              onChange={(e) => {
                setExpiresInHours(e.target.value);
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" submit disabled={busy}>
              Create invitation
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function CreateUserDialog({
  client,
  roles,
  onClose,
  onChanged,
}: {
  client: ApiClient;
  roles: RoleInfo[];
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>(['viewer']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createUser({ name: name.trim(), email: email.trim(), password, roleIds });
      onChanged();
      onClose();
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => {
              setError(null);
            }}
          />
        )}
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            required
            maxLength={200}
            autoFocus
          />
        </Field>
        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            required
          />
        </Field>
        <Field label="Password (min 12 characters)">
          <input
            className={inputClass}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            required
            minLength={12}
            autoComplete="new-password"
          />
        </Field>
        <div>
          <span className="mb-1 block text-sm text-zinc-400">Roles</span>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={roleIds.includes(r.id)}
                  onChange={() => {
                    setRoleIds((prev) =>
                      prev.includes(r.id) ? prev.filter((id) => id !== r.id) : [...prev, r.id],
                    );
                  }}
                />
                {r.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" submit disabled={busy}>
            Create user
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateRoleDialog({
  client,
  onClose,
  onChanged,
}: {
  client: ApiClient;
  onClose: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<string[]>(['profiles:read']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createRole({ id: id.trim(), name: name.trim(), permissions });
      onChanged();
      onClose();
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New role" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => {
              setError(null);
            }}
          />
        )}
        <Field label="Role id (lowercase, e.g. support)">
          <input
            className={inputClass}
            value={id}
            onChange={(e) => {
              setId(e.target.value);
            }}
            required
            pattern="[a-z0-9-]+"
            autoFocus
          />
        </Field>
        <Field label="Display name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            required
          />
        </Field>
        <div>
          <span className="mb-1 block text-sm text-zinc-400">Permissions</span>
          <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded border border-zinc-800 p-2">
            {PERMISSION_CATALOG.map((p) => (
              <label key={p} className="flex items-center gap-2 font-mono text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={permissions.includes(p)}
                  onChange={() => {
                    setPermissions((prev) =>
                      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
                    );
                  }}
                />
                {p}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" submit disabled={busy || permissions.length === 0}>
            Create role
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TeamPage({
  client,
  identity,
}: {
  client: ApiClient;
  identity: IdentityInfo | null;
}): React.JSX.Element {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [profiles, setProfiles] = useState<ProfileDetail[]>([]);
  const [invitations, setInvitations] = useState<InvitationInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState<TeamUser | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreateRole, setShowCreateRole] = useState(false);
  const [tab, setTab] = useState<'users' | 'invitations' | 'roles'>('users');

  const refresh = useCallback(async () => {
    try {
      const [u, r, c, p, i] = await Promise.all([
        client.listUsers(),
        client.listRoles(),
        client.listClients(),
        client.listProfiles(),
        client.listInvitations(),
      ]);
      setUsers(u.users);
      setRoles(r.roles);
      setClients(c.clients);
      setProfiles(p.profiles);
      setInvitations(i.invitations);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const selfId = identity?.userId ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Team</h1>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setShowInvite(true);
            }}
          >
            Invite user
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setShowCreateUser(true);
            }}
          >
            New user
          </Button>
        </div>
      </div>
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            setError(null);
          }}
        />
      )}

      <div className="mb-4 flex gap-2">
        {(['users', 'invitations', 'roles'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
            }}
            className={`rounded px-3 py-1.5 text-sm font-medium capitalize ${
              tab === t ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'users' &&
        (users.length === 0 ? (
          <EmptyState message="No users yet." />
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Roles</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-zinc-800">
                    <td className="px-4 py-2 font-medium">
                      {u.name}
                      {u.id === selfId && <span className="ml-2 text-xs text-zinc-500">(you)</span>}
                    </td>
                    <td className="px-4 py-2 text-zinc-400">{u.email}</td>
                    <td className="px-4 py-2 text-zinc-400">{u.roles.join(', ') || '—'}</td>
                    <td className="px-4 py-2">
                      {u.disabled ? (
                        <span className="text-red-400">disabled</span>
                      ) : (
                        <span className="text-green-400">active</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setManaging(u);
                          }}
                        >
                          Manage
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy || u.id === selfId}
                          onClick={() => {
                            void run(() => client.updateUser(u.id, { disabled: !u.disabled }));
                          }}
                        >
                          {u.disabled ? 'Enable' : 'Disable'}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || u.id === selfId}
                          onClick={() => {
                            if (
                              window.confirm(`Delete user "${u.name}"? Their tokens are revoked.`)
                            ) {
                              void run(() => client.deleteUser(u.id));
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
        ))}

      {tab === 'invitations' &&
        (invitations.length === 0 ? (
          <EmptyState message="No invitations." />
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Expires</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} className="border-t border-zinc-800">
                    <td className="px-4 py-2 font-medium">{inv.email}</td>
                    <td className="px-4 py-2 text-zinc-400">{inv.roleId}</td>
                    <td className="px-4 py-2 text-zinc-400">{formatTime(inv.expiresAt)}</td>
                    <td className="px-4 py-2">
                      {inv.usedAt ? (
                        <span className="text-zinc-500">redeemed</span>
                      ) : (
                        <span className="text-amber-300">pending</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {!inv.usedAt && (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Revoke the invitation for "${inv.email}"?`)) {
                              void run(() => client.revokeInvitation(inv.id));
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'roles' && (
        <div>
          <div className="mb-3 flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                setShowCreateRole(true);
              }}
            >
              New role
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {roles.map((r) => (
              <div key={r.id} className="rounded border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">
                    {r.name}
                    {r.seeded && <span className="ml-2 text-xs text-zinc-500">built-in</span>}
                  </h3>
                  {!r.seeded && (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete the "${r.name}" role?`)) {
                          void run(() => client.deleteRole(r.id));
                        }
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
                <p className="mt-2 font-mono text-xs leading-5 text-zinc-400">
                  {r.permissions.join(', ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {managing && (
        <ManageUserModal
          client={client}
          user={managing}
          clients={clients}
          profiles={profiles}
          roles={roles}
          onClose={() => {
            setManaging(null);
          }}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
      {showInvite && (
        <InviteDialog
          client={client}
          roles={roles}
          clients={clients}
          onClose={() => {
            setShowInvite(false);
          }}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
      {showCreateUser && (
        <CreateUserDialog
          client={client}
          roles={roles}
          onClose={() => {
            setShowCreateUser(false);
          }}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
      {showCreateRole && (
        <CreateRoleDialog
          client={client}
          onClose={() => {
            setShowCreateRole(false);
          }}
          onChanged={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}
