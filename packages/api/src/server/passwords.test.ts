import { describe, expect, it } from 'vitest';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './passwords.js';
import { ValidationError } from './router.js';

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('wrong-password-xyz', hash)).toBe(false);
  });

  it('uses a fresh random salt per hash', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-here', a)).toBe(true);
    expect(await verifyPassword('same-password-here', b)).toBe(true);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('anything-at-all!', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything-at-all!', 'scrypt$1$2')).toBe(false);
    expect(await verifyPassword('anything-at-all!', 'scrypt$0$8$1$ab$cd')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(() => {
      validatePasswordPolicy('short');
    }).toThrow(ValidationError);
    expect(() => {
      validatePasswordPolicy('x'.repeat(257));
    }).toThrow(ValidationError);
    expect(() => {
      validatePasswordPolicy('twelve-chars!');
    }).not.toThrow();
  });

  it('refuses to hash a policy-violating password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(ValidationError);
  });
});
