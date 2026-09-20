import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  legalSuccessors,
  parseProfileState,
  PROFILE_STATES,
  UnknownProfileStateError,
  type ProfileState,
} from './states.js';

describe('transition table', () => {
  it('allows exactly the documented legal transitions', () => {
    const legal: [ProfileState, ProfileState][] = [
      ['created', 'launching'],
      ['launching', 'running'],
      ['launching', 'stopping'],
      ['launching', 'error'],
      ['launching', 'crashed'],
      ['running', 'stopping'],
      ['running', 'error'],
      ['running', 'crashed'],
      ['stopping', 'stopped'],
      ['stopping', 'error'],
      ['stopping', 'crashed'],
      ['stopped', 'launching'],
      ['error', 'launching'],
      ['error', 'stopped'],
      ['crashed', 'launching'],
      ['crashed', 'stopped'],
    ];
    for (const [from, to] of legal) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
    expect(legal).toHaveLength(16);
  });

  it('rejects every other pair in the full matrix', () => {
    let legalCount = 0;
    for (const from of PROFILE_STATES) {
      for (const to of PROFILE_STATES) {
        if (canTransition(from, to)) {
          legalCount++;
        } else {
          expect(() => {
            assertTransition(from, to);
          }).toThrow(IllegalTransitionError);
          try {
            assertTransition(from, to);
          } catch (error) {
            expect(error).toBeInstanceOf(IllegalTransitionError);
            expect((error as IllegalTransitionError).from).toBe(from);
            expect((error as IllegalTransitionError).to).toBe(to);
          }
        }
      }
    }
    expect(legalCount).toBe(16);
  });

  it('never allows a self-transition', () => {
    for (const state of PROFILE_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('exposes legal successors', () => {
    expect(legalSuccessors('running')).toEqual(['stopping', 'error', 'crashed']);
    expect(legalSuccessors('stopped')).toEqual(['launching']);
  });
});

describe('parseProfileState', () => {
  it('parses known states', () => {
    expect(parseProfileState('running')).toBe('running');
  });

  it('throws on unknown states', () => {
    expect(() => parseProfileState('flying')).toThrow(UnknownProfileStateError);
  });
});
