/**
 * Team management, invitation, auth, and audit-log routes (Phase 3).
 *
 * - POST /v1/auth/login: password login → issues an API token attributed to
 *   the user (public; anonymous rate limit applies).
 * - POST /v1/auth/password: change own password (authenticated).
 * - GET /v1/auth/me: identity summary for the dashboard / MCP.
 * - /v1/users*: CRUD, role assignment, client/profile scoping (users:manage).
 * - /v1/invitations*: invite lifecycle (users:manage) + public redeem.
 * - /v1/roles, /v1/permissions: catalog reads + custom-role CRUD (roles:manage).
 * - GET /v1/audit-log: filtered, paginated; non-admins see only their own
 *   actions (audit:read).
 *
 * Invitations have no email delivery: create returns the invite token once
 * and the admin delivers it out-of-band. This is documented, not hidden.
 */

import { burnDummyVerification } from './auth.js';
import { hasPermission, requireIdentity } from './access.js';
import { queryAuditLog } from './audit.js';
import { verifyPassword } from './passwords.js';
import {
  defineRoute,
  getStringArrayField,
  getStringField,
  requireObjectBody,
  sendJson,
  ValidationError,
  type Route,
  type RouteContext,
} from './router.js';
import { createApiToken, listApiTokens, revokeApiToken, TokenNotFoundError } from './tokens.js';
import {
  addUserRole,
  countAdmins,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  getUser,
  getUserByEmail,
  getUserPasswordHash,
  getUserScopes,
  grantClientAccess,
  grantProfileAccess,
  listRoles,
  listUsers,
  removeUserRole,
  revokeClientAccess,
  revokeProfileAccess,
  setUserPassword,
  updateUser,
  userHasRole,
  type PublicUser,
} from './users.js';
import {
  createInvitation,
  listInvitations,
  redeemInputFromBody,
  redeemInvitation,
  revokeInvitation,
} from './invitations.js';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

// ---------------------------------------------------------------- auth

async function login(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const email = getStringField(body, 'email', { required: true, maxLength: 254 });
  const password = getStringField(body, 'password', { required: true, maxLength: 256 });
  const name = getStringField(body, 'name', { maxLength: 100 });
  const user = await getUserByEmail(ctx.db, email ?? '');
  const stored = user ? await getUserPasswordHash(ctx.db, user.id) : null;
  let ok = false;
  if (user && stored && !user.disabled) {
    ok = await verifyPassword(password ?? '', stored);
  } else {
    // Unknown/disabled users fail exactly like a wrong password (no
    // enumeration) and burn a dummy hash to blunt timing probes.
    await burnDummyVerification();
  }
  if (!user || user.disabled || !ok) {
    throw new InvalidCredentialsError();
  }
  const created = await createApiToken(ctx.db, name?.trim() ?? 'password-login', {
    userId: user.id,
  });
  ctx.auditActor = { type: 'user', id: user.id };
  ctx.auditEntityId = created.id;
  sendJson(ctx.res, 201, {
    user: { id: user.id, name: user.name, email: user.email, roles: user.roles },
    token: { id: created.id, name: created.name, token: created.token, createdAt: created.createdAt },
  });
}

async function changePassword(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  if (identity.userId === null) {
    throw new ValidationError('Legacy tokens cannot change a password: no user is attached');
  }
  const body = requireObjectBody(ctx.body);
  const currentPassword = getStringField(body, 'currentPassword', { required: true, maxLength: 256 });
  const newPassword = getStringField(body, 'newPassword', { required: true, maxLength: 256 });
  const stored = await getUserPasswordHash(ctx.db, identity.userId);
  if (!stored || !(await verifyPassword(currentPassword ?? '', stored))) {
    throw new InvalidCredentialsError();
  }
  await setUserPassword(ctx.db, identity.userId, newPassword ?? '');
  ctx.auditEntityId = identity.userId;
  sendJson(ctx.res, 200, { changed: true });
}

async function me(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const user = identity.userId ? await getUser(ctx.db, identity.userId) : null;
  sendJson(ctx.res, 200, {
    identity: {
      kind: identity.kind,
      legacy: identity.legacy,
      isAdmin: identity.isAdmin,
      tokenId: identity.tokenId,
      userId: identity.userId,
      user,
      permissions: identity.legacy ? ['*'] : [...identity.permissions].sort(),
    },
  });
}

// ---------------------------------------------------------------- users

