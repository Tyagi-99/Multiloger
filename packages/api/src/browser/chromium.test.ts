import { afterEach, describe, expect, it } from 'vitest';
import {
  ChromiumNotFoundError,
  resolveChromiumBinary,
  runningAsRoot,
} from './chromium.js';

describe('resolveChromiumBinary', () => {
  const original = process.env.CHROMIUM_PATH;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CHROMIUM_PATH;
    } else {
      process.env.CHROMIUM_PATH = original;
    }
  });

  it('honors the CHROMIUM_PATH override', () => {
    process.env.CHROMIUM_PATH = '/bin/true';
    expect(resolveChromiumBinary()).toBe('/bin/true');
  });

  it('rejects a CHROMIUM_PATH that is not executable', () => {
    process.env.CHROMIUM_PATH = '/nonexistent/chrome-binary';
    expect(() => resolveChromiumBinary()).toThrow(ChromiumNotFoundError);
  });

  it('finds a binary in this environment', () => {
    delete process.env.CHROMIUM_PATH;
    const binary = resolveChromiumBinary();
    expect(typeof binary).toBe('string');
    expect(binary.length).toBeGreaterThan(0);
  });

  it('reports running-as-root consistently with the platform', () => {
    expect(runningAsRoot()).toBe(typeof process.getuid === 'function' && process.getuid() === 0);
  });
});
