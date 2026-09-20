/**
 * BrowserLauncher — the ONLY module that spawns Chromium.
 *
 * `launchChromium` resolves the binary, ensures the user-data dir exists
 * with 0700, picks a free CDP port, builds flags, spawns detached (own
 * process group, so kills never orphan renderers), and waits for the CDP
 * endpoint. Any failure kills the process group and throws a typed error
 * carrying the tail of Chromium's stderr for diagnostics.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { get } from 'node:http';
import { resolveChromiumBinary } from './chromium.js';
import { buildFlags, type FlagOptions } from './flags.js';
import { findFreePort } from './ports.js';

export interface LaunchOptions {
  userDataDir: string;
  headless?: boolean;
  proxy?: FlagOptions['proxy'];
  windowSize?: FlagOptions['windowSize'];
  extraArgs?: string[];
  /** Page to open on launch (http/https only). Appended as final arg. */
  initialUrl?: string;
  /** How long to wait for the CDP endpoint. Defaults to 30s. */
  cdpTimeoutMs?: number;
  /** How many times to retry the whole spawn on port conflicts. */
  spawnRetries?: number;
}

export interface LaunchedBrowser {
  process: ChildProcess;
  pid: number;
  port: number;
  /** e.g. http://127.0.0.1:9222 */
  cdpUrl: string;
  /** webSocketDebuggerUrl from /json/version — the CDP entrypoint. */
  wsUrl: string;
}

export class LaunchTimeoutError extends Error {
  readonly port: number;
  readonly stderrTail: string;

  constructor(port: number, stderrTail: string) {
    super(
      `Chromium did not expose CDP on port ${String(port)} in time.` +
        (stderrTail ? `\nChromium stderr tail:\n${stderrTail}` : ''),
    );
    this.name = 'LaunchTimeoutError';
    this.port = port;
    this.stderrTail = stderrTail;
  }
}

export class LaunchFailedError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail: string) {
    super(stderrTail ? `${message}\nChromium stderr tail:\n${stderrTail}` : message);
    this.name = 'LaunchFailedError';
    this.stderrTail = stderrTail;
  }
}

const CDP_POLL_INTERVAL_MS = 250;
const STDERR_TAIL_BYTES = 16 * 1024;

interface CdpVersion {
  webSocketDebuggerUrl?: string;
}

function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`CDP responded with HTTP ${String(response.statusCode)}`));
        response.resume();
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body) as unknown);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('CDP response was not JSON'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP request timed out')));
    request.on('error', reject);
  });
}

/** Poll /json/version until it answers or the timeout elapses. */
export async function waitForCdpReady(cdpUrl: string, timeoutMs: number): Promise<CdpVersion> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return (await fetchJson(`${cdpUrl}/json/version`, 2000)) as CdpVersion;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDP wait timed out');
}

/** Kill the whole process group (browser + renderers + GPU process). */
/** Lightweight CDP health check: true when /json/version answers in time. */
export async function pingCdp(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetchJson(`${cdpUrl}/json/version`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export function killBrowserGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    // Negative PID = process group (spawned detached).
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

function ensureUserDataDir(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on creation; enforce on every launch.
  chmodSync(userDataDir, 0o700);
}

function isPortConflict(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

export async function launchChromium(options: LaunchOptions): Promise<LaunchedBrowser> {
  const binary = resolveChromiumBinary();
  const headless = options.headless ?? true;
  const cdpTimeoutMs = options.cdpTimeoutMs ?? 30_000;
  const spawnRetries = options.spawnRetries ?? 2;
  ensureUserDataDir(options.userDataDir);

  let lastError: unknown;
  for (let attempt = 0; attempt <= spawnRetries; attempt++) {
    try {
      return await attemptLaunch(binary, options, headless, cdpTimeoutMs);
    } catch (error) {
      lastError = error;
      // Only port races are worth retrying; anything else is deterministic.
      if (!isPortConflict(error) && !(error instanceof LaunchTimeoutError)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function attemptLaunch(
  binary: string,
  options: LaunchOptions,
  headless: boolean,
  cdpTimeoutMs: number,
): Promise<LaunchedBrowser> {
  const port = await findFreePort();
  const flagOptions: FlagOptions = {
    userDataDir: options.userDataDir,
    cdpPort: port,
    headless,
  };
  if (options.proxy !== undefined) {
    flagOptions.proxy = options.proxy;
  }
  if (options.windowSize !== undefined) {
    flagOptions.windowSize = options.windowSize;
  }
  if (options.extraArgs !== undefined) {
    flagOptions.extraArgs = options.extraArgs;
  }
  if (options.initialUrl !== undefined) {
    flagOptions.initialUrl = options.initialUrl;
  }
  const flags = buildFlags(flagOptions);

  let stderrTail = '';
  const child = spawn(binary, flags, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  const spawnFailed = new Promise<never>((_, reject) => {
    child.on('error', (error) => {
      reject(new LaunchFailedError(`Failed to spawn Chromium: ${error.message}`, stderrTail));
    });
  });

  try {
    const cdpUrl = `http://127.0.0.1:${String(port)}`;
    const version = await Promise.race([
      waitForCdpReady(cdpUrl, cdpTimeoutMs).catch((_error: unknown) => {
        throw new LaunchTimeoutError(port, stderrTail);
      }),
      spawnFailed,
      // The browser may exit before CDP comes up (bad flags, crash).
      new Promise<never>((_, reject) => {
        child.on('exit', (code, signal) => {
          reject(
            new LaunchFailedError(
              `Chromium exited before CDP was ready (code=${String(code)}, signal=${String(signal)})`,
              stderrTail,
            ),
          );
        });
      }),
    ]);

    if (!child.pid) {
      throw new LaunchFailedError('Chromium spawn produced no PID', stderrTail);
    }
    if (!version.webSocketDebuggerUrl) {
      killBrowserGroup(child.pid);
      throw new LaunchFailedError('CDP /json/version had no webSocketDebuggerUrl', stderrTail);
    }
    // Detach from the child so the server can exit independently if needed.
    child.unref();
    return {
      process: child,
      pid: child.pid,
      port,
      cdpUrl,
      wsUrl: version.webSocketDebuggerUrl,
    };
  } catch (error) {
    if (child.pid) {
      killBrowserGroup(child.pid);
    }
    throw error;
  }
}
