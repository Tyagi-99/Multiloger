import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureWebrtcPolicy } from './leak-guards.js';

describe('WebRTC leak guards', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  function readPolicy(): unknown {
    const raw = readFileSync(join(dir, 'Default', 'Preferences'), 'utf8');
    return (JSON.parse(raw) as { webrtc: { ip_handling_policy: string } }).webrtc
      .ip_handling_policy;
  }

  it('writes the policy for a brand-new profile dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-webrtc-'));
    ensureWebrtcPolicy(dir, 'disable_non_proxied_udp');
    expect(readPolicy()).toBe('disable_non_proxied_udp');
  });

  it('updates the policy in place on later launches, preserving other keys', () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-webrtc-'));
    ensureWebrtcPolicy(dir, 'disable_non_proxied_udp');

    // Simulate a user/profile-owned preference Chromium wrote later.
    const prefsPath = join(dir, 'Default', 'Preferences');
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    prefs.my_custom_key = { nested: [1, 2, 3] };
    writeFileSync(prefsPath, JSON.stringify(prefs));

    // Proxy removed → policy relaxes on next launch, custom keys survive.
    ensureWebrtcPolicy(dir, 'default_public_interface_only');
    expect(readPolicy()).toBe('default_public_interface_only');
    const after = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    expect(after.my_custom_key).toEqual({ nested: [1, 2, 3] });
  });

  it('quarantines a corrupt Preferences file instead of wiping it silently', () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-webrtc-'));
    const defaultDir = join(dir, 'Default');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'Preferences'), '{not valid json');

    ensureWebrtcPolicy(dir, 'disable_non_proxied_udp');
    expect(readPolicy()).toBe('disable_non_proxied_udp');
    // The corrupt original was preserved for forensics, not deleted.
    expect(readFileSync(join(defaultDir, 'Preferences'), 'utf8')).not.toContain('not valid json');
  });
});
