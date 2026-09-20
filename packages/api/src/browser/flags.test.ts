import { describe, expect, it } from 'vitest';
import { buildFlags, InvalidProxyError } from './flags.js';
import { runningAsRoot } from './chromium.js';

describe('buildFlags', () => {
  it('builds the deterministic base flag set', () => {
    const flags = buildFlags({ userDataDir: '/data/p1', cdpPort: 9222, headless: true });
    expect(flags).toEqual([
      '--user-data-dir=/data/p1',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      ...(runningAsRoot() ? ['--no-sandbox'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
    ]);
  });

  it('omits --headless for headed launches', () => {
    const flags = buildFlags({ userDataDir: '/data/p1', cdpPort: 9222, headless: false });
    expect(flags).not.toContain('--headless=new');
    expect(flags).toContain('--user-data-dir=/data/p1');
  });

  it('appends a validated initialUrl as the final positional arg', () => {
    const flags = buildFlags({
      userDataDir: '/data/p1',
      cdpPort: 9222,
      headless: true,
      initialUrl: 'http://127.0.0.1:3000/',
    });
    expect(flags[flags.length - 1]).toBe('http://127.0.0.1:3000/');
  });

  it('rejects non-http(s) initialUrl values', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'not a url', '']) {
      expect(() => buildFlags({ userDataDir: '/data/p1', cdpPort: 9222, headless: true, initialUrl: bad }), bad).toThrow(
        /initialUrl/i,
      );
    }
  });

  it('adds proxy flags for an http proxy', () => {
    const flags = buildFlags({
      userDataDir: '/data/p1',
      cdpPort: 9222,
      headless: true,
      proxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
    });
    expect(flags).toContain('--proxy-server=http://proxy.example.com:8080');
    expect(flags).toContain('--proxy-bypass-list=localhost,127.0.0.1,::1');
  });

  it('adds proxy flags for a socks5 proxy with custom bypass', () => {
    const flags = buildFlags({
      userDataDir: '/data/p1',
      cdpPort: 9222,
      headless: true,
      proxy: { scheme: 'socks5', host: '10.0.0.5', port: 1080, bypass: 'internal.corp' },
    });
    expect(flags).toContain('--proxy-server=socks5://10.0.0.5:1080');
    expect(flags).toContain('--proxy-bypass-list=internal.corp');
  });

  it('adds window size when requested', () => {
    const flags = buildFlags({
      userDataDir: '/data/p1',
      cdpPort: 9222,
      headless: true,
      windowSize: { width: 1366, height: 768 },
    });
    expect(flags).toContain('--window-size=1366,768');
  });

  it('rejects proxy hosts that could inject flags', () => {
    for (const host of ['evil --proxy-server=x', 'a;b', 'ho st', '']) {
      expect(() =>
        buildFlags({
          userDataDir: '/data/p1',
          cdpPort: 9222,
          headless: true,
          proxy: { scheme: 'http', host, port: 8080 },
        }),
      ).toThrow(InvalidProxyError);
    }
  });

  it('rejects out-of-range proxy ports', () => {
    for (const port of [0, 70000, -1]) {
      expect(() =>
        buildFlags({
          userDataDir: '/data/p1',
          cdpPort: 9222,
          headless: true,
          proxy: { scheme: 'http', host: 'proxy.example.com', port },
        }),
      ).toThrow(InvalidProxyError);
    }
  });

  it('is deterministic across calls', () => {
    const options = { userDataDir: '/data/p1', cdpPort: 9222, headless: true as const };
    expect(buildFlags(options)).toEqual(buildFlags(options));
  });
});
