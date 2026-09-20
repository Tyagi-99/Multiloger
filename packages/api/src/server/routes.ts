/**
 * /v1 route handlers. Every handler receives an authenticated context
 * (except /health) and answers with structured JSON via `sendJson`.
 *
 * Conventions:
 * - 200 for reads and actions, 201 for creates.
 * - Domain errors are mapped by toHttpError (see server/errors.ts).
 * - No request bodies are ever logged (see server/index.ts); proxy
 *   credential references only appear in responses as opaque `env:*` refs,
 *   never plaintext.
 */

import { getLockInfo } from '../profiles/lock.js';
import {
  createClient,
  createProfileIn,
  getClient,
  getProfile,
  listClients,
  listProfiles,
  updateProfile,
} from '../profiles/repository.js';
import {
  assignProxyToProfile,
  checkProxyHealth,
  createProxy,
  deleteProxy,
  getAssignedProxy,
  getProxy,
  listProxies,
  toPublicProxy,
  unassignProxyFromProfile,
  updateProxy,
  type CreateProxyInput,
  type UpdateProxyInput,
} from '../proxies/index.js';
import { resolveProxyForLaunch } from '../proxies/service.js';
import { createApiToken, listApiTokens } from './tokens.js';
import { buildAutomationRoutes } from './automation-routes.js';
import { buildTeamRoutes } from './team-routes.js';
import { buildMonitoringRoutes } from './monitoring-routes.js';
import { buildCloudSyncRoutes } from './cloudsync-routes.js';
import { buildWindowSyncRoutes } from './windowsync-routes.js';
import {
  accessibleClientIds,
  accessibleProfileIds,
  assertClientAccess,
  assertProfileAccess,
  ForbiddenError,
  hasPermission,
  requireIdentity,
} from './access.js';
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

const VERSION = '0.1.0';

function resourceStatus(ctx: RouteContext): Promise<void> {
  const resources = ctx.resources ?? ctx.manager.resourceManager;
  if (!resources) {
    sendJson(ctx.res, 200, { enabled: false });
  } else {
    sendJson(ctx.res, 200, { enabled: true, ...resources.status });
  }
  return Promise.resolve();
}

function health(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { ok: true, version: VERSION });
  return Promise.resolve();
}

// ---------------------------------------------------------------- tokens

/**
 * Issue a token.
 * - Legacy tokens (no user): keep full power — may attribute to any user
 *   (or stay unattributed, preserving the exact pre-Phase-3 behavior).
 * - Holders of tokens:manage: may issue for any user; defaults to self.
 * - Everyone else: may only issue for themselves, with scopes limited to
 *   permissions they already hold.
 */
async function createToken(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { required: true, maxLength: 100 });
  const requestedUserId = getStringField(body, 'userId', { maxLength: 100 });
  const scopes = getStringArrayField(body, 'scopes');
  let userId: string | undefined;
  let effectiveScopes: string[] | undefined;
  if (identity.legacy) {
    userId = requestedUserId;
    effectiveScopes = scopes;
  } else if (hasPermission(identity, 'tokens:manage')) {
    userId = requestedUserId ?? identity.userId ?? undefined;
    effectiveScopes = scopes;
  } else {
    if (requestedUserId !== undefined && requestedUserId !== identity.userId) {
      throw new ForbiddenError('You can only create tokens for yourself');
    }
    userId = identity.userId ?? undefined;
    if (scopes !== undefined) {
      for (const scope of scopes) {
        if (!identity.permissions.has(scope)) {
          throw new ForbiddenError(`Cannot grant a scope you do not hold: ${scope}`);
        }
      }
    }
    effectiveScopes = scopes;
  }
  const created = await createApiToken(ctx.db, name ?? '', {
    ...(userId !== undefined ? { userId } : {}),
    ...(effectiveScopes !== undefined ? { scopes: effectiveScopes } : {}),
    ...(ctx.token ? { createdBy: ctx.token.id } : {}),
  });
  ctx.auditEntityId = created.id;
  // The plaintext token is returned HERE and only here.
  sendJson(ctx.res, 201, {
    id: created.id,
    name: created.name,
    token: created.token,
    createdAt: created.createdAt,
  });
}

