/**
 * /v1/window-sync routes (Phase 4c): open one URL in several running
 * profiles and bring each profile's page to the front.
 *
 * Requires `profiles:sync` plus per-profile access (assertProfileAccess:
 * 404 for missing profiles, 403 for out-of-scope ones). The only CDP
 * commands used are Page.navigate + Page.bringToFront — no OS window
 * management.
 */

import { assertProfileAccess, requireIdentity } from './access.js';
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
import { WindowSyncService } from '../windowsync/service.js';

/** Required string field (getStringField types required as possibly-undefined). */
function reqString(body: Record<string, unknown>, field: string): string {
  const value = getStringField(body, field, { required: true });
  if (value === undefined) {
    throw new ValidationError(`Missing required field: ${field}`);
  }
  return value;
}

async function syncWindows(ctx: RouteContext): Promise<void> {
  const body = requireObjectBody(ctx.body);
  const url = reqString(body, 'url');
  const profileIds = getStringArrayField(body, 'profileIds');
  if (!profileIds || profileIds.length === 0) {
    throw new ValidationError('profileIds must be a non-empty array of profile ids');
  }
  if (profileIds.length > 100) {
    throw new ValidationError('profileIds: at most 100 profiles per sync request');
  }

  // Enforce access to EVERY profile before touching any browser.
  const identity = requireIdentity(ctx);
  for (const profileId of profileIds) {
    await assertProfileAccess(ctx.db, identity, profileId);
  }

  const service = new WindowSyncService({
    liveProfiles: () =>
      ctx.manager.listLive().map(({ profileId, cdpUrl }) => ({ profileId, cdpUrl })),
  });
  const result = await service.syncProfiles(profileIds, url);
  ctx.auditEntityId = 'default';
  sendJson(ctx.res, 200, result);
}

export function buildWindowSyncRoutes(): Route[] {
  return [
    defineRoute('POST', '/v1/window-sync', syncWindows, {
      permission: 'profiles:sync',
      audit: { action: 'window-sync.sync', entity: 'profile' },
    }),
  ];
}
