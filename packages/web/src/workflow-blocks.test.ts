/**
 * Tests for the workflow builder block model: block creation, validation
 * (mirroring the API's script bounds), block manipulation, and the
 * block <-> Phase 2 script JSON round-trip.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES,
  blocksToSteps,
  createBlock,
  MAX_BLOCKS,
  moveBlock,
  stepsToBlocks,
  validateBlock,
  validateBlocks,
  type WorkflowBlock,
} from './workflow-blocks.js';

function block(type: WorkflowBlock['type'], fields: WorkflowBlock['fields'] = {}): WorkflowBlock {
  return { id: `test-${type}`, type, fields };
}

describe('createBlock', () => {
  it('creates one default block per supported type', () => {
    for (const type of BLOCK_TYPES) {
      const b = createBlock(type);
      expect(b.type).toBe(type);
      expect(b.id.length).toBeGreaterThan(0);
    }
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createBlock('wait').id));
    expect(ids.size).toBe(20);
  });

  it('defaults are valid out of the box (except the empty-selector blocks)', () => {
    // navigate/wait/evaluate/screenshot defaults validate cleanly.
    for (const type of ['navigate', 'wait', 'evaluate', 'screenshot'] as const) {
      expect(validateBlock(createBlock(type))).toEqual([]);
    }
  });
});

describe('validateBlock', () => {
  it('accepts valid blocks of every type', () => {
    const valid: WorkflowBlock[] = [
      block('navigate', { url: 'https://example.com/path?q=1' }),
      block('navigate', { url: 'data:text/html,<h1>hi</h1>' }),
      block('wait', { ms: 1000 }),
      block('waitForSelector', { selector: '#main .item', timeoutMs: 5000 }),
      block('evaluate', { expression: 'document.title' }),
      block('getText', { selector: 'h1' }),
      block('screenshot', { fullPage: true }),
      block('screenshot', {}),
    ];
    for (const b of valid) {
      expect(validateBlock(b)).toEqual([]);
    }
  });

  it('rejects dangerous and malformed navigate URLs', () => {
    expect(validateBlock(block('navigate', { url: '' }))).not.toEqual([]);
    expect(validateBlock(block('navigate', { url: 'not a url' }))).not.toEqual([]);
    expect(validateBlock(block('navigate', { url: 'javascript:alert(1)' }))).not.toEqual([]);
    expect(validateBlock(block('navigate', { url: 'file:///etc/passwd' }))).not.toEqual([]);
    expect(validateBlock(block('navigate', { url: 'https://user:pass@example.com/' }))).not.toEqual(
      [],
    );
    expect(
      validateBlock(block('navigate', { url: `https://x.io/${'a'.repeat(3000)}` })),
    ).not.toEqual([]);
  });

  it('bounds wait durations', () => {
    expect(validateBlock(block('wait', { ms: 0 }))).not.toEqual([]);
    expect(validateBlock(block('wait', { ms: -5 }))).not.toEqual([]);
    expect(validateBlock(block('wait', { ms: 1.5 }))).not.toEqual([]);
    expect(validateBlock(block('wait', { ms: 60_001 }))).not.toEqual([]);
    expect(validateBlock(block('wait', { ms: 60_000 }))).toEqual([]);
  });

  it('requires selectors and bounds expression/timeout fields', () => {
    expect(validateBlock(block('waitForSelector', { selector: '' }))).not.toEqual([]);
    expect(validateBlock(block('getText', {}))).not.toEqual([]);
    expect(validateBlock(block('evaluate', { expression: '' }))).not.toEqual([]);
    expect(validateBlock(block('waitForSelector', { selector: 'a', timeoutMs: 0 }))).not.toEqual(
      [],
    );
    expect(validateBlock(block('evaluate', { expression: '1', timeoutMs: 120_001 }))).not.toEqual(
      [],
    );
    expect(validateBlock(block('waitForSelector', { selector: 'a'.repeat(501) }))).not.toEqual([]);
    expect(validateBlock(block('evaluate', { expression: 'x'.repeat(10_001) }))).not.toEqual([]);
  });

  it('treats raw passthrough blocks as valid', () => {
    const b = block('navigate', {});
    b.raw = { type: 'some-future-step', anything: [1, 2] };
    expect(validateBlock(b)).toEqual([]);
  });
});

describe('validateBlocks', () => {
  it('requires at least one block and caps the block count', () => {
    expect(validateBlocks([]).length).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_BLOCKS + 1 }, () => createBlock('wait'));
    expect(validateBlocks(many).length).toBeGreaterThan(0);
    expect(validateBlocks([createBlock('wait')])).toEqual([]);
  });

  it('reports per-block problems with their index', () => {
    const problems = validateBlocks([
      block('navigate', { url: 'https://ok.example/' }),
      block('wait', { ms: 0 }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.errors.length).toBeGreaterThan(0);
  });
});

describe('moveBlock', () => {
  const three: WorkflowBlock[] = [
    block('navigate', { url: 'https://a/' }),
    block('wait', { ms: 1 }),
    block('screenshot', {}),
  ];

  it('moves blocks up and down', () => {
    expect(moveBlock(three, 1, -1).map((b) => b.type)).toEqual(['wait', 'navigate', 'screenshot']);
    expect(moveBlock(three, 1, 1).map((b) => b.type)).toEqual(['navigate', 'screenshot', 'wait']);
  });

  it('no-ops at the edges and for bad indexes', () => {
    expect(moveBlock(three, 0, -1)).toBe(three);
    expect(moveBlock(three, 2, 1)).toBe(three);
    expect(moveBlock(three, 9, 1)).toBe(three);
  });

  it('does not mutate the input array', () => {
    const moved = moveBlock(three, 0, 1);
    expect(moved).not.toBe(three);
    expect(three[0]?.type).toBe('navigate');
  });
});

describe('blocksToSteps / stepsToBlocks', () => {
  it('serializes blocks to Phase 2 step JSON', () => {
    const steps = blocksToSteps([
      block('navigate', { url: 'https://example.com/' }),
      block('wait', { ms: 500 }),
      block('waitForSelector', { selector: '#x' }),
      block('evaluate', { expression: '1+1', timeoutMs: 2000 }),
      block('getText', { selector: 'h1', timeoutMs: 2000 }),
      block('screenshot', { fullPage: true }),
    ]);
    expect(steps).toEqual([
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'wait', ms: 500 },
      { type: 'waitForSelector', selector: '#x' },
      { type: 'evaluate', expression: '1+1', timeoutMs: 2000 },
      { type: 'getText', selector: 'h1', timeoutMs: 2000 },
      { type: 'screenshot', fullPage: true },
    ]);
  });

  it('omits unset optional fields', () => {
    const steps = blocksToSteps([block('screenshot', {}), block('getText', { selector: 'p' })]);
    expect(steps).toEqual([{ type: 'screenshot' }, { type: 'getText', selector: 'p' }]);
  });

  it('round-trips steps through the editor model', () => {
    const steps = [
      { type: 'navigate', url: 'https://example.com/' },
      { type: 'wait', ms: 250 },
      { type: 'screenshot', fullPage: false },
    ];
    const roundTripped = blocksToSteps(stepsToBlocks(steps));
    expect(roundTripped).toEqual(steps);
  });

  it('loads every API step field back into blocks', () => {
    const blocks = stepsToBlocks([
      { type: 'waitForSelector', selector: '.a', timeoutMs: 7000 },
      { type: 'evaluate', expression: 'document.title', timeoutMs: 3000 },
    ]);
    expect(blocks[0]?.fields).toEqual({ selector: '.a', timeoutMs: 7000 });
    expect(blocks[1]?.fields).toEqual({ expression: 'document.title', timeoutMs: 3000 });
  });

  it('keeps unknown step types as raw passthroughs instead of dropping them', () => {
    const steps = [
      { type: 'wait', ms: 100 },
      { type: 'future-step', config: { a: 1 } },
    ];
    const blocks = stepsToBlocks(steps);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.raw).toEqual({ type: 'future-step', config: { a: 1 } });
    expect(blocksToSteps(blocks)).toEqual(steps);
  });

  it('skips non-object steps', () => {
    expect(stepsToBlocks([null, 'nope', 42, { type: 'wait', ms: 5 }])).toHaveLength(1);
  });
});
