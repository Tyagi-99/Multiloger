/**
 * Tests for the raw-CDP client (browser/cdp.ts), written first.
 *
 * A fake CDP server speaks just enough of the protocol: /json/version over
 * HTTP and a WebSocket upgrade that answers Browser.close according to the
 * configured behavior.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeClientFrame, encodeTextFrame } from '../server/websocket.js';
import { findFreePort } from './ports.js';
import { closeBrowserViaCdp, getDebuggerWsUrl, sendCdpCommand } from './cdp.js';

type CloseBehavior = 'ack' | 'ack-then-close' | 'close-no-ack' | 'never';

interface FakeCdp {
  cdpUrl: string;
  received: { id: number; method: string }[];
  shutdown: () => Promise<void>;
}

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

/** Minimal fake CDP endpoint: /json/version + WebSocket upgrade. */
async function startFakeCdp(behavior: CloseBehavior): Promise<FakeCdp> {
  const port = await findFreePort();
  const received: { id: number; method: string }[] = [];

  const server: HttpServer = createServer((socket: Socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    let wsBuffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const text = head.toString('utf8');
        if (!text.includes('\r\n\r\n')) {
          return;
        }
        const [requestLine, ...headerLines] = text.split('\r\n');
        const target = (requestLine ?? '').split(' ')[1] ?? '';
        if (text.includes('Upgrade: websocket')) {
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
        if (target === '/json/version') {
          const body = JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
          });
          socket.write(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\nconnection: close\r\n\r\n${body}`,
          );
          socket.end();
          return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
        socket.end();
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
        let msg: { id?: number; method?: string };
        try {
          msg = JSON.parse(frame.payload.toString('utf8')) as { id?: number; method?: string };
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && typeof msg.method === 'string') {
          received.push({ id: msg.id, method: msg.method });
          if (msg.method === 'Browser.close') {
            if (behavior === 'ack' || behavior === 'ack-then-close') {
              socket.write(encodeTextFrame(Buffer.from(JSON.stringify({ id: msg.id, result: {} }), 'utf8')));
            }
            if (behavior === 'ack-then-close' || behavior === 'close-no-ack') {
              // Browser exits because of the close: the debugger socket dies.
              setImmediate(() => socket.destroy());
            }
            // 'never': stay silent and keep the socket open (client must time out).
          } else {
            socket.write(
              encodeTextFrame(Buffer.from(JSON.stringify({ id: msg.id, result: { ok: true } }), 'utf8')),
            );
          }
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
    cdpUrl: `http://127.0.0.1:${String(port)}`,
    received,
    shutdown: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
        resolve();
      });
      }),
  };
}

const fakes: FakeCdp[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) {
    await fake.shutdown();
  }
});

async function withFake(behavior: CloseBehavior): Promise<FakeCdp> {
  const fake = await startFakeCdp(behavior);
  fakes.push(fake);
  return fake;
}

describe('getDebuggerWsUrl', () => {
  it('reads webSocketDebuggerUrl from /json/version', async () => {
    const fake = await withFake('ack');
    const wsUrl = await getDebuggerWsUrl(fake.cdpUrl, 2000);
    expect(wsUrl).toBe(`ws://127.0.0.1:${new URL(fake.cdpUrl).port}/devtools/browser/fake`);
  });

  it('rejects when the endpoint is unreachable', async () => {
    const port = await findFreePort();
    await expect(getDebuggerWsUrl(`http://127.0.0.1:${String(port)}`, 500)).rejects.toThrow();
  });
});

describe('sendCdpCommand', () => {
  it('round-trips a command and returns the result', async () => {
    const fake = await withFake('ack');
    const wsUrl = await getDebuggerWsUrl(fake.cdpUrl, 2000);
    const result = await sendCdpCommand(wsUrl, 'Target.getTargets', {}, 2000);
    expect(result).toEqual({ ok: true });
    expect(fake.received.map((r) => r.method)).toContain('Target.getTargets');
  });

  it('rejects when the command times out', async () => {
    const fake = await withFake('never');
    const wsUrl = await getDebuggerWsUrl(fake.cdpUrl, 2000);
    await expect(sendCdpCommand(wsUrl, 'Browser.close', {}, 400)).rejects.toThrow(/timed out/i);
  });

  it('rejects when the socket closes before a response', async () => {
    const fake = await withFake('close-no-ack');
    const wsUrl = await getDebuggerWsUrl(fake.cdpUrl, 2000);
    // The fake only drops the socket on Browser.close; use another method and
    // destroy via close-no-ack semantics by sending Browser.close itself.
    await expect(sendCdpCommand(wsUrl, 'Browser.close', {}, 2000)).rejects.toThrow(/closed/i);
  });
});

describe('closeBrowserViaCdp', () => {
  it('sends Browser.close and returns true on acknowledgement', async () => {
    const fake = await withFake('ack');
    await expect(closeBrowserViaCdp(fake.cdpUrl, 2000)).resolves.toBe(true);
    expect(fake.received.map((r) => r.method)).toEqual(['Browser.close']);
  });

  it('returns true when the browser socket dies right after the close', async () => {
    const fake = await withFake('ack-then-close');
    await expect(closeBrowserViaCdp(fake.cdpUrl, 2000)).resolves.toBe(true);
  });

  it('returns true when the socket drops without an ack (browser exited from the close)', async () => {
    const fake = await withFake('close-no-ack');
    await expect(closeBrowserViaCdp(fake.cdpUrl, 2000)).resolves.toBe(true);
  });

  it('returns false (never throws) when the browser never answers', async () => {
    const fake = await withFake('never');
    await expect(closeBrowserViaCdp(fake.cdpUrl, 400)).resolves.toBe(false);
  });

  it('returns false (never throws) when nothing listens', async () => {
    const port = await findFreePort();
    await expect(closeBrowserViaCdp(`http://127.0.0.1:${String(port)}`, 400)).resolves.toBe(false);
  });
});
