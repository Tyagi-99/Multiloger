/**
 * /v1/cloud-sync routes (Phase 4b): encrypted S3-compatible backup sync.
 *
 * - PUT/GET /v1/cloud-sync/config — endpoint/bucket/region + vault secret
 *   NAMES (never credential values). Requires `backups:sync`.
 * - POST /v1/cloud-sync/sync — upload missing/changed local backups.
 *   Requires `backups:sync`.
 * - GET /v1/cloud-sync/objects — list remote objects. Requires
 *   `backups:read`.
 * - POST /v1/cloud-sync/restore — download, hash-verify, and restore a
 *   remote backup into a new profile. Requires `backups:sync`.
 * - POST /v1/cloud-sync/prune — delete remote objects past retention.
 *   Requires `backups:sync`.
 */

import { assertClientAccess, requireIdentity } from './access.js';
import {
  defineRoute,
  getStringField,
  requireObjectBody,
  sendJson,
  ValidationError,
  type Route,
  type RouteContext,
} from './router.js';
import type { CloudSyncService } from '../cloudsync/service.js';
import { CloudSyncNotConfiguredError } from '../cloudsync/service.js';

function serviceOf(ctx: RouteContext): CloudSyncService {
  const service = ctx.cloudSync;
  if (!service) {
    throw new Error('Cloud sync service is not wired into the route context');
  }
  return service;
}

/** Required string field (getStringField types required as possibly-undefined). */
function reqString(body: Record<string, unknown>, field: string): string {
  const value = getStringField(body, field, { required: true });
  if (value === undefined) {
    throw new ValidationError(`Missing required field: ${field}`);
  }
  return value;
}

async function getConfig(ctx: RouteContext): Promise<void> {
  const config = await serviceOf(ctx).getConfig();
  if (!config) {
    throw new CloudSyncNotConfiguredError();
  }
  sendJson(ctx.res, 200, { config });
}

async function putConfig(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const endpoint = reqString(body, 'endpoint');
  const bucket = reqString(body, 'bucket');
  const region = getStringField(body, 'region', { required: false }) ?? 'us-east-1';
  const prefix = getStringField(body, 'prefix', { required: false });
  const accessKeySecretName = reqString(body, 'accessKeySecretName');
  const secretKeySecretName = reqString(body, 'secretKeySecretName');
  const retentionDays = body.retentionDays === undefined ? undefined : Number(body.retentionDays);
  const allowInsecureHttp = body.allowInsecureHttp === true;
  if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 1)) {
    throw new ValidationError('Field must be an integer >= 1: retentionDays');
  }
  const config = await serviceOf(ctx).saveConfig({
    endpoint,
    bucket,
    region,
    ...(prefix !== undefined ? { prefix } : {}),
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    accessKeySecretName,
    secretKeySecretName,
    allowInsecureHttp,
  });
  ctx.auditEntityId = 'default';
  sendJson(ctx.res, 200, { config });
}

async function syncNow(ctx: RouteContext): Promise<void> {
  const result = await serviceOf(ctx).syncNow();
  ctx.auditEntityId = 'default';
  sendJson(ctx.res, 200, result);
}

async function listObjects(ctx: RouteContext): Promise<void> {
  const objects = await serviceOf(ctx).listRemote();
  sendJson(ctx.res, 200, { objects });
}

async function restoreObject(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const key = reqString(body, 'key');
  const name = reqString(body, 'name');
  if (name.trim().length === 0 || name.length > 200) {
    throw new ValidationError('Field must be 1-200 characters: name');
  }
  const clientId = getStringField(body, 'clientId', { required: false });
  if (clientId !== undefined) {
    await assertClientAccess(ctx.db, requireIdentity(ctx), clientId);
  }
  const restored = await serviceOf(ctx).restoreRemote(key, {
    name,
    ...(clientId !== undefined ? { clientId } : {}),
  });
  ctx.auditEntityId = restored.profileId;
  sendJson(ctx.res, 201, restored);
}

async function pruneObjects(ctx: RouteContext): Promise<void> {
  const result = await serviceOf(ctx).pruneRemote();
  ctx.auditEntityId = 'default';
  sendJson(ctx.res, 200, result);
}

export function buildCloudSyncRoutes(): Route[] {
  return [
    defineRoute('GET', '/v1/cloud-sync/config', getConfig, { permission: 'backups:sync' }),
    defineRoute('PUT', '/v1/cloud-sync/config', putConfig, {
      permission: 'backups:sync',
      audit: { action: 'cloud-sync.configure', entity: 'cloud-sync' },
    }),
    defineRoute('POST', '/v1/cloud-sync/sync', syncNow, {
      permission: 'backups:sync',
      audit: { action: 'cloud-sync.sync', entity: 'cloud-sync' },
    }),
    defineRoute('GET', '/v1/cloud-sync/objects', listObjects, {
      permission: 'backups:read',
    }),
    defineRoute('POST', '/v1/cloud-sync/restore', restoreObject, {
      permission: 'backups:sync',
      audit: { action: 'cloud-sync.restore', entity: 'profile' },
    }),
    defineRoute('POST', '/v1/cloud-sync/prune', pruneObjects, {
      permission: 'backups:sync',
      audit: { action: 'cloud-sync.prune', entity: 'cloud-sync' },
    }),
  ];
}
