/**
 * Kysely dialect adapter for Node's built-in `node:sqlite`.
 *
 * Kysely ships `SqliteDialect`, which only needs a structurally compatible
 * database object (`close()` + `prepare()` returning `{ reader, all, run,
 * iterate }`). `node:sqlite`'s `DatabaseSync`/`StatementSync` are close but
 * differ in two ways, bridged here:
 *
 * 1. `StatementSync` has no `reader` flag — it is derived from the SQL text.
 *    SELECT/WITH/VALUES/EXPLAIN/PRAGMA/TABLE statements are readers.
 * 2. `StatementSync` takes parameters variadically, while Kysely passes an
 *    array — the array is spread at the call site.
 *
 * Why not better-sqlite3: it needs a native build (or prebuilt binaries per
 * Node version). `node:sqlite` ships with Node 22.5+/24, so installs need no
 * compiler and no binary downloads.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

const READER_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA', 'TABLE']);

function isReaderSql(sql: string): boolean {
  const keyword = /^\s*([A-Za-z]+)/.exec(sql)?.[1];
  return keyword !== undefined && READER_KEYWORDS.has(keyword.toUpperCase());
}

/** Structural match for the statement interface Kysely's SqliteDialect needs. */
export class NodeSqliteStatement {
  readonly reader: boolean;

  constructor(
    private readonly stmt: StatementSync,
    sql: string,
  ) {
    this.reader = isReaderSql(sql);
  }

  all(parameters: readonly unknown[]): unknown[] {
    return this.stmt.all(...(parameters as never[]));
  }

  run(parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  } {
    return this.stmt.run(...(parameters as never[]));
  }

  iterate(parameters: readonly unknown[]): IterableIterator<unknown> {
    return this.stmt.iterate(...(parameters as never[])) as IterableIterator<unknown>;
  }
}

/** Structural match for the database interface Kysely's SqliteDialect needs. */
export class NodeSqliteDatabase {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  prepare(sql: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql), sql);
  }

  /** Escape hatch for pragmas / multi-statement scripts (used at open time). */
  raw(): DatabaseSync {
    return this.db;
  }
}
