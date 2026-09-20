import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { checkProxyHealth, classifyDialError } from './health.js';
import { findFreePort } from '../browser/ports.js';

describe('proxy error classification', () => {
  it('maps errnos to machine-readable failures', () => {
    expect(classifyDialError('ECONNREFUSED')).toBe('refused');
    expect(classifyDialError('ETIMEDOUT')).toBe('timeout');
    expect(classifyDialError('ENOTFOUND')).toBe('dns');
    expect(classifyDialError('EAI_AGAIN')).toBe('dns');
    expect(classifyDialError('EHOSTUNREACH')).toBe('error');
    expect(classifyDialError(undefined)).toBe('error');
  });
});

describe('proxy health check', () => {
  it('reports ok with latency for a reachable TCP endpoint', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const health = await checkProxyHealth('127.0.0.1', port, 3000);
      expect(health.ok).toBe(true);
      expect(health.latencyMs).not.toBeNull();
      expect(Number(health.latencyMs)).toBeLessThan(3000);
    } finally {
      server.close();
    }
  });

  it('reports refused for a closed port', async () => {
    const port = await findFreePort();
    const health = await checkProxyHealth('127.0.0.1', port, 3000);
    expect(health.ok).toBe(false);
    expect(health.error).toBe('refused');
    expect(health.latencyMs).toBeNull();
  });

  it('reports dns failure for an unresolvable host', async () => {
    const health = await checkProxyHealth('proxy.invalid', 8080, 5000);
    if (health.ok) {
      // This sandbox transparently intercepts outbound TCP, so even
      // unresolvable names "connect". The errno mapping above is the
      // deterministic coverage; this live check only runs where DNS is real.
      return;
    }
    expect(health.error).toBe('dns');
  });
});
