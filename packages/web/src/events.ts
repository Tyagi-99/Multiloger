/**
 * Authenticated WebSocket subscription to /v1/events. The token travels in
 * the upgrade query string (per the API's websocket.ts contract); over plain
 * ws:// on localhost this is acceptable, over the network use wss://.
 *
 * Pure parsing lives in parseEventMessage so it is unit-testable without a
 * socket. The hook reconnects with backoff and surfaces connection status.
 */

import { useEffect, useRef, useState } from 'react';
import type { DomainEvent } from './types.js';

/** Parse one raw WebSocket message into a domain event, or null if unusable. */
export function parseEventMessage(data: unknown): DomainEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0) {
    return null;
  }
  if (type === 'hello') {
    // Handshake frame, not a domain event.
    return null;
  }
  return { ...(parsed as Record<string, unknown>), type };
}

export type EventsStatus = 'connecting' | 'connected' | 'reconnecting' | 'disabled';

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

function eventsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/v1/events`;
}

/**
 * Subscribe to domain events. Calls onEvent for every event except the
 * hello handshake. Reconnects automatically while a token is set.
 */
export function useEvents(
  token: string | null,
  onEvent: (event: DomainEvent) => void,
): EventsStatus {
  const [status, setStatus] = useState<EventsStatus>(token ? 'connecting' : 'disabled');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!token) {
      setStatus('disabled');
      return;
    }
    let stopped = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      if (stopped) {
        return;
      }
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(`${eventsUrl()}?token=${encodeURIComponent(token)}`);
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        if (!stopped) {
          setStatus('connected');
        }
      };
      ws.onmessage = (message: MessageEvent) => {
        const event = parseEventMessage(message.data);
        if (event) {
          onEventRef.current(event);
        }
      };
      ws.onclose = () => {
        socket = null;
        if (stopped) {
          return;
        }
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // onclose follows and drives the reconnect.
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      socket?.close();
    };
  }, [token]);

  return status;
}
