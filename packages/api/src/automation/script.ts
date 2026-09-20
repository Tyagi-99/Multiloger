/**
 * Automation script language (Phase 2a).
 *
 * Scripts are STORED DATA, never code: a JSON array of declarative steps.
 * The runner maps each step to a fixed, allowlisted set of CDP commands —
 * there is no eval of script text, no dynamic method names, no way for a
 * script to reach outside the step types below.
 *
 * Trust model: script authors are trusted operators (creating a script
 * requires a valid API token; Phase 3 RBAC will gate who may do it). The
 * `evaluate` step runs JavaScript inside the automated page with a bounded
 * timeout — it is the operator's own browser, equivalent to typing in
 * DevTools. It must never be exposed to untrusted third-party input.
 *
 * Step types:
 * - navigate      — load a URL in the automation tab (http/https/data only).
 * - wait          — sleep a bounded number of milliseconds.
 * - waitForSelector — poll for a CSS selector to appear (bounded).
 * - evaluate      — run a JS expression in the page, return the JSON value.
 * - getText       — return the innerText of the first matching element.
 * - screenshot    — capture a PNG; stored as a run artifact on disk.
 */

export interface NavigateStep {
  type: 'navigate';
  url: string;
}

export interface WaitStep {
  type: 'wait';
  ms: number;
}

export interface WaitForSelectorStep {
  type: 'waitForSelector';
  selector: string;
  timeoutMs?: number;
}

export interface EvaluateStep {
  type: 'evaluate';
  expression: string;
  timeoutMs?: number;
}

export interface GetTextStep {
  type: 'getText';
  selector: string;
  timeoutMs?: number;
}

export interface ScreenshotStep {
  type: 'screenshot';
  fullPage?: boolean;
}

export type AutomationStep =
  NavigateStep | WaitStep | WaitForSelectorStep | EvaluateStep | GetTextStep | ScreenshotStep;

export const STEP_TYPES = [
  'navigate',
  'wait',
  'waitForSelector',
  'evaluate',
  'getText',
  'screenshot',
] as const;

export const MAX_STEPS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_SELECTOR_LENGTH = 500;
const MAX_EXPRESSION_LENGTH = 10_000;
const MAX_WAIT_MS = 60_000;
const MAX_STEP_TIMEOUT_MS = 120_000;

export class ScriptValidationError extends Error {
  readonly code = 'INVALID_SCRIPT';
  constructor(message: string) {
    super(message);
    this.name = 'ScriptValidationError';
  }
}

function fail(stepIndex: number, message: string): never {
  throw new ScriptValidationError(`Step ${String(stepIndex)}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInt(value: unknown, stepIndex: number, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    fail(stepIndex, `field '${field}' must be an integer 1-${String(max)}`);
  }
  return value;
}

function optionalPositiveInt(
  value: unknown,
  stepIndex: number,
  field: string,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requirePositiveInt(value, stepIndex, field, max);
}

function requireString(
  value: unknown,
  stepIndex: number,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(stepIndex, `field '${field}' must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail(stepIndex, `field '${field}' exceeds max length ${String(maxLength)}`);
  }
  return value;
}

/**
 * Only http(s) navigations and inert data: pages are allowed: no
 * javascript:, file:, or about: URLs, and no embedded credentials (which
 * would leak secrets into script JSON and logs). data: URLs are permitted
 * because they make no network requests (zero SSRF surface) and give
 * operators deterministic synthetic pages; they are also the only reliable
 * local target because Chromium's Local Network Access checks block
 * CDP-driven top-level navigations from the automation tab (an opaque-origin
 * initiator) to private-network addresses such as 127.0.0.1.
 */
