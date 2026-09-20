/**
 * Shared kernel types for Multiloger. Framework-free: no Node or DOM APIs here
 * so both the API server and the web dashboard can depend on it.
 */

/** Opaque branded type helper — prevents mixing up plain strings for ids. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** ISO-8601 UTC timestamp, e.g. "2026-09-20T15:00:00.000Z". */
export type IsoDateString = Brand<string, 'IsoDateString'>;

export function toIsoDateString(date: Date): IsoDateString {
  return date.toISOString() as IsoDateString;
}

/** Discriminated result type used across package boundaries. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
