/**
 * Window sync (Phase 4c): open one URL in several RUNNING profiles and
 * bring each profile's page to the front via raw CDP.
 *
 * Legitimate operator tooling only: the API server stays the sole control
 * plane, every profile goes through its managed browser process, and the
 * only CDP commands used are Page.navigate + Page.bringToFront. No OS
 * window-manager control, no focus stealing beyond the browser's own tabs.
 *
 * Safety model:
 * - URL is validated (http/https only) before any profile is touched.
 * - Only live profiles are synced; stopped or unknown profiles land in the
 *   `failed` list instead of throwing.
 * - One profile's CDP failure never aborts the others.
 * - The route layer (windowsync-routes.ts) enforces `profiles:sync` and
 *   per-profile client access; the service itself only sees live profiles.
 */

import { listCdpTargets, sendCdpCommand } from '../browser/cdp.js';

/** The requested sync URL failed validation. Mapped to HTTP 400. */
export class WindowSyncUrlError extends Error {
  constructor(detail: string) {
    super(`Invalid window-sync URL: ${detail}`);
  }
}

/** Minimal CDP surface the service needs (injectable for tests). */
export interface WindowSyncCdp {
  listTargets(cdpHttpUrl: string): Promise<{ type: string; webSocketDebuggerUrl: string | null }[]>;
  sendCommand(wsUrl: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** A live profile the manager reports. */
export interface WindowSyncLiveProfile {
  profileId: string;
  cdpUrl: string;
}

export interface WindowSyncResult {
  synced: string[];
  failed: { profileId: string; error: string }[];
}

export interface WindowSyncServiceOptions {
  cdp?: WindowSyncCdp;
  /** Returns the manager's currently live profiles. */
  liveProfiles: () => WindowSyncLiveProfile[];
  /** Per-command CDP timeout. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function defaultCdp(timeoutMs: number): WindowSyncCdp {
  return {
    listTargets: (cdpHttpUrl) => listCdpTargets(cdpHttpUrl, timeoutMs),
    sendCommand: (wsUrl, method, params) => sendCdpCommand(wsUrl, method, params, timeoutMs),
  };
}

export class WindowSyncService {
  private readonly cdp: WindowSyncCdp;
  private readonly liveProfiles: () => WindowSyncLiveProfile[];

  constructor(options: WindowSyncServiceOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cdp = options.cdp ?? defaultCdp(timeoutMs);
    this.liveProfiles = options.liveProfiles;
  }

  /** Validate the sync URL once, before any profile is touched. */
  static validateUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new WindowSyncUrlError('URL is required');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new WindowSyncUrlError('not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WindowSyncUrlError('only http:// and https:// URLs are allowed');
    }
    return parsed.toString();
  }

  /**
   * Navigate every live profile to `url` and bring its page to front.
   * Returns per-profile outcomes; never throws for an individual profile.
   */
  async syncProfiles(profileIds: string[], url: string): Promise<WindowSyncResult> {
    const target = WindowSyncService.validateUrl(url);
    const uniqueIds = [...new Set(profileIds)];
    const live = new Map(this.liveProfiles().map((p) => [p.profileId, p]));

    const results = await Promise.all(
      uniqueIds.map(async (profileId): Promise<{ synced: boolean; error?: string }> => {
        const profile = live.get(profileId);
        if (!profile) {
          return { synced: false, error: 'profile is not running' };
        }
        try {
          const targets = await this.cdp.listTargets(profile.cdpUrl);
          const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (!page?.webSocketDebuggerUrl) {
            return { synced: false, error: 'no open page target in this profile' };
          }
          const wsUrl = page.webSocketDebuggerUrl;
          await this.cdp.sendCommand(wsUrl, 'Page.navigate', { url: target });
          await this.cdp.sendCommand(wsUrl, 'Page.bringToFront', {});
          return { synced: true };
        } catch (error) {
          return {
            synced: false,
            error: error instanceof Error ? error.message : 'CDP command failed',
          };
        }
      }),
    );

    const synced: string[] = [];
    const failed: { profileId: string; error: string }[] = [];
    uniqueIds.forEach((profileId, index) => {
      const outcome = results[index];
      if (outcome?.synced === true) {
        synced.push(profileId);
      } else {
        failed.push({ profileId, error: outcome?.error ?? 'unknown error' });
      }
    });
    return { synced, failed };
  }
}
