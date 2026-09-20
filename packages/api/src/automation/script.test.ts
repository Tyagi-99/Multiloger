/**
 * Tests for the automation step language: validation accepts the documented
 * surface and rejects everything else (unknown types, bad URLs, oversize
 * fields). The allowlist IS the security boundary, so it gets thorough
 * coverage.
 */

import { describe, expect, it } from 'vitest';
import { ScriptValidationError, validateSteps } from './script.js';

describe('validateSteps', () => {
  it('accepts a representative script and normalizes optional fields', () => {
    const steps = validateSteps([
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'wait', ms: 500 },
      { type: 'waitForSelector', selector: 'h1' },
      { type: 'evaluate', expression: 'document.title' },
      { type: 'getText', selector: 'h1', timeoutMs: 5000 },
      { type: 'screenshot' },
      { type: 'screenshot', fullPage: true },
    ]);
    expect(steps).toHaveLength(7);
    expect(steps[0]).toEqual({ type: 'navigate', url: 'https://example.com/' });
    expect(steps[3]).toEqual({ type: 'evaluate', expression: 'document.title' });
  });

  it('rejects non-array and empty scripts', () => {
    expect(() => validateSteps({})).toThrow(ScriptValidationError);
    expect(() => validateSteps([])).toThrow(ScriptValidationError);
    expect(() => validateSteps('navigate')).toThrow(ScriptValidationError);
  });

  it('rejects unknown step types', () => {
    expect(() => validateSteps([{ type: 'click' }])).toThrow(/unknown step type/);
    expect(() => validateSteps([{ type: 'Runtime.evaluate' }])).toThrow(/unknown step type/);
    expect(() => validateSteps([{}])).toThrow(/unknown step type/);
    expect(() => validateSteps(['navigate'])).toThrow(ScriptValidationError);
  });

  it('rejects more than MAX_STEPS steps', () => {
    const steps = Array.from({ length: 51 }, () => ({ type: 'wait', ms: 1 }));
    expect(() => validateSteps(steps)).toThrow(/too many steps/);
  });

  it('rejects non-http(s)/data navigate URLs and embedded credentials', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'about:blank',
      'not a url',
      'https://user:secret@example.com/',
    ]) {
      expect(() => validateSteps([{ type: 'navigate', url }]), url).toThrow(ScriptValidationError);
    }
  });

  it('accepts data: URLs (inert pages, no network requests)', () => {
    const steps = validateSteps([{ type: 'navigate', url: 'data:text/html,<h1>x</h1>' }]);
    expect(steps[0]).toEqual({ type: 'navigate', url: 'data:text/html,<h1>x</h1>' });
  });

  it('accepts loopback http URLs (local test targets)', () => {
    const steps = validateSteps([{ type: 'navigate', url: 'http://127.0.0.1:9/' }]);
    expect(steps[0]).toEqual({ type: 'navigate', url: 'http://127.0.0.1:9/' });
  });

  it('rejects out-of-range numeric fields', () => {
    expect(() => validateSteps([{ type: 'wait', ms: 0 }])).toThrow(ScriptValidationError);
    expect(() => validateSteps([{ type: 'wait', ms: 60_001 }])).toThrow(ScriptValidationError);
    expect(() => validateSteps([{ type: 'wait', ms: 1.5 }])).toThrow(ScriptValidationError);
    expect(() =>
      validateSteps([{ type: 'waitForSelector', selector: 'x', timeoutMs: 120_001 }]),
    ).toThrow(ScriptValidationError);
    expect(() => validateSteps([{ type: 'evaluate', expression: '1', timeoutMs: 0 }])).toThrow(
      ScriptValidationError,
    );
  });

  it('rejects empty or oversize string fields', () => {
    expect(() => validateSteps([{ type: 'navigate', url: '' }])).toThrow(ScriptValidationError);
    expect(() => validateSteps([{ type: 'waitForSelector', selector: '' }])).toThrow(
      ScriptValidationError,
    );
    expect(() => validateSteps([{ type: 'evaluate', expression: '' }])).toThrow(
      ScriptValidationError,
    );
    expect(() => validateSteps([{ type: 'evaluate', expression: 'x'.repeat(10_001) }])).toThrow(
      ScriptValidationError,
    );
    expect(() =>
      validateSteps([{ type: 'navigate', url: `https://example.com/${'a'.repeat(2048)}` }]),
    ).toThrow(ScriptValidationError);
  });

  it('rejects non-boolean screenshot fullPage', () => {
    expect(() => validateSteps([{ type: 'screenshot', fullPage: 'yes' }])).toThrow(
      ScriptValidationError,
    );
  });

  it('reports the failing step index', () => {
    try {
      validateSteps([
        { type: 'wait', ms: 10 },
        { type: 'wait', ms: -1 },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/Step 1/);
    }
  });
});
