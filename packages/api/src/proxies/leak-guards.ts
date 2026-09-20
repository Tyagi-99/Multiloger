/**
 * WebRTC leak guards — an HONEST assessment, not a promise.
 *
 * What `disable_non_proxied_udp` does: it tells Chromium's WebRTC stack to
 * only use candidates that go through the configured proxy, which closes
 * the common hole where a STUN request leaks the real public IP around an
 * HTTP/SOCKS proxy.
 *
 * What it does NOT do (documented limitations):
 * - mDNS hostname candidates (.local) can still expose local topology;
 * - TCP/TLS-based candidates have their own paths;
 * - extensions or plugins can bypass the preference;
 * - it is a preference, not a network-level guarantee.
 *
 * Full assurance needs per-proxy-type packet-capture verification — that is
 * deferred and tracked as a pending hardening item, not claimed here.
 *
 * Behavior: `ensureWebrtcPolicy` updates ONLY the webrtc.ip_handling_policy
 * key on every launch (read-modify-write), so changing a profile's proxy
 * assignment takes effect on the next launch even for existing profiles.
 * When no Preferences file exists yet it starts from the launcher defaults.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PREFERENCES, type WebrtcIpHandlingPolicy } from '../browser/preferences.js';

export type { WebrtcIpHandlingPolicy };

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadPrefs(prefsPath: string): { prefs: Record<string, unknown>; corrupt: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(prefsPath, 'utf8'));
  } catch {
    return { prefs: deepClone(DEFAULT_PREFERENCES), corrupt: false };
  }
  if (isObjectRecord(parsed)) {
    return { prefs: parsed, corrupt: false };
  }
  return { prefs: deepClone(DEFAULT_PREFERENCES), corrupt: true };
}

/** Quarantine a corrupt Preferences file for forensics instead of deleting it. */
function quarantine(prefsPath: string): void {
  try {
    renameSync(prefsPath, `${prefsPath}.corrupt-${String(Date.now())}`);
  } catch {
    // Best effort; the write below overwrites anyway.
  }
}

export function ensureWebrtcPolicy(userDataDir: string, policy: WebrtcIpHandlingPolicy): void {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  const { prefs, corrupt } = loadPrefs(prefsPath);
  if (corrupt) {
    quarantine(prefsPath);
  }

  const current = prefs.webrtc;
  const webrtc: Record<string, unknown> = isObjectRecord(current) ? { ...current } : {};
  webrtc.ip_handling_policy = policy;
  prefs.webrtc = webrtc;

  mkdirSync(dirname(prefsPath), { recursive: true });
  writeFileSync(prefsPath, JSON.stringify(prefs));
}
