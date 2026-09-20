/**
 * Tests for the CDP proxy-auth handler (proxies/auth-handler.ts), written first.
 *
 * A fake CDP server asserts the Fetch.enable handshake (handleAuthRequests)
 * and the Fetch.authRequired → Fetch.continueWithAuth exchange: proxy
 * challenges get ProvideCredentials with the exact pair, server challenges
 * get Default and never see credential material.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeClientFrame, encodeTextFrame } from '../server/websocket.js';
import { findFreePort } from '../browser/ports.js';
import { attachProxyAuth } from './auth-handler.js';

// The handler only uses the real (pure) redactSecretsText from the vault
// module — no mocking needed.

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

type ChallengeSource = 'Proxy' | 'Server';

interface FakeAuthCdp {
  wsUrl: string;
  received: { method: string; params: unknown }[];
  enableParams: unknown;
  shutdown: () => Promise<void>;
}

/**
 * Fake CDP endpoint: acks every command; after acking Fetch.enable it emits
 * a Fetch.requestPaused (the upfront interception pause current Chromium
 * applies with handleAuthRequests) followed by Fetch.authRequired with the
 * configured challenge source. The wire values use the real CDP enum case
 * ("Proxy"/"Server").
 */
async function startFakeAuthCdp(source: ChallengeSource): Promise<FakeAuthCdp> {
  const port = await findFreePort();
  const received: FakeAuthCdp['received'] = [];
  let enableParams: unknown;

  const server: HttpServer = createServer((socket: Socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    let wsBuffer = Buffer.alloc(0);

    const emitAuthSequence = (): void => {
      socket.write(
        encodeTextFrame(
          Buffer.from(
            JSON.stringify({
              method: 'Fetch.requestPaused',
              params: { requestId: 'interception-job-1.0' },
            }),
            'utf8',
          ),
        ),
      );
      socket.write(
        encodeTextFrame(
          Buffer.from(
            JSON.stringify({
              method: 'Fetch.authRequired',
              params: {
                requestId: 'interception-job-1.0',
                authChallenge: { source, origin: 'http://127.0.0.1:8080' },
              },
            }),
            'utf8',
          ),
        ),
      );
    };

    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const text = head.toString('utf8');
        if (!text.includes('\r\n\r\n')) {
          return;
        }
        const headerLines = text.split('\r\n').slice(1);
        const keyLine = headerLines.find((l) => l.toLowerCase().startsWith('sec-websocket-key:'));
        const key = (keyLine ?? '').split(':')[1]?.trim() ?? '';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
        );
        upgraded = true;
        const rest = head.subarray(text.indexOf('\r\n\r\n') + 4);
        if (rest.length > 0) {
          wsBuffer = Buffer.concat([wsBuffer, rest]);
          socket.emit('data', Buffer.alloc(0));
        }
        return;
      }

      wsBuffer = Buffer.concat([wsBuffer, chunk]);
      for (;;) {
        const frame = decodeClientFrame(wsBuffer);
        if (frame.consumed === 0) {
          break;
        }
        wsBuffer = wsBuffer.subarray(frame.consumed);
        if (frame.opcode !== 0x1) {
          continue;
        }
        let msg: { id?: number; method?: string; params?: unknown };
        try {
          msg = JSON.parse(frame.payload.toString('utf8')) as {
            id?: number;
            method?: string;
            params?: unknown;
          };
        } catch {
          continue;
        }
        if (typeof msg.id !== 'number' || typeof msg.method !== 'string') {
          continue;
        }
        received.push({ method: msg.method, params: msg.params });
        socket.write(
          encodeTextFrame(Buffer.from(JSON.stringify({ id: msg.id, result: {} }), 'utf8')),
        );
        if (msg.method === 'Fetch.enable') {
          enableParams = msg.params;
          emitAuthSequence();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });

  return {
    wsUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
    received,
    get enableParams() {
      return enableParams;
    },
    shutdown: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function waitForMethod(
  received: FakeAuthCdp['received'],
  method: string,
  timeoutMs = 5000,
): Promise<{ method: string; params: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = received.find((r) => r.method === method);
    if (found) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${method}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const fakes: FakeAuthCdp[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) {
    await fake.shutdown();
  }
});

describe('attachProxyAuth', () => {
  it('enables Fetch with handleAuthRequests, continues paused requests, and answers proxy challenges with credentials', async () => {
    const fake = await startFakeAuthCdp('Proxy');
    fakes.push(fake);

    const handle = await attachProxyAuth(
      fake.wsUrl,
      () => ({ username: 'alice', password: 's3cret' }),
      { timeoutMs: 2000 },
    );
    try {
      expect(fake.enableParams).toEqual({ handleAuthRequests: true });
      // The upfront interception pause must be continued or the page hangs.
      const continued = await waitForMethod(fake.received, 'Fetch.continueRequest');
      expect(continued.params).toEqual({ requestId: 'interception-job-1.0' });
      const cont = await waitForMethod(fake.received, 'Fetch.continueWithAuth');
      expect(cont.params).toEqual({
        requestId: 'interception-job-1.0',
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'alice',
          password: 's3cret',
        },
      });
    } finally {
      handle.close();
      await handle.closed;
    }
  });

  it('answers non-proxy (server) challenges with Default and never sends credentials', async () => {
    const fake = await startFakeAuthCdp('Server');
    fakes.push(fake);

    const handle = await attachProxyAuth(
      fake.wsUrl,
      () => ({ username: 'alice', password: 's3cret' }),
      { timeoutMs: 2000 },
    );
    try {
      const cont = await waitForMethod(fake.received, 'Fetch.continueWithAuth');
      expect(cont.params).toEqual({
        requestId: 'interception-job-1.0',
        authChallengeResponse: { response: 'Default' },
      });
      // Belt and braces: no credential material anywhere on the wire.
      expect(JSON.stringify(fake.received)).not.toContain('s3cret');
      expect(JSON.stringify(fake.received)).not.toContain('alice');
    } finally {
      handle.close();
      await handle.closed;
    }
  });

  it('close() tears the session down and closed resolves', async () => {
    const fake = await startFakeAuthCdp('Proxy');
    fakes.push(fake);

    const handle = await attachProxyAuth(fake.wsUrl, () => ({ username: 'u', password: 'p' }), {
      timeoutMs: 2000,
    });
    handle.close();
    await handle.closed;
  });
});
