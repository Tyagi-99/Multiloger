/**
 * Profile lifecycle states and the legal transition table.
 *
 * States: created → launching → running → stopping → stopped,
 * plus error and crashed as failure states.
 *
 * Only the transitions listed in TRANSITIONS are legal. Everything else
 * throws IllegalTransitionError. The table is the single source of truth —
 * the state machine module enforces it, and the tests assert the full matrix.
 */

export const PROFILE_STATES = [
  'created',
  'launching',
  'running',
  'stopping',
  'stopped',
  'error',
  'crashed',
] as const;

export type ProfileState = (typeof PROFILE_STATES)[number];

const TRANSITIONS: Record<ProfileState, readonly ProfileState[]> = {
  created: ['launching'],
  launching: ['running', 'stopping', 'error', 'crashed'],
  running: ['stopping', 'error', 'crashed'],
  stopping: ['stopped', 'error', 'crashed'],
  stopped: ['launching'],
  error: ['launching', 'stopped'],
  crashed: ['launching', 'stopped'],
};

export class IllegalTransitionError extends Error {
  readonly from: ProfileState;
  readonly to: ProfileState;

  constructor(from: ProfileState, to: ProfileState) {
    super(`Illegal profile state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class UnknownProfileStateError extends Error {
  constructor(value: string) {
    super(`Unknown profile state: ${JSON.stringify(value)}`);
    this.name = 'UnknownProfileStateError';
  }
}

/** Parse a raw DB string into a ProfileState; throws on unknown values. */
export function parseProfileState(value: string): ProfileState {
  if ((PROFILE_STATES as readonly string[]).includes(value)) {
    return value as ProfileState;
  }
  throw new UnknownProfileStateError(value);
}

export function canTransition(from: ProfileState, to: ProfileState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws IllegalTransitionError when the transition is not legal. */
export function assertTransition(from: ProfileState, to: ProfileState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** All states that may legally follow `from` (useful for UI/API validation). */
export function legalSuccessors(from: ProfileState): readonly ProfileState[] {
  return TRANSITIONS[from];
}