async function listTokens(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  if (identity.legacy || hasPermission(identity, 'tokens:read')) {
    sendJson(ctx.res, 200, { tokens: await listApiTokens(ctx.db) });
  } else {
    // Without tokens:read you only ever see your own tokens.
    const userId = identity.userId;
    sendJson(ctx.res, 200, { tokens: userId ? await listApiTokens(ctx.db, { userId }) : [] });
  }
}

// ---------------------------------------------------------------- clients

async function createClientRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { required: true, maxLength: 200 });
  const notes = getStringField(body, 'notes', { maxLength: 2000 });
  const client = await createClient(ctx.db, {
    name: name ?? '',
    ...(notes !== undefined ? { notes } : {}),
  });
  ctx.auditEntityId = client.id;
  sendJson(ctx.res, 201, { client });
}

async function getClients(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const clients = await listClients(ctx.db);
  const allowed = await accessibleClientIds(ctx.db, identity);
  sendJson(ctx.res, 200, {
    clients: allowed === null ? clients : clients.filter((c) => allowed.has(c.id)),
  });
}

async function getClientById(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertClientAccess(ctx.db, requireIdentity(ctx), id);
  sendJson(ctx.res, 200, { client: await getClient(ctx.db, id) });
}

// ---------------------------------------------------------------- profiles

async function profileDetail(
  ctx: RouteContext,
  profileId: string,
): Promise<Record<string, unknown>> {
  const profile = await getProfile(ctx.db, profileId);
  const lock = await getLockInfo(ctx.db, profileId, ctx.lockTtlMs);
  const assigned = await getAssignedProxy(ctx.db, profileId);
  return {
    id: profile.id,
    clientId: profile.client_id,
    name: profile.name,
    state: profile.state,
    proxyRequired: profile.proxy_required === 1,
    lastPid: profile.last_pid,
    lastCdpPort: profile.last_cdp_port,
    lastLaunchedAt: profile.last_launched_at,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    lock,
    proxy: assigned ? toPublicProxy(assigned) : null,
  };
}

async function createProfileRoute(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const clientId = getStringField(body, 'clientId', { required: true });
  const name = getStringField(body, 'name', { required: true, maxLength: 200 });
  const proxyId = getStringField(body, 'proxyId');
  const proxyRequiredRaw = body.proxyRequired;
  if (proxyRequiredRaw !== undefined && typeof proxyRequiredRaw !== 'boolean') {
    throw new ValidationError('Field must be a boolean: proxyRequired');
  }
  // Fail fast on unknown client / proxy before creating anything.
  await getClient(ctx.db, clientId ?? '');
  await assertClientAccess(ctx.db, requireIdentity(ctx), clientId ?? '');
  if (proxyId) {
    await getProxy(ctx.db, proxyId);
  }
  const profile = await createProfileIn(ctx.db, ctx.dataDir, {
    clientId: clientId ?? '',
    name: name ?? '',
    proxyRequired: proxyRequiredRaw === true,
  });
  if (proxyId) {
    await assignProxyToProfile(ctx.db, profile.id, proxyId);
  }
  ctx.auditEntityId = profile.id;
  sendJson(ctx.res, 201, { profile: await profileDetail(ctx, profile.id) });
}

async function getProfiles(ctx: RouteContext): Promise<void> {
  const identity = requireIdentity(ctx);
  const profiles = await listProfiles(ctx.db);
  const direct = await accessibleProfileIds(ctx.db, identity);
  const clients = await accessibleClientIds(ctx.db, identity);
  const visible =
    direct === null && clients === null
      ? profiles
      : profiles.filter((p) => direct?.has(p.id) === true || clients?.has(p.client_id) === true);
  const detailed = await Promise.all(visible.map((p) => profileDetail(ctx, p.id)));
  sendJson(ctx.res, 200, { profiles: detailed });
}

