import { describe, expect, it } from 'vitest';
import { WEB_VERSION } from './main.js';

describe('web package smoke', () => {
  it('exposes a version', () => {
    expect(WEB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
