/**
 * Minimal router: method + path-template matching, JSON body parsing,
 * and response helpers. No framework.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import type { ProfileManager } from '../profiles/manager.js';
import type { ApiTokensTable } from './tokens.js';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path parameters, e.g. { id: '...' } for /v1/profiles/:id. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (undefined for methods without a body). */
  body: unknown;
  /** The authenticated token. Always set: every route requires auth except /health and /v1/events. */
  token: ApiTokensTable | null;
  db: Kysely<DatabaseSchema>;
  manager: ProfileManager;
  /** Base directory under which profile user-data dirs live. */
  dataDir: string;
  /** Lock TTL in ms, for lock staleness reporting. */
  lockTtlMs: number;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

export interface Route {
  method: string;
  template: string;
  pattern: RegExp;
  paramNames: string[];
  /** false only for /health and the WebSocket upgrade path. */
  auth: boolean;
  handler: RouteHandler;
}

export function defineRoute(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  template: string,
  handler: RouteHandler,
  auth = true,
): Route {
  const paramNames: string[] = [];
  const source = template
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, template, pattern: new RegExp(`^${source}$`), paramNames, auth, handler };
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class InvalidJsonError extends Error {
  constructor() {
    super('Request body is not valid JSON');
    this.name = 'InvalidJsonError';
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds 1 MiB');
    this.name = 'BodyTooLargeError';
  }
}

/** A 400-class client error: malformed field, missing required value, bad enum. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Read and JSON-parse the request body. Throws InvalidJsonError / BodyTooLargeError. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Drain to avoid hanging the socket, then fail.
      req.resume();
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** Assert the body is a JSON object; throws a 400-style error otherwise. */
export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidJsonError();
  }
  return body as Record<string, unknown>;
}

export function getStringField(body: Record<string, unknown>, field: string, opts: { required?: boolean; maxLength?: number } = {}): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new ValidationError(`Missing required field: ${field}`);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`Field must be a string: ${field}`);
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    throw new ValidationError(`Field too long (max ${String(opts.maxLength)}): ${field}`);
  }
  return value;
}
