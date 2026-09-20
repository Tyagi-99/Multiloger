/**
 * Database lifecycle: open (with durability pragmas) and close.
 *
 * Every connection gets:
 * - `journal_mode = WAL` — readers don't block writers; crash-safe.
 * - `synchronous = NORMAL` — safe with WAL, avoids a fsync per commit.
 * - `foreign_keys = ON` — SQLite does not enforce FKs unless asked.
 * - `busy_timeout = 5000` — wait instead of failing immediately on lock
 *   contention, so the single-writer model degrades gracefully.
 */

import { DatabaseSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import type { DatabaseSchema } from './schema.js';
import { NodeSqliteDatabase } from './node-sqlite-dialect.js';

export interface OpenDatabaseOptions {
  /**
   * Database file path, or `:memory:`. The parent directory must exist —
   * SQLite will not create it.
   */
  path: string;
}

const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
] as const;

export function openDatabase(options: OpenDatabaseOptions): Kysely<DatabaseSchema> {
  const raw = new DatabaseSync(options.path);
  try {
    for (const pragma of PRAGMAS) {
      raw.exec(pragma);
    }
  } catch (error) {
    raw.close();
    throw error;
  }

  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new NodeSqliteDatabase(raw) }),
  });
}

export async function closeDatabase(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.destroy();
}
