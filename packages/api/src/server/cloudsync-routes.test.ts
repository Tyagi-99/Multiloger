/**
 * Cloud-sync route wiring tests (Phase 4b): every /v1/cloud-sync route is
 * registered with the intended method, permission, and audit config.
 * Handlers themselves are covered end-to-end in cloudsync.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildRoutes } from './routes.js';
import { matchRoute } from './router.js';

describe('cloud-sync route registration', () => {
  const routes = buildRoutes();
  const cloudSync = routes.filter((r) => r.template.startsWith('/v1/cloud-sync/'));

  it('registers all six routes', () => {
    expect(cloudSync.map((r) => `${r.method} ${r.template}`).sort()).toEqual([
      'GET /v1/cloud-sync/config',
      'GET /v1/cloud-sync/objects',
      'POST /v1/cloud-sync/prune',
      'POST /v1/cloud-sync/restore',
      'POST /v1/cloud-sync/sync',
      'PUT /v1/cloud-sync/config',
    ]);
  });

  it('gates mutations behind backups:sync and listing behind backups:read', () => {
    const byKey = new Map(cloudSync.map((r) => [`${r.method} ${r.template}`, r]));
    expect(byKey.get('PUT /v1/cloud-sync/config')?.permission).toBe('backups:sync');
    expect(byKey.get('GET /v1/cloud-sync/config')?.permission).toBe('backups:sync');
    expect(byKey.get('POST /v1/cloud-sync/sync')?.permission).toBe('backups:sync');
    expect(byKey.get('POST /v1/cloud-sync/restore')?.permission).toBe('backups:sync');
    expect(byKey.get('POST /v1/cloud-sync/prune')?.permission).toBe('backups:sync');
    expect(byKey.get('GET /v1/cloud-sync/objects')?.permission).toBe('backups:read');
  });

  it('audits the mutating routes', () => {
    const byKey = new Map(cloudSync.map((r) => [`${r.method} ${r.template}`, r]));
    expect(byKey.get('PUT /v1/cloud-sync/config')?.audit?.action).toBe('cloud-sync.configure');
    expect(byKey.get('POST /v1/cloud-sync/sync')?.audit?.action).toBe('cloud-sync.sync');
    expect(byKey.get('POST /v1/cloud-sync/restore')?.audit?.action).toBe('cloud-sync.restore');
    expect(byKey.get('POST /v1/cloud-sync/prune')?.audit?.action).toBe('cloud-sync.prune');
    expect(byKey.get('GET /v1/cloud-sync/objects')?.audit).toBeUndefined();
  });

  it('matches PUT /v1/cloud-sync/config through the router', () => {
    const matched = matchRoute(routes, 'PUT', '/v1/cloud-sync/config');
    expect(matched?.route.template).toBe('/v1/cloud-sync/config');
  });
});