async function getProfileById(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function patchProfile(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const name = getStringField(body, 'name', { maxLength: 200 });
  const proxyRequiredRaw = body.proxyRequired;
  if (proxyRequiredRaw !== undefined && typeof proxyRequiredRaw !== 'boolean') {
    throw new ValidationError('Field must be a boolean: proxyRequired');
  }
  await updateProfile(ctx.db, id, {
    ...(name !== undefined ? { name } : {}),
    ...(proxyRequiredRaw !== undefined ? { proxyRequired: proxyRequiredRaw } : {}),
  });
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function launch(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const info = await ctx.manager.launchProfile(id);
  sendJson(ctx.res, 200, {
    profile: await profileDetail(ctx, id),
    cdp: { pid: info.pid, port: info.port, cdpUrl: info.cdpUrl },
  });
}

async function stop(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  await ctx.manager.stopProfile(id);
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function restart(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const info = await ctx.manager.restartProfile(id);
  sendJson(ctx.res, 200, {
    profile: await profileDetail(ctx, id),
    cdp: { pid: info.pid, port: info.port, cdpUrl: info.cdpUrl },
  });
}

async function getSessions(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 20 : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ValidationError('Query parameter "limit" must be an integer 1-200');
  }
  const sessions = await ctx.db
    .selectFrom('sessions')
    .selectAll()
    .where('profile_id', '=', id)
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();
  sendJson(ctx.res, 200, { sessions });
}

async function assignProxy(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const proxyId = getStringField(body, 'proxyId', { required: true });
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  await assignProxyToProfile(ctx.db, id, proxyId ?? '');
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function unassignProxy(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  await unassignProxyFromProfile(ctx.db, id);
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

// ---------------------------------------------------------------- proxies

function proxyInput(body: Record<string, unknown>): CreateProxyInput {
  const name = getStringField(body, 'name', { required: true, maxLength: 200 });
  const scheme = getStringField(body, 'scheme', { required: true });
  const host = getStringField(body, 'host', { required: true, maxLength: 253 });
  const portRaw = body.port;
  if (typeof portRaw !== 'number' || !Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new ValidationError('Field must be an integer 1-65535: port');
  }
  const username = getStringField(body, 'username', { maxLength: 200 });
  const passwordSecretRef = getStringField(body, 'passwordSecretRef', { maxLength: 200 });
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') {
    throw new ValidationError('Field must be one of http, https, socks5: scheme');
  }
  return {
    name: name ?? '',
    scheme,
    host: host ?? '',
    port: portRaw,
    ...(username !== undefined ? { username } : {}),
    ...(passwordSecretRef !== undefined ? { passwordSecretRef } : {}),
  };
}

async function createProxyRoute(ctx: RouteContext): Promise<void> {
  const proxy = await createProxy(ctx.db, proxyInput(requireObjectBody(ctx.body)));
  ctx.auditEntityId = proxy.id;
  sendJson(ctx.res, 201, { proxy: toPublicProxy(proxy) });
}

async function getProxies(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { proxies: (await listProxies(ctx.db)).map(toPublicProxy) });
}

async function getProxyById(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { proxy: toPublicProxy(await getProxy(ctx.db, ctx.params.id ?? '')) });
}

async function patchProxy(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const input: UpdateProxyInput = {};
  const name = getStringField(body, 'name', { maxLength: 200 });
  if (name !== undefined) {
    input.name = name;
  }
  const scheme = getStringField(body, 'scheme');
  if (scheme !== undefined) {
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') {
      throw new ValidationError('Field must be one of http, https, socks5: scheme');
    }
    input.scheme = scheme;
  }
  const host = getStringField(body, 'host', { maxLength: 253 });
  if (host !== undefined) {
    input.host = host;
  }
  const portRaw = body.port;
  if (portRaw !== undefined) {
    if (
      typeof portRaw !== 'number' ||
      !Number.isInteger(portRaw) ||
      portRaw < 1 ||
      portRaw > 65535
    ) {
      throw new ValidationError('Field must be an integer 1-65535: port');
    }
    input.port = portRaw;
  }
  const username = getStringField(body, 'username', { maxLength: 200 });
  if (username !== undefined) {
    input.username = username;
  }
  const passwordSecretRef = getStringField(body, 'passwordSecretRef', { maxLength: 200 });
  if (passwordSecretRef !== undefined) {
    input.passwordSecretRef = passwordSecretRef;
  }
  const proxy = await updateProxy(ctx.db, ctx.params.id ?? '', input);
  sendJson(ctx.res, 200, { proxy: toPublicProxy(proxy) });
}

