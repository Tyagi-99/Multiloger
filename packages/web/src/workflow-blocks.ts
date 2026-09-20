/**
 * No-code workflow builder block model (Phase 4d).
 *
 * Blocks are the visual editor's unit; they serialize to the exact Phase 2
 * automation script JSON (see packages/api/src/automation/script.ts) and
 * back. This module is pure: no React, no network — fully unit-testable.
 *
 * Validation mirrors the API's bounds so the editor rejects what the
 * server would reject, before any network call:
 * - at most 50 blocks per script
 * - navigate: http/https/data URLs only, no embedded credentials
 * - wait: 1–60000 ms
 * - waitForSelector/getText: non-empty selector (≤500), optional timeout 1–120000 ms
 * - evaluate: non-empty expression (≤10000), optional timeout 1–120000 ms
 * - screenshot: optional fullPage boolean
 */

export type BlockType =
  'navigate' | 'wait' | 'waitForSelector' | 'evaluate' | 'getText' | 'screenshot';

export const BLOCK_TYPES: BlockType[] = [
  'navigate',
  'wait',
  'waitForSelector',
  'evaluate',
  'getText',
  'screenshot',
];

export const MAX_BLOCKS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_SELECTOR_LENGTH = 500;
const MAX_EXPRESSION_LENGTH = 10_000;
const MAX_WAIT_MS = 60_000;
const MAX_STEP_TIMEOUT_MS = 120_000;

export const BLOCK_LABELS: Record<BlockType, string> = {
  navigate: 'Navigate',
  wait: 'Wait',
  waitForSelector: 'Wait for selector',
  evaluate: 'Evaluate JS',
  getText: 'Get text',
  screenshot: 'Screenshot',
};

export const BLOCK_DESCRIPTIONS: Record<BlockType, string> = {
  navigate: 'Load a URL in the automation tab (http/https/data only).',
  wait: 'Sleep a bounded number of milliseconds.',
  waitForSelector: 'Poll for a CSS selector to appear (bounded).',
  evaluate: 'Run a JS expression in the page, return the JSON value.',
  getText: 'Return the innerText of the first matching element.',
  screenshot: 'Capture a PNG, stored as a run artifact.',
};

/**
 * Block fields. Every field is explicitly `| undefined` so the editor can
 * clear an optional field by setting it to undefined; serializers treat
 * undefined as absent (JSON.stringify drops it, and blocksToSteps skips
 * undefined optionals).
 */
export interface WorkflowBlockFields {
  url?: string | undefined;
  ms?: number | undefined;
  selector?: string | undefined;
  expression?: string | undefined;
  timeoutMs?: number | undefined;
  fullPage?: boolean | undefined;
}

