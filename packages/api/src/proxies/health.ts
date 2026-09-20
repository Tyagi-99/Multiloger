/**
 * Proxy health checks. MVP scope is deliberately narrow and honest:
 * a TCP connect to host:port proves the endpoint is reachable, NOT that it
 * is a working proxy (no HTTP CONNECT / SOCKS handshake validation yet).
 * A failed check blocks launch fail-closed, which is the safe direction —
 * better to refuse than to launch a profile on its real IP.
 */

import { connect } from 'node:net';

export interface ProxyHealth {
  ok: boolean;
  /** TCP connect latency in ms; null when the check failed. */
  latencyMs: number | null;
  /** Machine-readable failure: 'timeout' | 'refused' | 'dns' | 'error'. */
  error?: string;
  detail?: string;
}

/** Map a dial errno to a machine-readable health failure. Pure; unit-tested. */
export function classifyDialError(
  code: string | undefined,
): 'timeout' | 'refused' | 'dns' | 'error' {
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ETIMEDOUT':
      return 'timeout';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'dns';
    default:
      return 'error';
  }
}

export function checkProxyHealth(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<ProxyHealth> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (health: ProxyHealth): void => {
      if (!settled) {
        settled = true;
        resolve(health);
      }
    };

    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      done({ ok: false, latencyMs: null, error: 'timeout', detail: `no TCP response in ${String(timeoutMs)}ms` });
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      done({ ok: true, latencyMs: Date.now() - start });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      done({
        ok: false,
        latencyMs: null,
        error: classifyDialError(error.code),
        detail: error.message,
      });
    });
  });
}
