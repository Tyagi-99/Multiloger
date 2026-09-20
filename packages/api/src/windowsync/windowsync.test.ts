/**
 * Window sync tests (Phase 4c), written first.
 *
 * A fake CDP endpoint speaks just enough of the protocol: /json/list over
 * HTTP and a WebSocket upgrade that records Page.navigate / Page.bringToFront
 * and acks them. The service is exercised through its injectable CDP seam,
 * so no real browser is needed.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeClientFrame, encodeTextFrame } from '../server/websocket.js';
import { findFreePort } from '../browser/ports.js';
import {
  WindowSyncService,
  WindowSyncUrlError,
  type WindowSyncCdp,
  type WindowSyncLiveProfile,
} from './service.js';

interface FakeTarget {
  type: string;
  withWs: boolean;
}

interface FakeCdp {
  cdpUrl: string;
  received: { method: string; params: Record<string, unknown> }[];
  navigateParams: Record<string, unknown>[];
  shutdown: () => Promise<void>;
}

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

/**
 * Fake CDP endpoint. Serves /json/list with the given targets; every
 * WebSocket command is recorded and acked unless `dropCommands` is set,
 * in which case the socket is destroyed (client-side timeout/failure).
 */
async function startFakeCdp(targets: FakeTarget[], dropCommands = false): Promise<FakeCdp> {
  const port = await findFreePort();
  const received: { method: string; params: Record<string, unknown> }[] = [];
  const navigateParams: Record<string, unknown>[] = [];
  const base = `http://127.0.0.1:${String(port)}`;

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
          return;
        }
        if (target === '/json/list') {
          const body = JSON.stringify(
            targets.map((t, index) => ({
              id: `target-${String(index)}`,
              type: t.type,
              url: 'about:blank',
              webSocketDebuggerUrl: t.withWs
                ? `ws://127.0.0.1:${String(port)}/devtools/page/target-${String(index)}`
                : undefined,
            })),
          );
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
        let msg: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(frame.payload.toString('utf8')) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
          };
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && typeof msg.method === 'string') {
          const params = msg.params ?? {};
          received.push({ method: msg.method, params });
          if (msg.method === 'Page.navigate') {
            navigateParams.push(params);
          }
          if (dropCommands) {
            socket.destroy();
          } else {
            socket.write(
              encodeTextFrame(Buffer.from(JSON.stringify({ id: msg.id, result: {} }), 'utf8')),
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
    cdpUrl: base,
    received,
    navigateParams,
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

async function withFake(targets: FakeTarget[], dropCommands = false): Promise<FakeCdp> {
  const fake = await startFakeCdp(targets, dropCommands);
  fakes.push(fake);
  return fake;
}

function liveProfiles(cdpUrl: string, ids: string[]): WindowSyncLiveProfile[] {
  return ids.map((profileId) => ({ profileId, cdpUrl }));
}

describe('WindowSyncService.validateUrl', () => {
  it('accepts http and https URLs', () => {
    expect(WindowSyncService.validateUrl('https://example.com/a?b=c')).toContain('https://');
    expect(WindowSyncService.validateUrl('http://127.0.0.1:3000/')).toContain('http://');
  });

  it('rejects missing, malformed, and non-http(s) URLs', () => {
    expect(() => WindowSyncService.validateUrl('')).toThrow(WindowSyncUrlError);
    expect(() => WindowSyncService.validateUrl('not a url')).toThrow(WindowSyncUrlError);
    expect(() => WindowSyncService.validateUrl('javascript:alert(1)')).toThrow(WindowSyncUrlError);
    expect(() => WindowSyncService.validateUrl('file:///etc/passwd')).toThrow(WindowSyncUrlError);
  });
});

describe('WindowSyncService.syncProfiles', () => {
  it('navigates and brings to front every live profile', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }]);
    const cdp: WindowSyncCdp = {
      listTargets: () =>
        Promise.resolve([{ type: 'page', webSocketDebuggerUrl: `${fake.cdpUrl}/ws` }]),
      sendCommand: () => Promise.resolve({}),
    };
    const service = new WindowSyncService({
      cdp,
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1', 'p2']),
    });
    const result = await service.syncProfiles(['p1', 'p2'], 'https://example.com/');
    expect(result.synced.sort()).toEqual(['p1', 'p2']);
    expect(result.failed).toEqual([]);
  });

  it('sends Page.navigate then Page.bringToFront over the wire', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }]);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1']),
      timeoutMs: 3000,
    });
    const result = await service.syncProfiles(['p1'], 'https://example.com/some/page');
    expect(result.synced).toEqual(['p1']);
    expect(fake.received.map((r) => r.method)).toEqual(['Page.navigate', 'Page.bringToFront']);
    expect(fake.navigateParams).toHaveLength(1);
    expect(fake.navigateParams[0]?.url).toBe('https://example.com/some/page');
  });

  it('marks stopped or unknown profiles as failed without touching CDP', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }]);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1']),
      timeoutMs: 3000,
    });
    const result = await service.syncProfiles(['p1', 'ghost'], 'https://example.com/');
    expect(result.synced).toEqual(['p1']);
    expect(result.failed).toEqual([{ profileId: 'ghost', error: 'profile is not running' }]);
    // Only the live profile produced CDP traffic.
    expect(fake.navigateParams).toHaveLength(1);
  });

  it('fails safely when CDP is unreachable for one profile', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }], true);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1', 'p2']),
      timeoutMs: 500,
    });
    const result = await service.syncProfiles(['p1', 'p2'], 'https://example.com/');
    expect(result.synced).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.profileId).toBe('p1');
  });

  it('reports a profile with no page target as failed', async () => {
    const fake = await withFake([{ type: 'background_page', withWs: true }]);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1']),
      timeoutMs: 3000,
    });
    const result = await service.syncProfiles(['p1'], 'https://example.com/');
    expect(result.synced).toEqual([]);
    expect(result.failed).toEqual([
      { profileId: 'p1', error: 'no open page target in this profile' },
    ]);
  });

  it('dedupes repeated profile ids', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }]);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1']),
      timeoutMs: 3000,
    });
    const result = await service.syncProfiles(['p1', 'p1'], 'https://example.com/');
    expect(result.synced).toEqual(['p1']);
    expect(fake.navigateParams).toHaveLength(1);
  });

  it('validates the URL before touching any profile', async () => {
    const fake = await withFake([{ type: 'page', withWs: true }]);
    const service = new WindowSyncService({
      liveProfiles: () => liveProfiles(fake.cdpUrl, ['p1']),
      timeoutMs: 3000,
    });
    await expect(service.syncProfiles(['p1'], 'javascript:alert(1)')).rejects.toThrow(
      WindowSyncUrlError,
    );
    expect(fake.received).toEqual([]);
  });
});
