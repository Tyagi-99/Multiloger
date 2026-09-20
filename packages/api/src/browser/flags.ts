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
  /**
   * Page to open on launch, appended as the final positional arg. Only
   * http(s) URLs are accepted.
   */
  initialUrl?: string;
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
  assertValidProxyEndpoint(proxy.scheme, proxy.host, proxy.port);
}

/**
 * Validate a proxy endpoint before it is stored or used. Shared by the
 * proxy repository (Task 6) and the flag builder so both reject the same
 * malformed input. `socks4` is accepted by Chromium flags but the managed
 * proxy model only offers http/https/socks5.
 */
export function assertValidProxyEndpoint(
  scheme: string,
  host: string,
  port: number,
): void {
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5' && scheme !== 'socks4') {
    throw new InvalidProxyError(`scheme ${JSON.stringify(scheme)} is not supported`);
  }
  if (!HOST_PATTERN.test(host)) {
    throw new InvalidProxyError(`host ${JSON.stringify(host)} is not a valid hostname or IP`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidProxyError(`port ${JSON.stringify(port)} is out of range 1-65535`);
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

  if (options.initialUrl !== undefined) {
    flags.push(validateInitialUrl(options.initialUrl));
  }

  return flags;
}

/** Only http(s) may be opened on launch — no javascript:, file:, data:. */
function validateInitialUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid initialUrl (not a URL): ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid initialUrl (only http/https allowed): ${JSON.stringify(raw)}`);
  }
  return url.toString();
}
