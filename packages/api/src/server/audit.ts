/**
 * Audit log writer (Phase 3).
 *
 * Every mutating API route records one entry AFTER the mutation succeeds
 * (wired in server/index.ts from the route's audit config). Entries carry
 * the actor, action, entity, route template, and safe scalar context —
 * never request bodies, tokens, passwords, or secrets. A failed audit
 * write propagates: audit is a hard guarantee, not best-effort.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';

export type AuditActorType = 'user' | 'token' | 'anonymous';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** Safe scalar context only — never bodies, tokens, or secrets. */
  details?: Record<string, string | number | boolean | null>;
  ip?: string;
}

export async function recordAudit(db: Kysely<DatabaseSchema>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      details_json: entry.details ? JSON.stringify(entry.details) : null,
      ip: entry.ip ?? null,
    })
    .execute();
}

export interface AuditLogQuery {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  since?: string;
  limit: number;
  offset: number;
}

export interface AuditLogPage {
  entries: {
    id: string;
    at: string;
    actorType: string;
    actorId: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    details: unknown;
    ip: string | null;
  }[];
  total: number;
  limit: number;
  offset: number;
}

/** Paginated audit-log query with optional filters. */
export async function queryAuditLog(
  db: Kysely<DatabaseSchema>,
  query: AuditLogQuery,
): Promise<AuditLogPage> {
  let base = db.selectFrom('audit_log');
  if (query.actorId !== undefined) {
    base = base.where('actor_id', '=', query.actorId);
  }
  if (query.action !== undefined) {
    base = base.where('action', '=', query.action);
  }
  if (query.entityType !== undefined) {
    base = base.where('entity_type', '=', query.entityType);
  }
  if (query.entityId !== undefined) {
    base = base.where('entity_id', '=', query.entityId);
  }
  if (query.since !== undefined) {
    base = base.where('at', '>=', query.since);
  }
  const totalRow = await base
    .select((eb) => eb.fn.countAll().as('total'))
    .executeTakeFirst();
  const total = Number(totalRow?.total ?? 0);
  const rows = await base
    .selectAll()
    .orderBy('at', 'desc')
    .limit(query.limit)
    .offset(query.offset)
    .execute();
  return {
    entries: rows.map((row) => ({
      id: row.id,
      at: row.at,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details_json ? (JSON.parse(row.details_json) as unknown) : null,
      ip: row.ip,
    })),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}
