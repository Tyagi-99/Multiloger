/**
 * Database schema — the single source of truth for table shapes.
 *
 * Conventions:
 * - `id` columns are text primary keys (UUIDs generated in application code).
 * - Timestamps are ISO-8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * - Nullable columns use `| null`; NOT NULL columns are non-optional.
 */

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
  created_at: string;
  updated_at: string;
}

/** Migration journal — which migrations have been applied, in order. */
export interface MigrationsTable {
  name: string;
  applied_at: string;
}

export interface DatabaseSchema {
  clients: ClientsTable;
  profiles: ProfilesTable;
  _migrations: MigrationsTable;
}
