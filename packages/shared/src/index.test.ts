import { describe, expect, it } from 'vitest';
import { err, ok, toIsoDateString } from './index.js';

describe('shared kernel smoke', () => {
  it('formats ISO date strings', () => {
    expect(toIsoDateString(new Date('2026-09-20T15:00:00.000Z'))).toBe('2026-09-20T15:00:00.000Z');
  });

  it('builds ok/err results', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    const failure = err(new Error('boom'));
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.message).toBe('boom');
    }
  });
});
