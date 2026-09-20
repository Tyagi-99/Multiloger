/**
 * Database schema — the single source of truth for table shapes.
 *
 * Conventions:
 * - `id` columns are text primary keys (UUIDs generated in application code).
 * - Timestamps are ISO-8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * - Nullable columns use `| null`; NOT NULL columns are non-optional.
 */

import type { Generated } from 'kysely';

export interface ClientsTable {
  id: string;
  name: string;
  notes: string | null;
  /** ISO-8601 timestamp when archived; null means active. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfilesTable {
  id: string;
  client_id: string;
  name: string;
  /**
   * Lifecycle state. The authoritative transition rules live in the profile
   * state machine (Task 3); the database stores the current state as text.
   */
  state: string;
  /** Owner token holding the profile lock; null means unlocked. */
  locked_by: string | null;
  /** ISO-8601 timestamp when the lock was taken; null means unlocked. */
  locked_at: string | null;
  /** Absolute path of the Chromium user-data directory. Unique per profile. */
  user_data_dir: string;
  /** PID of the last browser process for this profile; null when not launched. */
  last_pid: number | null;
  /** CDP port of the last launch; null when not launched. */
  last_cdp_port: number | null;
  /** ISO-8601 timestamp of the last launch; null when never launched. */
  last_launched_at: string | null;
  /** 1 = launching this profile without a healthy assigned proxy is refused. */
  proxy_required: number;
  created_at: string;
  updated_at: string;
}

/** Migration journal — which migrations have been applied, in order. */
export interface MigrationsTable {
  name: string;
  applied_at: string;
}

/** One row per profile launch — history for "last used" and crash forensics. */
export interface SessionsTable {
  id: string;
  profile_id: string;
  started_at: string;
  ended_at: string | null;
  /** 'stopped' | 'crashed' | 'error' — how the session ended. */
  exit_reason: string | null;
  pid: number | null;
  cdp_port: number | null;
}

/** Managed proxy endpoint. The password itself is never stored — see password_secret_ref. */
export interface ProxiesTable {
  id: string;
  name: string;
  /** 'http' | 'https' | 'socks5'. */
  scheme: string;
  host: string;
  port: number;
  /** Proxy username (not secret). Null when the proxy needs no auth. */
  username: string | null;
  /**
   * Opaque credential reference, e.g. `env:ACME_PROXY_PASSWORD`, resolved
   * from the process environment at launch time. Never a plaintext secret.
   */
  password_secret_ref: string | null;
  /** Chromium --proxy-bypass-list override; null means the default. */
  bypass: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** At most one proxy assigned per profile (MVP). */
export interface ProfileProxyAssignmentsTable {
  profile_id: string;
  proxy_id: string;
  created_at: string;
}

export interface ApiTokensTable {
  id: string;
  name: string;
  /** First 12 chars of the token ('mlt_' + 8) — lookup key, not a secret. */
  prefix: string;
  /** Hex-encoded scrypt salt. */
  salt: string;
  /** Hex-encoded scrypt key. */
  hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface BackupsTable {
  /** Autoincrement ordering key; makes retention deterministic. */
  seq: Generated<number>;
  /** Public UUID, also the file stem (<id>.mlbackup). */
  id: string;
  /** Source profile at backup time. */
  profile_id: string;
  file_name: string;
  size_bytes: number;
  /** Hex SHA-256 of the plaintext (pre-encryption) tarball. */
  sha256: string;
  /** e.g. 'aes-256-gcm'. */
  encryption: string;
  created_at: string;
}

export interface DatabaseSchema {
  clients: ClientsTable;
  profiles: ProfilesTable;
  sessions: SessionsTable;
  proxies: ProxiesTable;
  profile_proxy_assignments: ProfileProxyAssignmentsTable;
  api_tokens: ApiTokensTable;
  backups: BackupsTable;
  _migrations: MigrationsTable;
}
