/**
 * Disk-space watermark for launches.
 *
 * Node has no statvfs binding, so this shells out to `df -k` and parses the
 * "Available" column. The parser is pure and unit-tested; the check itself
 * is FAIL-OPEN with a loud warning when `df` is unavailable or unparsable —
 * the watermark is a guardrail, not a security boundary, and a broken
 * parser must never brick every launch.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DiskSpace {
  /** Free bytes available to the filesystem. */
  freeBytes: number;
  /** Total bytes on the filesystem. */
  totalBytes: number;
}

export class InsufficientDiskSpaceError extends Error {
  constructor(
    public readonly freeBytes: number,
    public readonly requiredBytes: number,
  ) {
    super(
      `Insufficient disk space: ${String(freeBytes)} bytes free, ` +
        `${String(requiredBytes)} bytes required by the watermark`,
    );
    this.name = 'InsufficientDiskSpaceError';
  }
}

/**
 * Parse `df -k <path>` output. Expects the POSIX-ish layout:
 *
 *   Filesystem  1K-blocks  Used  Available  Use%  Mounted on
 *   overlay     104857600  1234  104734144  1%    /
 */
export function parseDfOutput(output: string): DiskSpace {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  // First line is the header; the data line may wrap on exotic systems —
  // take the last non-header line and read from the right.
  const data = lines[lines.length - 1];
  if (!data || /^filesystem/i.test(data)) {
    throw new Error('df output has no data line');
  }
  const fields = data.split(/\s+/);
  if (fields.length < 6) {
    throw new Error(`unexpected df layout: ${data}`);
  }
  // Columns: filesystem, 1K-blocks, used, available, use%, mounted-on.
  const totalKb = Number(fields[1]);
  const availableKb = Number(fields[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb < 0 || availableKb < 0) {
    throw new Error(`unparsable df numbers: ${data}`);
  }
  return { freeBytes: availableKb * 1024, totalBytes: totalKb * 1024 };
}

/**
 * Walk up to the nearest existing ancestor. A dataDir that does not exist
 * yet (fresh server, first launch) still lives on its parent's filesystem,
 * so the watermark must measure that instead of fail-opening on ENOENT.
 */
export function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function df(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('df', ['-k', path], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(new Error(`df -k failed: ${error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function getDiskSpace(path: string): Promise<DiskSpace> {
  return parseDfOutput(await df(path));
}

/**
 * Throw InsufficientDiskSpaceError when free < minFreeBytes. Fail-open:
 * when the check itself errors (no df, unparsable output), warn loudly
 * and allow the launch.
 */
export async function assertDiskWatermark(path: string, minFreeBytes: number): Promise<void> {
  if (minFreeBytes <= 0) {
    return;
  }
  let space: DiskSpace;
  try {
    space = await getDiskSpace(nearestExistingAncestor(path));
  } catch (error) {
    console.warn(
      `[multiloger] disk watermark check failed (${error instanceof Error ? error.message : String(error)}); ` +
        'allowing launch (fail-open) — investigate disk monitoring',
    );
    return;
  }
  if (space.freeBytes < minFreeBytes) {
    throw new InsufficientDiskSpaceError(space.freeBytes, minFreeBytes);
  }
}