async function createUserRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { required: true, maxLength: 200 });
  const email = getStringField(body, 'email', { required: true, maxLength: 254 });
  const password = getStringField(body, 'password', { required: true, maxLength: 256 });
  const roleIds = getStringArrayField(body, 'roleIds');
  const user = await createUser(ctx.db, {
    name: name ?? '',
    email: email ?? '',
    password: password ?? '',
    ...(roleIds !== undefined ? { roleIds } : {}),
  });
  ctx.auditEntityId = user.id;
  sendJson(ctx.res, 201, { user });
}

async function listUsersRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { users: await listUsers(ctx.db) });
}

async function getUserRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { user: await getUser(ctx.db, ctx.params.id ?? '') });
}

/** Guards the last-admin rule: never leave zero enabled admins. */
async function assertNotLastAdminRemoval(
  db: RouteContext['db'],
  target: PublicUser,
  removingAdmin: boolean,
): Promise<void> {
  if (!removingAdmin) {
    return;
  }
  const admins = await countAdmins(db);
  if (admins <= 1) {
    throw new ValidationError(`Refusing: ${target.email} is the last admin`);
  }
}

async function patchUserRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const id = ctx.params.id ?? '';
  const target = await getUser(ctx.db, id);
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { maxLength: 200 });
  const disabledRaw = body.disabled;
  if (disabledRaw !== undefined && typeof disabledRaw !== 'boolean') {
    throw new ValidationError('Field must be a boolean: disabled');
  }
  if (id === identity.userId) {
    throw new ValidationError('You cannot disable your own account');
  }
  if (disabledRaw === true) {
    await assertNotLastAdminRemoval(ctx.db, target, await userHasRole(ctx.db, id, 'admin'));
  }
  const user = await updateUser(ctx.db, id, {
    ...(name !== undefined ? { name } : {}),
    ...(disabledRaw !== undefined ? { disabled: disabledRaw } : {}),
  });
  sendJson(ctx.res, 200, { user });
}

async function deleteUserRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const id = ctx.params.id ?? '';
  const target = await getUser(ctx.db, id);
  if (id === identity.userId) {
    throw new ValidationError('You cannot delete your own account');
  }
  await assertNotLastAdminRemoval(ctx.db, target, await userHasRole(ctx.db, id, 'admin'));
  await deleteUser(ctx.db, id);
  sendJson(ctx.res, 200, { deleted: true });
}

async function addRoleRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const roleId = getStringField(body, 'roleId', { required: true, maxLength: 100 });
  const user = await addUserRole(ctx.db, ctx.params.id ?? '', roleId ?? '');
  sendJson(ctx.res, 200, { user });
}

async function removeRoleRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const id = ctx.params.id ?? '';
  const roleId = ctx.params.roleId ?? '';
  const target = await getUser(ctx.db, id);
  const removingOwnAdmin = id === identity.userId && roleId === 'admin';
  if (removingOwnAdmin) {
    throw new ValidationError('You cannot remove your own admin role');
  }
  await assertNotLastAdminRemoval(ctx.db, target, roleId === 'admin');
  const user = await removeUserRole(ctx.db, id, roleId);
  sendJson(ctx.res, 200, { user });
}

async function grantClientRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const clientId = getStringField(body, 'clientId', { required: true });
  await grantClientAccess(ctx.db, ctx.params.id ?? '', clientId ?? '');
  sendJson(ctx.res, 200, { scopes: await getUserScopes(ctx.db, ctx.params.id ?? '') });
}

async function revokeClientRoute(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await revokeClientAccess(ctx.db, id, ctx.params.clientId ?? '');
  sendJson(ctx.res, 200, { scopes: await getUserScopes(ctx.db, id) });
}

async function grantProfileRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const profileId = getStringField(body, 'profileId', { required: true });
  await grantProfileAccess(ctx.db, ctx.params.id ?? '', profileId ?? '');
  sendJson(ctx.res, 200, { scopes: await getUserScopes(ctx.db, ctx.params.id ?? '') });
}

async function revokeProfileRoute(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await revokeProfileAccess(ctx.db, id, ctx.params.profileId ?? '');
  sendJson(ctx.res, 200, { scopes: await getUserScopes(ctx.db, id) });
}

async function getScopesRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { scopes: await getUserScopes(ctx.db, ctx.params.id ?? '') });
}

async function getUserTokensRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const id = ctx.params.id ?? '';
  if (!hasPermission(identity, 'users:manage') && id !== identity.userId) {
    throw new ValidationError('You can only list your own tokens');
  }
  await getUser(ctx.db, id);
  sendJson(ctx.res, 200, { tokens: await listApiTokens(ctx.db, { userId: id }) });
}

