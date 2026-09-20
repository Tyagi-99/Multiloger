import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from './ports.js';
import { createServer } from 'node:net';
import { killBrowserGroup, launchChromium, waitForCdpReady } from './launcher.js';
import { seedPreferences } from './preferences.js';
import { readFileSync } from 'node:fs';

describe('findFreePort', () => {
  it('returns a port that is actually bindable', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
        resolve();
      });
      });
    });
  });
});

describe('seedPreferences', () => {
  it('writes Default/Preferences only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-prefs-'));
    try {
      expect(seedPreferences(dir, { webrtcIpHandlingPolicy: 'disable_non_proxied_udp' })).toBe(true);
      const parsed = JSON.parse(
        readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'),
      ) as {
        webrtc: { ip_handling_policy: string };
      };
      expect(parsed.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');
      // Second call never overwrites.
      expect(seedPreferences(dir, { webrtcIpHandlingPolicy: 'default' })).toBe(false);
      const again = JSON.parse(
        readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'),
      ) as {
        webrtc: { ip_handling_policy: string };
      };
      expect(again.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('waitForCdpReady', () => {
  it('times out with the last error when nothing listens', async () => {
    const port = await findFreePort();
    await expect(waitForCdpReady(`http://127.0.0.1:${String(port)}`, 800)).rejects.toThrow();
  });
});

describe('launchChromium (live)', () => {
  const launched: { pid: number }[] = [];

  afterEach(() => {
    for (const { pid } of launched.splice(0)) {
      killBrowserGroup(pid);
    }
  });

  it('launches headless Chromium with an isolated 0700 dir and reachable CDP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-launch-'));
    try {
      const userDataDir = join(dir, 'profile');
      const browser = await launchChromium({ userDataDir, headless: true });
      launched.push({ pid: browser.pid });

      expect(browser.pid).toBeGreaterThan(0);
      expect(browser.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(browser.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);

      // The browser process is alive.
      process.kill(browser.pid, 0);

      // The user-data dir is locked down.
      const mode = statSync(userDataDir).mode & 0o777;
      expect(mode).toBe(0o700);

      // CDP answers.
      const version = await waitForCdpReady(browser.cdpUrl, 5000);
      expect(version.webSocketDebuggerUrl).toBe(browser.wsUrl);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives each launch its own CDP port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multiloger-launch-'));
    try {
      const a = await launchChromium({ userDataDir: join(dir, 'a'), headless: true });
      launched.push({ pid: a.pid });
      const b = await launchChromium({ userDataDir: join(dir, 'b'), headless: true });
      launched.push({ pid: b.pid });
      expect(a.port).not.toBe(b.port);
      expect(a.pid).not.toBe(b.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
