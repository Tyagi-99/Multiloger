/**
 * Seed the Chromium Preferences file for a brand-new profile directory.
 *
 * Only writes when `<userDataDir>/Default/Preferences` does not exist yet —
 * an existing profile's Preferences are never touched. Currently used for
 * the WebRTC IP-handling policy (Task 6 decides the value per profile);
 * other pinned settings (locale, permissions) will extend this module.
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

  const preferences: Record<string, unknown> = {};
  if (options.webrtcIpHandlingPolicy) {
    preferences.webrtc = { ip_handling_policy: options.webrtcIpHandlingPolicy };
  }
  writeFileSync(preferencesPath, JSON.stringify(preferences), { mode: 0o600 });
  return true;
}
