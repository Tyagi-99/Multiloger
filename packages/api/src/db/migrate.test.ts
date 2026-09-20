import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { closeDatabase, openDatabase } from './database.js';
import { migrateDown, migrateToLatest, MIGRATIONS } from './migrate.js';
import type { DatabaseSchema } from './schema.js';

async function tableNames(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const rows = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.execute(db);
  return rows.rows.map((r) => r.name);
}

describe('migration runner', () => {
  let dir: string | undefined;
  let db: Kysely<DatabaseSchema> | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('applies the baseline migration and records it in the journal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-mig-'));
    db = openDatabase({ path: join(dir, 'test.db') });

    const applied = await migrateToLatest(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.name));

    const tables = await tableNames(db);
    expect(tables).toContain('clients');
    expect(tables).toContain('profiles');
    expect(tables).toContain('_migrations');

    const journal = await db.selectFrom('_migrations').selectAll().execute();
    expect(journal.map((r) => r.name)).toEqual(applied);
  });

  it('is idempotent: a second run applies nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-mig-'));
    db = openDatabase({ path: join(dir, 'test.db') });

    expect(await migrateToLatest(db)).toHaveLength(MIGRATIONS.length);
    expect(await migrateToLatest(db)).toEqual([]);
  });

  it('rolls back migrations newest-first with migrateDown', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-mig-'));
    db = openDatabase({ path: join(dir, 'test.db') });

    await migrateToLatest(db);
    expect(await migrateDown(db, 1)).toEqual(['005-backups']);

    let tables = await tableNames(db);
    expect(tables).not.toContain('backups');
    expect(tables).toContain('api_tokens');

    expect(await migrateDown(db, 1)).toEqual(['004-api-tokens']);

    tables = await tableNames(db);
    expect(tables).not.toContain('api_tokens');
    expect(tables).toContain('proxies');
    expect(tables).toContain('profile_proxy_assignments');

    expect(await migrateDown(db, 1)).toEqual(['003-proxies']);
    tables = await tableNames(db);
    expect(tables).not.toContain('proxies');
    expect(tables).not.toContain('profile_proxy_assignments');
    expect(tables).toContain('sessions');

    expect(await migrateDown(db, 1)).toEqual(['002-sessions']);
    tables = await tableNames(db);
    expect(tables).not.toContain('sessions');
    expect(tables).toContain('profiles');

    expect(await migrateDown(db, 1)).toEqual(['001-baseline']);
    tables = await tableNames(db);
    expect(tables).not.toContain('clients');
    expect(tables).not.toContain('profiles');

    const journal = await db.selectFrom('_migrations').selectAll().execute();
    expect(journal).toEqual([]);

    // and the schema can be re-applied cleanly afterwards
    expect(await migrateToLatest(db)).toEqual([
      '001-baseline',
      '002-sessions',
      '003-proxies',
      '004-api-tokens',
      '005-backups',
    ]);
  });

  it('rejects invalid step counts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'multiloger-mig-'));
    db = openDatabase({ path: join(dir, 'test.db') });

    await expect(migrateDown(db, 0)).rejects.toThrow(/positive integer/);
    await expect(migrateDown(db, -2)).rejects.toThrow(/positive integer/);
  });
});
