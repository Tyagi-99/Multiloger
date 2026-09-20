import { describe, expect, it } from 'vitest';
import { API_VERSION, createApiInfo } from './index.js';

describe('api package smoke', () => {
  it('exposes a version', () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('creates api info', () => {
    expect(createApiInfo()).toEqual({ name: 'multiloger-api', version: API_VERSION });
  });
});
