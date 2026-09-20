/**
 * Typed domain events for profile lifecycle changes.
 *
 * The state machine emits through this singleton; the WebSocket layer
 * (Task 7) subscribes and forwards to dashboard clients. Kept as a tiny
 * hand-rolled emitter (instead of node:events) so payloads stay strictly
 * typed and no stringly-typed event names leak across the codebase.
 */

import type { ProfileState } from './states.js';

export interface ProfileStateChangedEvent {
  type: 'profile.state-changed';
  profileId: string;
  from: ProfileState;
  to: ProfileState;
  /** ISO-8601 timestamp of the transition. */
  at: string;
}

export interface ProfileLockEvent {
  type: 'profile.lock-acquired' | 'profile.lock-released';
  profileId: string;
  owner: string;
  at: string;
}

export type ProfileDomainEvent = ProfileStateChangedEvent | ProfileLockEvent;

export type ProfileEventListener = (event: ProfileDomainEvent) => void;

export class ProfileEventEmitter {
  private readonly listeners = new Set<ProfileEventListener>();

  on(listener: ProfileEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ProfileDomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the state machine.
      }
    }
  }
}

/** Process-wide singleton. */
export const profileEvents = new ProfileEventEmitter();