// ---------------------------------------------------------------- invitations

async function createInvitationRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const body = requireObjectBody(ctx.body);
  const email = getStringField(body, 'email', { required: true, maxLength: 254 });
  const roleId = getStringField(body, 'roleId', { required: true, maxLength: 100 });
  const clientIds = getStringArrayField(body, 'clientIds');
  const profileIds = getStringArrayField(body, 'profileIds');
  const expiresRaw = body.expiresInHours;
  if (expiresRaw !== undefined && (typeof expiresRaw !== 'number' || !Number.isFinite(expiresRaw))) {
    throw new ValidationError('Field must be a number: expiresInHours');
  }
  const created = await createInvitation(ctx.db, {
    email: email ?? '',
    roleId: roleId ?? '',
    ...(clientIds !== undefined ? { clientIds } : {}),
    ...(profileIds !== undefined ? { profileIds } : {}),
    ...(expiresRaw !== undefined ? { expiresInHours: expiresRaw } : {}),
    ...(identity.tokenId ? { createdBy: identity.tokenId } : {}),
  });
  ctx.auditEntityId = created.invitation.id;
  // The plaintext invite token is returned HERE and only here. There is no
  // email delivery: the admin passes it to the invitee out-of-band.
  sendJson(ctx.res, 201, { invitation: created.invitation, token: created.token });
}

async function listInvitationsRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { invitations: await listInvitations(ctx.db) });
}

async function revokeInvitationRoute(ctx: RouteContext): Promise<void> {
  await revokeInvitation(ctx.db, ctx.params.id ?? '');
  sendJson(ctx.res, 200, { revoked: true });
}

async function redeemInvitationRoute(ctx: RouteContext): Promise<void> {
  const redeemed = await redeemInvitation(ctx.db, redeemInputFromBody(ctx.body));
  ctx.auditActor = { type: 'anonymous', id: null };
  ctx.auditEntityId = redeemed.userId;
  sendJson(ctx.res, 201, { user: redeemed });
}

// ---------------------------------------------------------------- roles

async function listRolesRoute(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { roles: await listRoles(ctx.db) });
}

async function listPermissionsRoute(ctx: RouteContext): Promise<void> {
  const rows = await ctx.db.selectFrom('permissions').selectAll().orderBy('key', 'asc').execute();
  sendJson(ctx.res, 200, { permissions: rows });
}

async function createRoleRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { required: true, maxLength: 50 });
  const description = getStringField(body, 'description', { maxLength: 500 });
  const permissionKeys = getStringArrayField(body, 'permissionKeys');
  const role = await createRole(ctx.db, {
    name: name ?? '',
    ...(description !== undefined ? { description } : {}),
    ...(permissionKeys !== undefined ? { permissionKeys } : {}),
  });
  ctx.auditEntityId = role.id;
  sendJson(ctx.res, 201, { role });
}

async function deleteRoleRoute(ctx: RouteContext): Promise<void> {
  await deleteRole(ctx.db, ctx.params.id ?? '');
  sendJson(ctx.res, 200, { deleted: true });
}

// ---------------------------------------------------------------- audit log

const MAX_LIMIT = 200;

