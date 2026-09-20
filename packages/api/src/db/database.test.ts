import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, openDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'multiloger-db-'));
}

describe('openDatabase', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('opens with WAL journal mode and foreign keys enforced', async () => {
    dir = tempDir();
    const db = openDatabase({ path: join(dir, 'test.db') });
    try {
      const journal = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db);
      expect(journal.rows[0]?.journal_mode).toBe('wal');

      const fk = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
      expect(fk.rows[0]?.foreign_keys).toBe(1);
    } finally {
      await closeDatabase(db);
    }
  });

  it('enforces foreign keys on profiles', async () => {
    dir = tempDir();
    const db = openDatabase({ path: join(dir, 'test.db') });
    try {
      await migrateToLatest(db);
      const now = new Date().toISOString();
      await expect(
        db
          .insertInto('profiles')
          .values({
            id: 'profile-1',
            client_id: 'no-such-client',
            name: 'p1',
            state: 'created',
            locked_by: null,
            locked_at: null,
            user_data_dir: '/tmp/p1',
            created_at: now,
            updated_at: now,
          })
          .execute(),
      ).rejects.toThrow(/FOREIGN KEY/i);
    } finally {
      await closeDatabase(db);
    }
  });

  it('round-trips a client and profile through kysely', async () => {
    dir = tempDir();
    const db = openDatabase({ path: join(dir, 'test.db') });
    try {
      await migrateToLatest(db);
      const now = new Date().toISOString();
      await db
        .insertInto('clients')
        .values({
          id: 'client-1',
          name: 'Acme',
          notes: null,
          archived_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('profiles')
        .values({
          id: 'profile-1',
          client_id: 'client-1',
          name: 'acme-main',
          state: 'created',
          locked_by: null,
          locked_at: null,
          user_data_dir: '/tmp/acme-main',
          created_at: now,
          updated_at: now,
        })
        .execute();

      const row = await db
        .selectFrom('profiles')
        .innerJoin('clients', 'clients.id', 'profiles.client_id')
        .select(['profiles.name as profile', 'clients.name as client'])
        .where('profiles.id', '=', 'profile-1')
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ profile: 'acme-main', client: 'Acme' });
    } finally {
      await closeDatabase(db);
    }
  });
});
