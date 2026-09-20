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
import { createApiToken, listApiTokens, revokeApiToken } from './tokens.js';
import {
  defineRoute,
  getStringField,
  requireObjectBody,
  sendJson,
  ValidationError,
  type Route,
  type RouteContext,
} from './router.js';

const VERSION = '0.1.0';

function health(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { ok: true, version: VERSION });
  return Promise.resolve();
}

// ---------------------------------------------------------------- tokens

async function createToken(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const name = getStringField(body, 'name', { required: true, maxLength: 100 });
  const created = await createApiToken(ctx.db, name ?? '');
  // The plaintext token is returned HERE and only here.
  sendJson(ctx.res, 201, {
    id: created.id,
    name: created.name,
    token: created.token,
    createdAt: created.createdAt,
  });
}

async function listTokens(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { tokens: await listApiTokens(ctx.db) });
}

async function revokeToken(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { token: await revokeApiToken(ctx.db, ctx.params.id ?? '') });
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
  sendJson(ctx.res, 201, { client });
}

async function getClients(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { clients: await listClients(ctx.db) });
}

async function getClientById(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { client: await getClient(ctx.db, ctx.params.id ?? '') });
}

// ---------------------------------------------------------------- profiles

async function profileDetail(ctx: RouteContext, profileId: string): Promise<Record<string, unknown>> {
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
  sendJson(ctx.res, 201, { profile: await profileDetail(ctx, profile.id) });
}

async function getProfiles(ctx: RouteContext): Promise<void> {
  const profiles = await listProfiles(ctx.db);
  const detailed = await Promise.all(profiles.map((p) => profileDetail(ctx, p.id)));
  sendJson(ctx.res, 200, { profiles: detailed });
}

async function getProfileById(ctx: RouteContext): Promise<void> {
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, ctx.params.id ?? '') });
}

async function patchProfile(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const id = ctx.params.id ?? '';
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
  const info = await ctx.manager.launchProfile(id);
  sendJson(ctx.res, 200, {
    profile: await profileDetail(ctx, id),
    cdp: { pid: info.pid, port: info.port, cdpUrl: info.cdpUrl },
  });
}

async function stop(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await ctx.manager.stopProfile(id);
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function restart(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  const info = await ctx.manager.restartProfile(id);
  sendJson(ctx.res, 200, {
    profile: await profileDetail(ctx, id),
    cdp: { pid: info.pid, port: info.port, cdpUrl: info.cdpUrl },
  });
}

async function getSessions(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
  await getProfile(ctx.db, id); // 404 when unknown
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
  await assignProxyToProfile(ctx.db, id, proxyId ?? '');
  sendJson(ctx.res, 200, { profile: await profileDetail(ctx, id) });
}

async function unassignProxy(ctx: RouteContext): Promise<void> {
  const id = ctx.params.id ?? '';
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
    if (typeof portRaw !== 'number' || !Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
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
  await getProfile(ctx.db, id);
  try {
    const resolved = await resolveProxyForLaunch(ctx.db, id);
    sendJson(ctx.res, 200, {
      ready: true,
      proxy: resolved ? { scheme: resolved.scheme, host: resolved.host, port: resolved.port } : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendJson(ctx.res, 200, { ready: false, reason: message });
  }
}

export function buildRoutes(): Route[] {
  return [
    defineRoute('GET', '/health', health, false),
    defineRoute('POST', '/v1/tokens', createToken),
    defineRoute('GET', '/v1/tokens', listTokens),
    defineRoute('POST', '/v1/tokens/:id/revoke', revokeToken),
    defineRoute('GET', '/v1/clients', getClients),
    defineRoute('POST', '/v1/clients', createClientRoute),
    defineRoute('GET', '/v1/clients/:id', getClientById),
    defineRoute('GET', '/v1/profiles', getProfiles),
    defineRoute('POST', '/v1/profiles', createProfileRoute),
    defineRoute('GET', '/v1/profiles/:id', getProfileById),
    defineRoute('PATCH', '/v1/profiles/:id', patchProfile),
    defineRoute('POST', '/v1/profiles/:id/launch', launch),
    defineRoute('POST', '/v1/profiles/:id/stop', stop),
    defineRoute('POST', '/v1/profiles/:id/restart', restart),
    defineRoute('GET', '/v1/profiles/:id/sessions', getSessions),
    defineRoute('POST', '/v1/profiles/:id/proxy', assignProxy),
    defineRoute('DELETE', '/v1/profiles/:id/proxy', unassignProxy),
    defineRoute('GET', '/v1/profiles/:id/launch-readiness', launchReadiness),
    defineRoute('GET', '/v1/proxies', getProxies),
    defineRoute('POST', '/v1/proxies', createProxyRoute),
    defineRoute('GET', '/v1/proxies/:id', getProxyById),
    defineRoute('PATCH', '/v1/proxies/:id', patchProxy),
    defineRoute('DELETE', '/v1/proxies/:id', deleteProxyRoute),
    defineRoute('POST', '/v1/proxies/:id/health', proxyHealth),
  ];
}
