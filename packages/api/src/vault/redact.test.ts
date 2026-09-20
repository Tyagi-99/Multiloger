/**
 * Redact tests (written first): log-safe secret redaction utilities.
 */

import { describe, expect, it } from 'vitest';
import { maskSecret, redactSecretsDeep, redactSecretsText } from './redact.js';

describe('redactSecretsText', () => {
  it('replaces every occurrence of each secret', () => {
    const out = redactSecretsText('login=hunter2 pw=hunter2 hunter2 again', ['hunter2']);
    expect(out).toBe('login=[REDACTED] pw=[REDACTED] [REDACTED] again');
  });

  it('replaces multiple distinct secrets', () => {
    const out = redactSecretsText('user=admin token=tok-abc', ['admin', 'tok-abc']);
    expect(out).toBe('user=[REDACTED] token=[REDACTED]');
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecretsText('nothing to hide here', ['s3cret'])).toBe('nothing to hide here');
  });

  it('ignores empty secret strings', () => {
    expect(redactSecretsText('abc', ['', 'b'])).toBe('a[REDACTED]c');
  });

  it('replaces secrets that contain regex metacharacters literally', () => {
    const secret = 'p@ss.*w?rd$';
    expect(redactSecretsText(`login ${secret} done`, [secret])).toBe('login [REDACTED] done');
  });

  it('handles overlapping secrets by replacing longer ones first', () => {
    expect(redactSecretsText('token=abcdef', ['abc', 'abcdef'])).toBe('token=[REDACTED]');
  });

  it('accepts an empty secret list', () => {
    expect(redactSecretsText('abc', [])).toBe('abc');
  });
});

describe('redactSecretsDeep', () => {
  it('redacts secrets in nested objects and arrays', () => {
    const secrets = ['hunter2', 'tok-abc'];
    const input = {
      user: 'admin',
      password: 'hunter2',
      nested: { deep: ['keep', 'tok-abc-123'], flag: true, count: 7 },
      list: [{ token: 'tok-abc' }, 'plain'],
    };
    const out = redactSecretsDeep(input, secrets) as Record<string, unknown>;
    expect(out.user).toBe('admin');
    expect(out.password).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    const deep = nested.deep as unknown[];
    expect(deep[0]).toBe('keep');
    expect(deep[1]).toBe('[REDACTED]-123');
    expect(nested.flag).toBe(true);
    expect(nested.count).toBe(7);
    const list = out.list as unknown[];
    expect((list[0] as Record<string, unknown>).token).toBe('[REDACTED]');
    expect(list[1]).toBe('plain');
  });

  it('does not mutate the input', () => {
    const input = { password: 'hunter2', arr: ['hunter2'] };
    const out = redactSecretsDeep(input, ['hunter2']) as typeof input;
    expect(out).not.toBe(input);
    expect(out.arr).not.toBe(input.arr);
    expect(input.password).toBe('hunter2');
  });

  it('passes through primitives unchanged', () => {
    expect(redactSecretsDeep(null, ['x'])).toBeNull();
    expect(redactSecretsDeep(undefined, ['x'])).toBeUndefined();
    expect(redactSecretsDeep(42, ['x'])).toBe(42);
    expect(redactSecretsDeep(true, ['x'])).toBe(true);
    expect(redactSecretsDeep('clean', ['x'])).toBe('clean');
  });

  it('redacts only the secret portion of a string', () => {
    expect(redactSecretsDeep('prefix-hunter2-suffix', ['hunter2'])).toBe('prefix-[REDACTED]-suffix');
  });

  it('handles empty objects and arrays', () => {
    expect(redactSecretsDeep({}, ['x'])).toEqual({});
    expect(redactSecretsDeep([], ['x'])).toEqual([]);
  });
});

describe('maskSecret', () => {
  it('never reveals any part of the secret', () => {
    expect(maskSecret('hunter2')).toBe('[REDACTED]');
    expect(maskSecret('')).toBe('[REDACTED]');
    expect(maskSecret('a-very-long-secret-value')).toBe('[REDACTED]');
  });
});
