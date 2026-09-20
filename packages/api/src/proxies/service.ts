/**
 * Proxy launch gate: resolves the Chromium proxy flags for a profile launch,
 * fail-closed.
 *
 * Rules:
 * - `proxy_required` + no assigned proxy            → ProxyRequiredError
 * - assigned proxy has env:-style (or other non-vault) credentials → ProxyAuthUnsupportedError
 *   (this build can only apply vault-backed credentials via the CDP
 *   Fetch.continueWithAuth handler; anything else would silently send
 *   traffic unauthenticated, so the launch is refused)
 * - assigned proxy has a vault: credential ref that does not resolve → ProxyCredentialError
 *   (dangling ref or unconfigured vault — also a refusal, never silent)
 * - assigned proxy fails the TCP health check       → ProxyUnhealthyError
 *   (this applies even when the proxy is not "required": launching through
 *   a dead proxy would silently expose the real IP, so we refuse instead)
 * - no assignment and not required                  → undefined (direct)
 *
 * Credentials: resolved from `password_secret_ref` (`env:VAR` or
 * `vault:<name>`) by resolveProxyCredentials. They are never logged.
 * resolveProxyAuthForLaunch is the seam ProfileManager uses to attach the
 * CDP proxy-auth handler: the password lives only inside the returned
 * getCredentials closure, never on a long-lived object.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import type { ProxyFlagOptions } from '../browser/flags.js';
import { getProfile } from '../profiles/repository.js';
import { getSecret } from '../vault/index.js';
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

/**
 * Fail-closed refusal: the proxy has credentials configured that this build
 * cannot apply (an `env:` password ref, or a username with no vault-backed
 * secret) — only `vault:` password refs can be supplied to Chromium via the
 * CDP Fetch.continueWithAuth handler, and Chromium ignores inline proxy
 * credentials. Launching anyway would silently send traffic without
 * authentication, so the launch is refused. Move the password into the vault
 * (a `vault:<name>` ref) to launch through it.
 */
export class ProxyAuthUnsupportedError extends Error {
  readonly code = 'PROXY_AUTH_UNSUPPORTED';
  constructor(readonly proxyId: string) {
    super(
      `Proxy ${proxyId} has credentials configured, but proxy authentication ` +
        'is not supported in this build — launch refused rather than sending ' +
        'traffic unauthenticated',
    );
    this.name = 'ProxyAuthUnsupportedError';
  }
}

export interface ResolvedProxyCredentials {
  username: string;
  password: string;
}

const ENV_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const VAULT_REF_PATTERN = /^vault:([A-Za-z0-9_.-]{1,100})$/;

/**
 * Resolve the credential pair for a proxy record. Returns undefined when
 * the proxy needs no auth.
 *
 * - `env:VAR` reads the password from the environment (kept for
 *   compatibility; the launch gate refuses these — credentials come only
 *   from the vault).
 * - `vault:<name>` reads the password from the vault at `opts.vaultPath`
 *   (or the MULTILOGER_VAULT_PATH environment variable when unset).
 *
 * Throws ProxyCredentialError when the reference is malformed, the vault is
 * not configured, or the secret cannot be read. The returned password must
 * never be logged or persisted.
 */
