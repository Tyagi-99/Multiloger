/**
 * Proxy launch gate: resolves the Chromium proxy flags for a profile launch,
 * fail-closed.
 *
 * Rules:
 * - `proxy_required` + no assigned proxy            → ProxyRequiredError
 * - assigned proxy fails the TCP health check       → ProxyUnhealthyError
 *   (this applies even when the proxy is not "required": launching through
 *   a dead proxy would silently expose the real IP, so we refuse instead)
 * - no assignment and not required                  → undefined (direct)
 *
 * Credentials: resolved from `password_secret_ref` (`env:VAR`) at launch
 * time. They are returned to the caller but MUST never be logged — the
 * manager logs only a warning that MVP proxy auth is not applied (Chromium
 * ignores inline proxy credentials; applying them needs a CDP
 * Fetch.continueWithAuth handler, which is deferred and tracked).
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import type { ProxyFlagOptions } from '../browser/flags.js';
import { getProfile } from '../profiles/repository.js';
import {
  getAssignedProxy,
  type ProxyRecord,
} from './repository.js';
import { checkProxyHealth, type ProxyHealth } from './health.js';

export class ProxyRequiredError extends Error {
  readonly code = 'PROXY_REQUIRED';
  constructor(readonly profileId: string) {
    super(`Profile ${profileId} requires a proxy, but none is assigned`);
    this.name = 'ProxyRequiredError';
  }
}

export class ProxyUnhealthyError extends Error {
  readonly code = 'PROXY_UNHEALTHY';
  constructor(
    readonly proxyId: string,
    readonly health: ProxyHealth,
  ) {
    super(
      `Proxy ${proxyId} failed its health check (${health.error ?? 'unknown'}${health.detail ? `: ${health.detail}` : ''}); ` +
        'launch refused — fix or unassign the proxy',
    );
    this.name = 'ProxyUnhealthyError';
  }
}

export class ProxyCredentialError extends Error {
  readonly code = 'PROXY_CREDENTIAL';
  constructor(message: string) {
    super(message);
    this.name = 'ProxyCredentialError';
  }
}

export interface ResolvedProxyCredentials {
  username: string;
  password: string;
}

const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolve the credential pair for a proxy record. Returns undefined when
 * the proxy needs no auth. Throws ProxyCredentialError when the referenced
 * environment variable is missing. The returned password must never be
 * logged or persisted.
 */
export function resolveProxyCredentials(
  record: ProxyRecord,
): ResolvedProxyCredentials | undefined {
  if (!record.password_secret_ref) {
    return undefined;
  }
  const match = ENV_REF_PATTERN.exec(record.password_secret_ref);
  if (!match?.[1]) {
    // Unreachable through the repository (validated at write time), but
    // fail closed if a row was edited by hand.
    throw new ProxyCredentialError(
      `Proxy ${record.id} has a malformed password_secret_ref`,
    );
  }
  const varName = match[1];
  const password = process.env[varName];
  if (!password) {
    throw new ProxyCredentialError(
      `Proxy ${record.id} references unset environment variable ${varName}`,
    );
  }
  return { username: record.username ?? '', password };
}

/**
 * The ProxyResolver seam for ProfileManager: returns Chromium proxy flags
 * or throws when the launch must not proceed.
 */
export async function resolveProxyForLaunch(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  healthTimeoutMs = 5000,
): Promise<ProxyFlagOptions | undefined> {
  const profile = await getProfile(db, profileId);
  const assigned = await getAssignedProxy(db, profileId);

  if (!assigned) {
    if (profile.proxy_required === 1) {
      throw new ProxyRequiredError(profileId);
    }
    return undefined;
  }

  const health = await checkProxyHealth(assigned.host, assigned.port, healthTimeoutMs);
  if (!health.ok) {
    throw new ProxyUnhealthyError(assigned.id, health);
  }

  const credentials = resolveProxyCredentials(assigned);
  if (credentials) {
    // Honest MVP limitation, logged without the secret.
    console.warn(
      `[multiloger] proxy "${assigned.name}" has credentials configured, ` +
        'but Chromium proxy authentication (CDP Fetch.continueWithAuth) is not ' +
        'implemented in the MVP — launching WITHOUT proxy authentication',
    );
  }

  const flags: ProxyFlagOptions = {
    scheme: assigned.scheme,
    host: assigned.host,
    port: assigned.port,
  };
  if (assigned.bypass) {
    flags.bypass = assigned.bypass;
  }
  return flags;
}
