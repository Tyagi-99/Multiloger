/**
 * Chromium binary resolution.
 *
 * Order:
 * 1. `CHROMIUM_PATH` env override (validated: must exist and be executable).
 * 2. Binaries on PATH: google-chrome-stable, google-chrome, chromium,
 *    chromium-browser.
 * 3. Well-known install locations (Linux/macOS).
 *
 * Throws ChromiumNotFoundError listing everything that was tried.
 */

import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';

export class ChromiumNotFoundError extends Error {
  readonly tried: string[];

  constructor(tried: string[]) {
    super(
      `No Chromium/Chrome binary found. Set CHROMIUM_PATH to your browser ` +
        `binary, or install Google Chrome. Tried:\n${tried.map((t) => `  - ${t}`).join('\n')}`,
    );
    this.name = 'ChromiumNotFoundError';
    this.tried = tried;
  }
}

const PATH_BINARIES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

const FIXED_LOCATIONS = [
  '/opt/meta-chromium/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichOnPath(name: string): string | undefined {
  try {
    const found = execFileSync('which', [name], { encoding: 'utf8' }).trim().split('\n')[0];
    if (found && isExecutable(found)) {
      return found;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the Chromium binary path, honoring CHROMIUM_PATH first. */
export function resolveChromiumBinary(): string {
  const tried: string[] = [];

  const override = process.env.CHROMIUM_PATH;
  if (override) {
    tried.push(`CHROMIUM_PATH=${override}`);
    if (isExecutable(override)) {
      return override;
    }
    throw new ChromiumNotFoundError([
      ...tried,
      `CHROMIUM_PATH points at a missing or non-executable file: ${override}`,
    ]);
  }

  for (const name of PATH_BINARIES) {
    tried.push(`PATH lookup: ${name}`);
    const found = whichOnPath(name);
    if (found) {
      return found;
    }
  }

  for (const location of FIXED_LOCATIONS) {
    tried.push(location);
    if (isExecutable(location)) {
      return location;
    }
  }

  throw new ChromiumNotFoundError(tried);
}

/** Chromium refuses to run sandboxed as uid 0; add --no-sandbox only then. */
export function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
