/**
 * Migration runner.
 *
 * - Migrations are an explicit ordered list (no filesystem scanning), so the
 *   set that ships is always the set that runs — in every environment.
 * - Each migration runs inside a transaction together with its journal row:
 *   a crash mid-migration rolls back both, never leaving a half-applied
 *   migration marked as done.
 * - `migrateToLatest` is idempotent: already-applied migrations are skipped.
 */

import type { Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';
import { baseline } from './migrations/001-baseline.js';
import { sessions } from './migrations/002-sessions.js';
import { proxies } from './migrations/003-proxies.js';
import { apiTokens } from './migrations/004-api-tokens.js';
import { backups } from './migrations/005-backups.js';
import { automation } from './migrations/006-automation.js';
import { dropScriptNameUnique } from './migrations/007-drop-script-name-unique.js';
import { apiTeams } from './migrations/008-teams.js';
import { phase4 } from './migrations/009-phase4.js';

export interface Migration {
  readonly name: string;
  up(db: Kysely<DatabaseSchema>): Promise<void>;
  down(db: Kysely<DatabaseSchema>): Promise<void>;
}

/** Ordered list of all migrations. Append new ones at the end — never reorder. */
export const MIGRATIONS: readonly Migration[] = [
  baseline,
  sessions,
  proxies,
  apiTokens,
  backups,
  automation,
  dropScriptNameUnique,
  apiTeams,
  phase4,
];

async function ensureJournalTable(db: Kysely<DatabaseSchema>): Promise<void> {
  await db.schema
    .createTable('_migrations')
    .ifNotExists()
    .addColumn('name', 'text', (col) => col.primaryKey())
    .addColumn('applied_at', 'text', (col) => col.notNull())
    .execute();
}

async function appliedNames(db: Kysely<DatabaseSchema>): Promise<Set<string>> {
  const rows = await db.selectFrom('_migrations').select('name').execute();
  return new Set(rows.map((row) => row.name));
}

/**
 * Applies every pending migration in order.
 * @returns names of migrations applied by this call (empty if none pending).
 */
export async function migrateToLatest(db: Kysely<DatabaseSchema>): Promise<string[]> {
  await ensureJournalTable(db);
  const applied = await appliedNames(db);
  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) {
      continue;
    }
    await db.transaction().execute(async (trx) => {
      await migration.up(trx);
      await trx
        .insertInto('_migrations')
        .values({ name: migration.name, applied_at: new Date().toISOString() })
        .execute();
    });
    newlyApplied.push(migration.name);
  }

  return newlyApplied;
}

/**
 * Rolls back the most recently applied migrations.
 * @returns names of migrations rolled back, most-recent first.
 */
export async function migrateDown(db: Kysely<DatabaseSchema>, steps = 1): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error('migrateDown: steps must be a positive integer');
  }
  await ensureJournalTable(db);
  const applied = await appliedNames(db);
  const toRevert = [...MIGRATIONS]
    .reverse()
    .filter((m) => applied.has(m.name))
    .slice(0, steps);
  const reverted: string[] = [];

  for (const migration of toRevert) {
    await db.transaction().execute(async (trx) => {
      await migration.down(trx);
      await trx.deleteFrom('_migrations').where('name', '=', migration.name).execute();
    });
    reverted.push(migration.name);
  }

  return reverted;
}
