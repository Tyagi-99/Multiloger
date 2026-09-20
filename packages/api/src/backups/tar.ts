/**
 * tar helpers for profile backups.
 *
 * Chromium profile dirs accumulate regenerable bulk: HTTP caches, shader
 * caches, crash dumps, logs, and lock files. Those are excluded — the
 * backup keeps identity-bearing state (Preferences, cookies, sessions,
 * extensions, local storage) so a restore lands the profile where the
 * user left it, minus the junk.
 *
 * Uses the system `tar` (gzip-compressed); encryption happens on the
 * compressed archive in crypto.ts.
 */

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

/** Basename patterns excluded from every backup. */
export const TAR_EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'DawnCache',
  'GraphiteDawnCache',
  'Crashpad',
  'Crash Reports',
  '*.log',
  'LOCK',
  'Singleton*',
];

function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      args,
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tar ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Archive sourceDir (gzip) into outPath, applying TAR_EXCLUDES. */
export async function createTar(sourceDir: string, outPath: string): Promise<void> {
  const excludes = TAR_EXCLUDES.flatMap((pattern) => [`--exclude=${pattern}`]);
  await runTar(['-czf', outPath, ...excludes, '-C', sourceDir, '.']);
}

/** Extract a gzip tar archive into destDir (created if needed). */
export async function extractTar(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  // --no-same-owner: never try to restore the archived uid/gid. As root tar
  // would otherwise attempt chown (failing in restricted environments), and
  // a restored profile must belong to the Multiloger operator in any case.
  await runTar(['-xzf', archivePath, '--no-same-owner', '-C', destDir]);
}

/** List member names of a gzip tar archive (for verify, without extracting). */
export async function listTar(archivePath: string): Promise<string[]> {
  const stdout = await runTar(['-tzf', archivePath]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class UnsafeArchiveMemberError extends Error {
  readonly members: string[];
  constructor(members: string[]) {
    super(`Unsafe archive member(s): ${members.map((m) => JSON.stringify(m)).join(', ')}`);
    this.name = 'UnsafeArchiveMemberError';
    this.members = members;
  }
}

/**
 * Defensive member validation before extracting an archive. Our own backups
 * can only contain relative members, but a planted or corrupted .mlbackup
 * must never escape the destination directory: reject absolute paths
 * (POSIX and Windows forms) and any `..` segment.
 */
export function assertSafeArchiveMembers(members: string[]): void {
  const unsafe = members.filter((member) => {
    const trimmed = member.trim();
    if (trimmed.length === 0) {
      return true;
    }
    if (isAbsolute(trimmed) || posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
      return true;
    }
    if (trimmed.includes('\0')) {
      return true;
    }
    // Both separators: a member restored on another OS must not escape either.
    return trimmed.split(/[\\/]/).some((segment) => segment === '..');
  });
  if (unsafe.length > 0) {
    throw new UnsafeArchiveMemberError(unsafe);
  }
}