export interface WorkflowBlock {
  /** Editor-local id; never sent to the API. */
  id: string;
  type: BlockType;
  fields: WorkflowBlockFields;
  /**
   * Set when the block was loaded from a script step the editor does not
   * model (forward-compat): the raw step is kept verbatim and round-trips
   * through blocksToSteps untouched instead of being silently dropped.
   */
  raw?: Record<string, unknown>;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `block-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const DEFAULT_FIELDS: Record<BlockType, WorkflowBlockFields> = {
  navigate: { url: 'https://example.com/' },
  wait: { ms: 1000 },
  waitForSelector: { selector: '' },
  evaluate: { expression: 'document.title' },
  getText: { selector: '' },
  screenshot: { fullPage: false },
};

/** Create a fresh block of the given type with sensible defaults. */
export function createBlock(type: BlockType): WorkflowBlock {
  return { id: newId(), type, fields: { ...DEFAULT_FIELDS[type] } };
}

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function validateNavigateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'must be a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:') {
    return `must use http, https, or data (got '${parsed.protocol}')`;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return 'must not embed credentials';
  }
  return null;
}

/** Validate one block's fields. Returns error messages (empty = valid). */
export function validateBlock(block: WorkflowBlock): string[] {
  // Forward-compat passthroughs are the server's validated JSON already.
  if (block.raw !== undefined) {
    return [];
  }
  const errors: string[] = [];
  const f = block.fields;
  switch (block.type) {
    case 'navigate': {
      const url = f.url ?? '';
      if (url.length === 0) {
        errors.push('URL is required');
      } else if (url.length > MAX_URL_LENGTH) {
        errors.push(`URL exceeds max length ${String(MAX_URL_LENGTH)}`);
      } else {
        const problem = validateNavigateUrl(url);
        if (problem) {
          errors.push(`URL ${problem}`);
        }
      }
      break;
    }
    case 'wait': {
      if (!isPositiveInt(f.ms, MAX_WAIT_MS)) {
        errors.push(`Wait must be an integer 1-${String(MAX_WAIT_MS)} ms`);
      }
      break;
    }
    case 'waitForSelector':
    case 'getText': {
      const selector = f.selector ?? '';
      if (selector.length === 0) {
        errors.push('CSS selector is required');
      } else if (selector.length > MAX_SELECTOR_LENGTH) {
        errors.push(`Selector exceeds max length ${String(MAX_SELECTOR_LENGTH)}`);
      }
      if (f.timeoutMs !== undefined && !isPositiveInt(f.timeoutMs, MAX_STEP_TIMEOUT_MS)) {
        errors.push(`Timeout must be an integer 1-${String(MAX_STEP_TIMEOUT_MS)} ms`);
      }
      break;
    }
    case 'evaluate': {
      const expression = f.expression ?? '';
      if (expression.length === 0) {
        errors.push('JS expression is required');
      } else if (expression.length > MAX_EXPRESSION_LENGTH) {
        errors.push(`Expression exceeds max length ${String(MAX_EXPRESSION_LENGTH)}`);
      }
      if (f.timeoutMs !== undefined && !isPositiveInt(f.timeoutMs, MAX_STEP_TIMEOUT_MS)) {
        errors.push(`Timeout must be an integer 1-${String(MAX_STEP_TIMEOUT_MS)} ms`);
      }
      break;
    }
    case 'screenshot': {
      if (f.fullPage !== undefined && typeof f.fullPage !== 'boolean') {
        errors.push('Full page must be a boolean');
      }
      break;
    }
  }
  return errors;
}

/**
 * Validate a whole block list. Returns `{index, errors}` entries;
 * an empty array means the list serializes to a valid script.
 */
export function validateBlocks(blocks: WorkflowBlock[]): { index: number; errors: string[] }[] {
  const problems: { index: number; errors: string[] }[] = [];
  if (blocks.length === 0) {
    problems.push({ index: -1, errors: ['Add at least one block'] });
  }
  if (blocks.length > MAX_BLOCKS) {
    problems.push({ index: -1, errors: [`At most ${String(MAX_BLOCKS)} blocks per script`] });
  }
  blocks.forEach((block, index) => {
    const errors = validateBlock(block);
    if (errors.length > 0) {
      problems.push({ index, errors });
    }
  });
  return problems;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Serialize editor blocks to Phase 2 script step JSON. Assumes the blocks
 * passed validation; fields that failed validation are omitted or coerced
 * the same way the API's validator would accept them.
 */
export function blocksToSteps(blocks: WorkflowBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    // Forward-compat: unknown steps round-trip untouched.
    if (block.raw !== undefined) {
      return block.raw;
    }
    const f = block.fields;
    switch (block.type) {
      case 'navigate':
        return { type: 'navigate', url: f.url ?? '' };
      case 'wait':
        return { type: 'wait', ms: f.ms ?? 0 };
      case 'waitForSelector': {
        const step: { type: string; selector: string; timeoutMs?: number } = {
          type: 'waitForSelector',
          selector: f.selector ?? '',
        };
        if (defined(f.timeoutMs)) {
          step.timeoutMs = f.timeoutMs;
        }
        return step;
      }
      case 'evaluate': {
        const step: { type: string; expression: string; timeoutMs?: number } = {
          type: 'evaluate',
          expression: f.expression ?? '',
        };
        if (defined(f.timeoutMs)) {
          step.timeoutMs = f.timeoutMs;
        }
        return step;
      }
      case 'getText': {
        const step: { type: string; selector: string; timeoutMs?: number } = {
          type: 'getText',
          selector: f.selector ?? '',
        };
        if (defined(f.timeoutMs)) {
          step.timeoutMs = f.timeoutMs;
        }
        return step;
      }
      case 'screenshot': {
        const step: { type: string; fullPage?: boolean } = { type: 'screenshot' };
        if (defined(f.fullPage)) {
          step.fullPage = f.fullPage;
        }
        return step;
      }
    }
  });
}

/** A raw script step object with unknown field shapes. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- type alias (not interface) so it is assignable to Record<string, unknown> for WorkflowBlock.raw
type RawStep = {
  type: unknown;
  url?: unknown;
  ms?: unknown;
  selector?: unknown;
  expression?: unknown;
  timeoutMs?: unknown;
  fullPage?: unknown;
};

function asRecord(value: unknown): RawStep | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RawStep)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Load Phase 2 script steps back into editor blocks (e.g. opening an
 * existing script version). Step types the editor does not model are kept
 * as raw passthrough blocks: shown read-only and serialized back
 * untouched, never silently dropped.
 */
export function stepsToBlocks(steps: unknown[]): WorkflowBlock[] {
  const blocks: WorkflowBlock[] = [];
  for (const raw of steps) {
    const step = asRecord(raw);
    if (step === null) {
      continue;
    }
    if (typeof step.type !== 'string' || !BLOCK_TYPES.includes(step.type as BlockType)) {
      blocks.push({ id: newId(), type: 'navigate', fields: {}, raw: step });
      continue;
    }
    const blockType = step.type as BlockType;
    const fields: WorkflowBlockFields = {};
    switch (blockType) {
      case 'navigate': {
        const url = asString(step.url);
        if (url !== undefined) {
          fields.url = url;
        }
        break;
      }
      case 'wait': {
        const ms = asNumber(step.ms);
        if (ms !== undefined) {
          fields.ms = ms;
        }
        break;
      }
      case 'waitForSelector':
      case 'getText': {
        const selector = asString(step.selector);
        if (selector !== undefined) {
          fields.selector = selector;
        }
        const timeoutMs = asNumber(step.timeoutMs);
        if (timeoutMs !== undefined) {
          fields.timeoutMs = timeoutMs;
        }
        break;
      }
      case 'evaluate': {
        const expression = asString(step.expression);
        if (expression !== undefined) {
          fields.expression = expression;
        }
        const timeoutMs = asNumber(step.timeoutMs);
        if (timeoutMs !== undefined) {
          fields.timeoutMs = timeoutMs;
        }
        break;
      }
      case 'screenshot': {
        if (typeof step.fullPage === 'boolean') {
          fields.fullPage = step.fullPage;
        }
        break;
      }
    }
    blocks.push({ id: newId(), type: blockType, fields });
  }
  return blocks;
}

/** Move a block up (-1) or down (+1) one position; no-ops at the edges. */
export function moveBlock(
  blocks: WorkflowBlock[],
  index: number,
  direction: -1 | 1,
): WorkflowBlock[] {
  const target = index + direction;
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) {
    return blocks;
  }
  const next = [...blocks];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) {
    next.splice(target, 0, moved);
  }
  return next;
}