export function resolveProxyCredentials(
  record: ProxyRecord,
  opts?: { vaultPath?: string },
): ResolvedProxyCredentials | undefined {
  if (!record.password_secret_ref) {
    return undefined;
  }
  const envMatch = ENV_REF_PATTERN.exec(record.password_secret_ref);
  if (envMatch?.[1]) {
    const varName = envMatch[1];
    const password = process.env[varName];
    if (!password) {
      throw new ProxyCredentialError(
        `Proxy ${record.id} references unset environment variable ${varName}`,
      );
    }
    return { username: record.username ?? '', password };
  }
  const vaultMatch = VAULT_REF_PATTERN.exec(record.password_secret_ref);
  if (vaultMatch?.[1]) {
    const name = vaultMatch[1];
    const vaultPath = opts?.vaultPath ?? process.env.MULTILOGER_VAULT_PATH;
    if (!vaultPath) {
      throw new ProxyCredentialError(
        `Proxy ${record.id} references vault secret "${name}" but no vault is configured ` +
          '(set MULTILOGER_VAULT_PATH or pass vaultPath)',
      );
    }
    let password: string | undefined;
    try {
      password = getSecret(vaultPath, name);
    } catch (error) {
      throw new ProxyCredentialError(
        `Proxy ${record.id} references unreadable vault secret "${name}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!password) {
      throw new ProxyCredentialError(
        `Proxy ${record.id} references vault secret "${name}", which is missing or empty`,
      );
    }
    return { username: record.username ?? '', password };
  }
  // Unreachable through the repository (validated at write time), but
  // fail closed if a row was edited by hand.
  throw new ProxyCredentialError(
    `Proxy ${record.id} has a malformed password_secret_ref`,
  );
}

/**
 * The ProxyResolver seam for ProfileManager: returns Chromium proxy flags
 * or throws when the launch must not proceed.
 */
export async function resolveProxyForLaunch(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  healthTimeoutMs = 5000,
  opts?: { vaultPath?: string },
): Promise<ProxyFlagOptions | undefined> {
  const profile = await getProfile(db, profileId);
  const assigned = await getAssignedProxy(db, profileId);

  if (!assigned) {
    if (profile.proxy_required === 1) {
      throw new ProxyRequiredError(profileId);
    }
    return undefined;
  }

  // Fail closed on credential material this build cannot apply. A `vault:`
  // password ref CAN be applied via the CDP Fetch.continueWithAuth handler,
  // so it passes the gate like an unauthenticated proxy — but the secret is
  // resolved eagerly here so a dangling ref (or an unconfigured vault)
  // refuses the launch now instead of failing into repeated 407s later.
  // `env:` refs (or any other credentialed form) still refuse: credentials
  // come only from the vault. A dangling env ref surfaces as
  // ProxyCredentialError from resolveProxyCredentials — also a refusal,
  // never a silent launch.
  const ref = assigned.password_secret_ref;
  if (ref !== null && VAULT_REF_PATTERN.test(ref)) {
    resolveProxyCredentials(assigned, opts);
  } else {
    const credentials = resolveProxyCredentials(assigned, opts);
    if (credentials !== undefined || (assigned.username ?? '').length > 0) {
      throw new ProxyAuthUnsupportedError(assigned.id);
    }
  }

  const health = await checkProxyHealth(assigned.host, assigned.port, healthTimeoutMs);
  if (!health.ok) {
    throw new ProxyUnhealthyError(assigned.id, health);
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

/**
 * The proxy-auth configuration handed to ProfileManager's `resolveProxyAuth`
 * seam. The password lives ONLY inside the `getCredentials` closure — the
 * object itself carries no secret material and is safe to keep on the live
 * profile entry.
 */
export interface ProxyAuthConfig {
  proxyId: string;
  /** Resolves the credential pair on demand (synchronous; vault reads are sync). */
  getCredentials: () => ResolvedProxyCredentials;
}

/**
 * Resolve the CDP proxy-auth configuration for a profile launch. Returns
 * undefined when no proxy is assigned or the assigned proxy needs no
 * authentication. Throws ProxyAuthUnsupportedError for non-vault
 * credentialed proxies, mirroring the launch gate.
 */
export async function resolveProxyAuthForLaunch(
  db: Kysely<DatabaseSchema>,
  profileId: string,
  opts?: { vaultPath?: string },
): Promise<ProxyAuthConfig | undefined> {
  const assigned = await getAssignedProxy(db, profileId);
  if (!assigned?.password_secret_ref) {
    return undefined;
  }
  if (!VAULT_REF_PATTERN.test(assigned.password_secret_ref)) {
    // env: refs (or anything else) cannot be applied securely — mirror the
    // launch gate's refusal.
    throw new ProxyAuthUnsupportedError(assigned.id);
  }
  return {
    proxyId: assigned.id,
    getCredentials: () => {
      const credentials = resolveProxyCredentials(assigned, opts);
      if (!credentials) {
        // Unreachable: the vault: ref was validated above — fail closed.
        throw new ProxyCredentialError(
          `Proxy ${assigned.id} has no resolvable credentials`,
        );
      }
      return credentials;
    },
  };
}