async function getAuditLogRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const limitRaw = ctx.query.get('limit');
  const offsetRaw = ctx.query.get('offset');
  const limit = limitRaw === null ? 50 : Number.parseInt(limitRaw, 10);
  const offset = offsetRaw === null ? 0 : Number.parseInt(offsetRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`Query parameter "limit" must be an integer 1-${String(MAX_LIMIT)}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError('Query parameter "offset" must be a non-negative integer');
  }
  const action = ctx.query.get('action') ?? undefined;
  const entityType = ctx.query.get('entityType') ?? undefined;
  const entityId = ctx.query.get('entityId') ?? undefined;
  const since = ctx.query.get('since') ?? undefined;
  // Non-admins may only ever see their own actions, regardless of filters.
  const actorId =
    identity.legacy || identity.isAdmin ? (ctx.query.get('actorId') ?? undefined) : (identity.userId ?? undefined);
  const page = await queryAuditLog(ctx.db, {
    ...(actorId !== undefined ? { actorId } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(entityType !== undefined ? { entityType } : {}),
    ...(entityId !== undefined ? { entityId } : {}),
    ...(since !== undefined ? { since } : {}),
    limit,
    offset,
  });
  sendJson(ctx.res, 200, page);
}

// ---------------------------------------------------------------- tokens (extended)

async function revokeAnyTokenRoute(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const id = ctx.params.id ?? '';
  if (!identity.legacy && !hasPermission(identity, 'tokens:manage')) {
    // Regular users may only revoke their own tokens.
    const row = await ctx.db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) {
      throw new TokenNotFoundError(id);
    }
    if (row.user_id !== identity.userId) {
      throw new ValidationError("You can only revoke your own tokens");
    }
  }
  sendJson(ctx.res, 200, { token: await revokeApiToken(ctx.db, id) });
}

export function buildTeamRoutes(): Route[] {
  return [
    defineRoute('POST', '/v1/auth/login', login, {
      auth: false,
      audit: { action: 'auth.login', entity: 'token' },
    }),
    defineRoute('POST', '/v1/auth/password', changePassword, {
      audit: { action: 'auth.password.change', entity: 'user' },
    }),
    defineRoute('GET', '/v1/auth/me', me),
    defineRoute('POST', '/v1/users', createUserRoute, {
      permission: 'users:manage',
      audit: { action: 'user.create', entity: 'user' },
    }),
    defineRoute('GET', '/v1/users', listUsersRoute, { permission: 'users:manage' }),
    defineRoute('GET', '/v1/users/:id', getUserRoute, { permission: 'users:manage' }),
    defineRoute('PATCH', '/v1/users/:id', patchUserRoute, {
      permission: 'users:manage',
      audit: { action: 'user.update', entity: 'user' },
    }),
    defineRoute('DELETE', '/v1/users/:id', deleteUserRoute, {
      permission: 'users:manage',
      audit: { action: 'user.delete', entity: 'user' },
    }),
    defineRoute('POST', '/v1/users/:id/roles', addRoleRoute, {
      permission: 'users:manage',
      audit: { action: 'user.role.grant', entity: 'user' },
    }),
    defineRoute('DELETE', '/v1/users/:id/roles/:roleId', removeRoleRoute, {
      permission: 'users:manage',
      audit: { action: 'user.role.revoke', entity: 'user' },
    }),
    defineRoute('POST', '/v1/users/:id/clients', grantClientRoute, {
      permission: 'users:manage',
      audit: { action: 'user.scope.grant', entity: 'user' },
    }),
    defineRoute('DELETE', '/v1/users/:id/clients/:clientId', revokeClientRoute, {
      permission: 'users:manage',
      audit: { action: 'user.scope.revoke', entity: 'user' },
    }),
    defineRoute('POST', '/v1/users/:id/profiles', grantProfileRoute, {
      permission: 'users:manage',
      audit: { action: 'user.scope.grant', entity: 'user' },
    }),
    defineRoute('DELETE', '/v1/users/:id/profiles/:profileId', revokeProfileRoute, {
      permission: 'users:manage',
      audit: { action: 'user.scope.revoke', entity: 'user' },
    }),
    defineRoute('GET', '/v1/users/:id/scopes', getScopesRoute, { permission: 'users:manage' }),
    defineRoute('GET', '/v1/users/:id/tokens', getUserTokensRoute),
    defineRoute('POST', '/v1/invitations', createInvitationRoute, {
      permission: 'users:manage',
      audit: { action: 'invitation.create', entity: 'invitation' },
    }),
    defineRoute('GET', '/v1/invitations', listInvitationsRoute, { permission: 'users:manage' }),
    defineRoute('POST', '/v1/invitations/:id/revoke', revokeInvitationRoute, {
      permission: 'users:manage',
      audit: { action: 'invitation.revoke', entity: 'invitation' },
    }),
    defineRoute('POST', '/v1/invitations/redeem', redeemInvitationRoute, {
      auth: false,
      audit: { action: 'invitation.redeem', entity: 'user' },
    }),
    defineRoute('GET', '/v1/roles', listRolesRoute),
    defineRoute('GET', '/v1/permissions', listPermissionsRoute),
    defineRoute('POST', '/v1/roles', createRoleRoute, {
      permission: 'roles:manage',
      audit: { action: 'role.create', entity: 'role' },
    }),
    defineRoute('DELETE', '/v1/roles/:id', deleteRoleRoute, {
      permission: 'roles:manage',
      audit: { action: 'role.delete', entity: 'role' },
    }),
    defineRoute('GET', '/v1/audit-log', getAuditLogRoute, { permission: 'audit:read' }),
    // Token revocation with ownership rules lives here; creation/listing
    // stay in routes.ts next to the other token endpoints.
    defineRoute('POST', '/v1/tokens/:id/revoke', revokeAnyTokenRoute, {
      audit: { action: 'token.revoke', entity: 'token' },
    }),
  ];
}
