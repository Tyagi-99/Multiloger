/**
 * Seed the Chromium Preferences file for a brand-new profile directory.
 *
 * Only writes when `<userDataDir>/Default/Preferences` does not exist yet —
 * an existing profile's Preferences are never touched by this function
 * (per-launch policy updates live in the proxy leak guards, Task 6).
 *
 * This is honest configuration of a real browser (matching the
 * architecture report's §5.1 line), not signal spoofing.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WebrtcIpHandlingPolicy =
  | 'default'
  | 'default_public_interface_only'
  | 'default_public_and_private_interfaces'
  | 'disable_non_proxied_udp';

export interface SeedPreferencesOptions {
  webrtcIpHandlingPolicy?: WebrtcIpHandlingPolicy;
}

/**
 * Base preferences for a brand-new profile. Deliberately minimal — every
 * entry here is a real, documented Chromium preference. Extended over time
 * (locale, permissions, …).
 */
export const DEFAULT_PREFERENCES: Record<string, unknown> = {};

/**
 * @returns true when the file was written, false when it already existed.
 */
export function seedPreferences(
  userDataDir: string,
  options: SeedPreferencesOptions = {},
): boolean {
  const defaultDir = join(userDataDir, 'Default');
  const preferencesPath = join(defaultDir, 'Preferences');
  if (existsSync(preferencesPath)) {
    return false;
  }
  mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  const preferences: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  if (options.webrtcIpHandlingPolicy) {
    preferences.webrtc = { ip_handling_policy: options.webrtcIpHandlingPolicy };
  }
  writeFileSync(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
  return true;
}
