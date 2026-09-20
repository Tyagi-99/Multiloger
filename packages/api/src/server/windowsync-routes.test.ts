/**
 * Window-sync route wiring tests (Phase 4c): POST /v1/window-sync is
 * registered with the profiles:sync permission and audit config.
 */

import { describe, expect, it } from 'vitest';
import { buildRoutes } from './routes.js';
import { matchRoute } from './router.js';

describe('window-sync route registration', () => {
  const routes = buildRoutes();
  const sync = routes.filter((r) => r.template === '/v1/window-sync');

  it('registers exactly one route', () => {
    expect(sync.map((r) => r.method)).toEqual(['POST']);
  });

  it('requires profiles:sync and audits the sync', () => {
    expect(sync[0]?.permission).toBe('profiles:sync');
    expect(sync[0]?.audit?.action).toBe('window-sync.sync');
  });

  it('matches through the router', () => {
    const matched = matchRoute(routes, 'POST', '/v1/window-sync');
    expect(matched?.route.template).toBe('/v1/window-sync');
  });
});
