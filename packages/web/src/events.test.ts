/** Tests for WebSocket event parsing (no socket needed). */

import { describe, expect, it } from 'vitest';
import { parseEventMessage } from './events.js';

describe('parseEventMessage', () => {
  it('passes a domain event through', () => {
    const event = parseEventMessage(
      JSON.stringify({ type: 'profile.state-changed', profileId: 'p1', to: 'running' }),
    );
    expect(event).toEqual({ type: 'profile.state-changed', profileId: 'p1', to: 'running' });
  });

  it('drops the hello handshake frame', () => {
    expect(parseEventMessage(JSON.stringify({ type: 'hello', tokenId: 't1' }))).toBeNull();
  });

  it('drops malformed JSON', () => {
    expect(parseEventMessage('not json {')).toBeNull();
  });

  it('drops non-object payloads', () => {
    expect(parseEventMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseEventMessage(JSON.stringify('hello'))).toBeNull();
    expect(parseEventMessage(JSON.stringify(null))).toBeNull();
  });

  it('drops events without a usable type', () => {
    expect(parseEventMessage(JSON.stringify({ profileId: 'p1' }))).toBeNull();
    expect(parseEventMessage(JSON.stringify({ type: '' }))).toBeNull();
    expect(parseEventMessage(JSON.stringify({ type: 42 }))).toBeNull();
  });

  it('drops non-string message data', () => {
    expect(parseEventMessage(undefined)).toBeNull();
    expect(parseEventMessage(null)).toBeNull();
    expect(parseEventMessage(42)).toBeNull();
  });
});