async function deleteProxyRoute(ctx: RouteContext): Promise<void> {
  await deleteProxy(ctx.db, ctx.params.id ?? '');
  sendJson(ctx.res, 200, { deleted: true });
}

async function proxyHealth(ctx: RouteContext): Promise<void> {
  const proxy = await getProxy(ctx.db, ctx.params.id ?? '');
  const health = await checkProxyHealth(proxy.host, proxy.port, 5000);
  sendJson(ctx.res, 200, { proxy: toPublicProxy(proxy), health });
}

async function launchReadiness(ctx: RouteContext): Promise<void> {
  // Dry-run of the Task 6 launch gate WITHOUT launching: reports whether
  // a launch would pass the proxy gate and why not.
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  try {
    const resolved = await resolveProxyForLaunch(ctx.db, id);
    sendJson(ctx.res, 200, {
      ready: true,
      proxy: resolved
        ? { scheme: resolved.scheme, host: resolved.host, port: resolved.port }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendJson(ctx.res, 200, { ready: false, reason: message });
  }
}

async function createBackup(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const backup = await ctx.backups.createBackup(id);
  ctx.auditEntityId = backup.id;
  sendJson(ctx.res, 201, { backup });
}

async function listBackups(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await assertProfileAccess(ctx.db, requireIdentity(ctx), id);
  const backups = await ctx.backups.listBackups(id);
  sendJson(ctx.res, 200, { backups });
}

async function scopedBackup(ctx: RouteContext, backupId: string): Promise<{ profileId: string }> {
  const backup = await ctx.backups.getBackup(backupId);
  await assertProfileAccess(ctx.db, requireIdentity(ctx), backup.profileId);
  return backup;
}

async function getBackup(ctx: RouteContext): Promise<void> {
  const backupId = ctx.params.backupId ?? '';
  sendJson(ctx.res, 200, { backup: await scopedBackup(ctx, backupId) });
}

async function verifyBackup(ctx: RouteContext): Promise<void> {
  const backupId = ctx.params.backupId ?? '';
  await scopedBackup(ctx, backupId);
  sendJson(ctx.res, 200, await ctx.backups.verifyBackup(backupId));
}

async function restoreBackup(ctx: RouteContext): Promise<void> {
  const backupId = ctx.params.backupId ?? '';
  await scopedBackup(ctx, backupId);
  const body = (ctx.body ?? {}) as { name?: unknown; clientId?: unknown };
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw new ValidationError('Field is required: name');
  }
  if (body.clientId !== undefined && typeof body.clientId !== 'string') {
    throw new ValidationError('Field must be a string: clientId');
  }
  if (typeof body.clientId === 'string') {
    await assertClientAccess(ctx.db, requireIdentity(ctx), body.clientId);
  }
  const profile = await ctx.backups.restoreBackup(backupId, {
    name: body.name,
    ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
  });
  ctx.auditEntityId = profile.id;
  sendJson(ctx.res, 201, { profile });
}

async function deleteBackup(ctx: RouteContext): Promise<void> {
  const backupId = ctx.params.backupId ?? '';
  await scopedBackup(ctx, backupId);
  await ctx.backups.deleteBackup(backupId);
  sendJson(ctx.res, 200, { deleted: true });
}

export function buildRoutes(): Route[] {
  return [
    defineRoute('GET', '/health', health, { auth: false }),
    defineRoute('GET', '/v1/resources', resourceStatus, { permission: 'profiles:read' }),
    defineRoute('POST', '/v1/tokens', createToken, {
      audit: { action: 'token.create', entity: 'token' },
    }),
    defineRoute('GET', '/v1/tokens', listTokens),
    defineRoute('GET', '/v1/clients', getClients, { permission: 'clients:read' }),
    defineRoute('POST', '/v1/clients', createClientRoute, {
      permission: 'clients:create',
      audit: { action: 'client.create', entity: 'client' },
    }),
    defineRoute('GET', '/v1/clients/:id', getClientById, { permission: 'clients:read' }),
    defineRoute('GET', '/v1/profiles', getProfiles, { permission: 'profiles:read' }),
    defineRoute('POST', '/v1/profiles', createProfileRoute, {
      permission: 'profiles:create',
      audit: { action: 'profile.create', entity: 'profile' },
    }),
    defineRoute('GET', '/v1/profiles/:id', getProfileById, { permission: 'profiles:read' }),
    defineRoute('PATCH', '/v1/profiles/:id', patchProfile, {
      permission: 'profiles:update',
      audit: { action: 'profile.update', entity: 'profile' },
    }),
    defineRoute('POST', '/v1/profiles/:id/launch', launch, {
      permission: 'profiles:launch',
      audit: { action: 'profile.launch', entity: 'profile' },
    }),
    defineRoute('POST', '/v1/profiles/:id/stop', stop, {
      permission: 'profiles:launch',
      audit: { action: 'profile.stop', entity: 'profile' },
    }),
    defineRoute('POST', '/v1/profiles/:id/restart', restart, {
      permission: 'profiles:launch',
      audit: { action: 'profile.restart', entity: 'profile' },
    }),
    defineRoute('GET', '/v1/profiles/:id/sessions', getSessions, { permission: 'profiles:read' }),
    defineRoute('POST', '/v1/profiles/:id/proxy', assignProxy, {
      permission: 'profiles:update',
      audit: { action: 'profile.proxy.assign', entity: 'profile' },
    }),
    defineRoute('DELETE', '/v1/profiles/:id/proxy', unassignProxy, {
      permission: 'profiles:update',
      audit: { action: 'profile.proxy.unassign', entity: 'profile' },
    }),
    defineRoute('GET', '/v1/profiles/:id/launch-readiness', launchReadiness, {
      permission: 'profiles:read',
    }),
    defineRoute('GET', '/v1/proxies', getProxies, { permission: 'proxies:read' }),
    defineRoute('POST', '/v1/proxies', createProxyRoute, {
      permission: 'proxies:manage',
      audit: { action: 'proxy.create', entity: 'proxy' },
    }),
    defineRoute('GET', '/v1/proxies/:id', getProxyById, { permission: 'proxies:read' }),
    defineRoute('PATCH', '/v1/proxies/:id', patchProxy, {
      permission: 'proxies:manage',
      audit: { action: 'proxy.update', entity: 'proxy' },
    }),
    defineRoute('DELETE', '/v1/proxies/:id', deleteProxyRoute, {
      permission: 'proxies:manage',
      audit: { action: 'proxy.delete', entity: 'proxy' },
    }),
    defineRoute('POST', '/v1/proxies/:id/health', proxyHealth, { permission: 'proxies:health' }),
    defineRoute('POST', '/v1/profiles/:id/backups', createBackup, {
      permission: 'backups:create',
      audit: { action: 'backup.create', entity: 'backup' },
    }),
    defineRoute('GET', '/v1/profiles/:id/backups', listBackups, { permission: 'backups:read' }),
    defineRoute('GET', '/v1/backups/:backupId', getBackup, { permission: 'backups:read' }),
    defineRoute('POST', '/v1/backups/:backupId/verify', verifyBackup, {
      permission: 'backups:read',
    }),
    defineRoute('POST', '/v1/backups/:backupId/restore', restoreBackup, {
      permission: 'backups:restore',
      audit: { action: 'backup.restore', entity: 'profile' },
    }),
    defineRoute('DELETE', '/v1/backups/:backupId', deleteBackup, {
      permission: 'backups:delete',
      audit: { action: 'backup.delete', entity: 'backup' },
    }),
    ...buildAutomationRoutes(),
    ...buildTeamRoutes(),
    ...buildMonitoringRoutes(),
    ...buildCloudSyncRoutes(),
    ...buildWindowSyncRoutes(),
  ];
}
