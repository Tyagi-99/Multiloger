/**
 * Deterministic Chromium flag assembly.
 *
 * ALL browser flags for managed profiles are built here and only here.
 * The order is fixed so launches are reproducible and diffable. No caller
 * may append raw user input: proxy hosts are validated to block flag
 * injection (a hostile hostname like "x --foo" must never reach argv).
 */

import { runningAsRoot } from './chromium.js';

export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyFlagOptions {
  scheme: ProxyScheme;
  host: string;
  port: number;
  /** Comma-separated bypass list; defaults to localhost bypasses. */
  bypass?: string;
}

export interface FlagOptions {
  userDataDir: string;
  cdpPort: number;
  /** true → --headless=new. Headed mode is supported but tests run headless. */
  headless: boolean;
  proxy?: ProxyFlagOptions;
  windowSize?: { width: number; height: number };
  /** Escape hatch, appended last. Prefer extending FlagOptions instead. */
  extraArgs?: string[];
}

export class InvalidProxyError extends Error {
  constructor(message: string) {
    super(`Invalid proxy configuration: ${message}`);
    this.name = 'InvalidProxyError';
  }
}

/** Hostnames/IPs only — no URLs, no whitespace, no shell metacharacters. */
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function validateProxy(proxy: ProxyFlagOptions): void {
  if (!HOST_PATTERN.test(proxy.host)) {
    throw new InvalidProxyError(`host ${JSON.stringify(proxy.host)} is not a valid hostname or IP`);
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new InvalidProxyError(`port ${JSON.stringify(proxy.port)} is out of range 1-65535`);
  }
}

const DEFAULT_PROXY_BYPASS = 'localhost,127.0.0.1,::1';

/** Build the full argv (without the binary) for a managed profile launch. */
export function buildFlags(options: FlagOptions): string[] {
  if (options.proxy) {
    validateProxy(options.proxy);
  }

  const flags: string[] = [
    `--user-data-dir=${options.userDataDir}`,
    `--remote-debugging-port=${String(options.cdpPort)}`,
    '--remote-debugging-address=127.0.0.1',
  ];

  if (options.headless) {
    flags.push('--headless=new');
  }

  // Chromium's sandbox cannot run as uid 0 (its own policy, crbug.com/638180).
  // Only containers/CI run as root; normal desktops never take this branch.
  if (runningAsRoot()) {
    flags.push('--no-sandbox');
  }

  flags.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    // Keep automation stable across launches: no background updates, no
    // component surprises mid-session.
    '--disable-background-networking',
    '--disable-sync',
  );

  if (options.proxy) {
    flags.push(`--proxy-server=${options.proxy.scheme}://${options.proxy.host}:${String(options.proxy.port)}`);
    flags.push(`--proxy-bypass-list=${options.proxy.bypass ?? DEFAULT_PROXY_BYPASS}`);
  }

  if (options.windowSize) {
    flags.push(`--window-size=${String(options.windowSize.width)},${String(options.windowSize.height)}`);
  }

  if (options.extraArgs) {
    flags.push(...options.extraArgs);
  }

  return flags;
}