function validateNavigateUrl(url: string, stepIndex: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(stepIndex, `field 'url' is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:') {
    fail(stepIndex, `field 'url' must use http, https, or data (got '${parsed.protocol}')`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    fail(stepIndex, `field 'url' must not embed credentials`);
  }
  return url;
}

function validateStep(raw: unknown, stepIndex: number): AutomationStep {
  if (!isRecord(raw)) {
    fail(stepIndex, 'must be an object');
  }
  const type = raw.type;
  if (typeof type !== 'string' || !(STEP_TYPES as readonly string[]).includes(type)) {
    fail(stepIndex, `unknown step type '${String(type)}' (allowed: ${STEP_TYPES.join(', ')})`);
  }
  switch (type) {
    case 'navigate': {
      const url = requireString(raw.url, stepIndex, 'url', MAX_URL_LENGTH);
      return { type: 'navigate', url: validateNavigateUrl(url, stepIndex) };
    }
    case 'wait': {
      const ms = requirePositiveInt(raw.ms, stepIndex, 'ms', MAX_WAIT_MS);
      return { type: 'wait', ms };
    }
    case 'waitForSelector': {
      const selector = requireString(raw.selector, stepIndex, 'selector', MAX_SELECTOR_LENGTH);
      const timeoutMs = optionalPositiveInt(
        raw.timeoutMs,
        stepIndex,
        'timeoutMs',
        MAX_STEP_TIMEOUT_MS,
      );
      return timeoutMs === undefined
        ? { type: 'waitForSelector', selector }
        : { type: 'waitForSelector', selector, timeoutMs };
    }
    case 'evaluate': {
      const expression = requireString(
        raw.expression,
        stepIndex,
        'expression',
        MAX_EXPRESSION_LENGTH,
      );
      const timeoutMs = optionalPositiveInt(
        raw.timeoutMs,
        stepIndex,
        'timeoutMs',
        MAX_STEP_TIMEOUT_MS,
      );
      return timeoutMs === undefined
        ? { type: 'evaluate', expression }
        : { type: 'evaluate', expression, timeoutMs };
    }
    case 'getText': {
      const selector = requireString(raw.selector, stepIndex, 'selector', MAX_SELECTOR_LENGTH);
      const timeoutMs = optionalPositiveInt(
        raw.timeoutMs,
        stepIndex,
        'timeoutMs',
        MAX_STEP_TIMEOUT_MS,
      );
      return timeoutMs === undefined
        ? { type: 'getText', selector }
        : { type: 'getText', selector, timeoutMs };
    }
    case 'screenshot': {
      const fullPage = raw.fullPage;
      if (fullPage !== undefined && typeof fullPage !== 'boolean') {
        fail(stepIndex, `field 'fullPage' must be a boolean`);
      }
      return fullPage === undefined ? { type: 'screenshot' } : { type: 'screenshot', fullPage };
    }
    default:
      // Unreachable: the type check above rejects unknown types, but the
      // switch keeps the compiler honest about exhaustiveness.
      fail(stepIndex, `unknown step type '${type}'`);
  }
}

/**
 * Validate + normalize raw JSON into AutomationStep[]. Throws
 * ScriptValidationError on the first problem found.
 */
export function validateSteps(raw: unknown): AutomationStep[] {
  if (!Array.isArray(raw)) {
    throw new ScriptValidationError('Script steps must be a JSON array');
  }
  if (raw.length === 0) {
    throw new ScriptValidationError('Script must contain at least one step');
  }
  if (raw.length > MAX_STEPS) {
    throw new ScriptValidationError(`Script has too many steps (max ${String(MAX_STEPS)})`);
  }
  return raw.map((step, index) => validateStep(step, index));
}

/** Result of one executed step, persisted in the run's result JSON. */
export interface StepResult {
  index: number;
  type: string;
  ok: boolean;
  /** Milliseconds the step took. */
  durationMs: number;
  /**
   * Step output (evaluate/getText return value, screenshot artifact name).
   * Capped by the runner; never contains secrets (scripts carry none).
   */
  output?: unknown;
}

/** One screenshot captured by a run, stored on disk under the data dir. */
export interface ScreenshotArtifact {
  /** Server-generated file name (`<stepIndex>.png`). */
  name: string;
  /** Decoded PNG byte length. */
  sizeBytes: number;
}

/** Persisted per-run outcome. */
export interface AutomationResult {
  steps: StepResult[];
  /** Screenshots captured by the run, in step order. */
  artifacts: ScreenshotArtifact[];
}

/** One capped log line persisted with the run. */
export interface AutomationLogEntry {
  at: string;
  stepIndex: number;
  message: string;
}
