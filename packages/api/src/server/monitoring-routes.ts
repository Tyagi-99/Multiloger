/**
 * /v1/monitoring routes (Phase 4a).
 *
 * Read-only operational telemetry: a cached metrics snapshot plus the
 * currently active alerts. Gated by the `monitoring:read` permission.
 * Alert transitions are also pushed over the WebSocket event stream.
 */

import { defineRoute, sendJson, type Route, type RouteContext } from './router.js';
import type { MonitoringService } from '../monitoring/service.js';

function serviceOf(ctx: RouteContext): MonitoringService {
  const service = ctx.monitoring;
  if (!service) {
    throw new Error('Monitoring service is not wired into the route context');
  }
  return service;
}

async function monitoringSummary(ctx: RouteContext): Promise<void> {
  const summary = await serviceOf(ctx).getSummary();
  sendJson(ctx.res, 200, summary);
}

async function monitoringAlerts(ctx: RouteContext): Promise<void> {
  const summary = await serviceOf(ctx).getSummary();
  sendJson(ctx.res, 200, { alerts: summary.alerts, at: summary.metrics.at });
}

export function buildMonitoringRoutes(): Route[] {
  return [
    defineRoute('GET', '/v1/monitoring/summary', monitoringSummary, {
      permission: 'monitoring:read',
    }),
    defineRoute('GET', '/v1/monitoring/alerts', monitoringAlerts, {
      permission: 'monitoring:read',
    }),
  ];
}
