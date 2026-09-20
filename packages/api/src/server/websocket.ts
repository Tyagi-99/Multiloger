/**
 * Minimal WebSocket server (RFC 6455) with zero dependencies.
 *
 * Scope is deliberately narrow: text broadcast from server to dashboard
 * clients, plus ping/pong and close handling. It does NOT implement
 * fragmentation reassembly or extensions — clients must send single-frame
 * messages, which browsers always do for these sizes.
 *
 * Authentication happens during the HTTP upgrade: `?token=<api-token>`.
 * The token travels in the query string of a ws:// or wss:// URL; over
 * plain ws:// on an untrusted network it is visible — run behind TLS
 * (wss://) in production. This is documented, not hidden.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Return a label for a valid token (token id), or null to reject. */
export type WsAuthenticator = (token: string) => Promise<string | null>;

export interface WsClient {
  readonly label: string;
  sendText(text: string): void;
  close(): void;
}

function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/** Encode one server→client text frame (never masked). */
export function encodeTextFrame(payload: Buffer): Buffer {
  const header = [0x80 | OPCODE_TEXT];
  if (payload.length < 126) {
    header.push(payload.length);
    return Buffer.concat([Buffer.from(header), payload]);
  }
  if (payload.length < 65536) {
    const extended = Buffer.alloc(2);
    extended.writeUInt16BE(payload.length, 0);
    return Buffer.concat([Buffer.from([...header, 126]), extended, payload]);
  }
  const extended = Buffer.alloc(8);
  extended.writeBigUInt64BE(BigInt(payload.length), 0);
  return Buffer.concat([Buffer.from([...header, 127]), extended, payload]);
}

function encodeControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  /** Bytes consumed from the input buffer (0 when incomplete). */
  consumed: number;
}

/** Decode one client→server frame (must be masked per RFC 6455). */
export function decodeClientFrame(data: Buffer): DecodedFrame {
  if (data.length < 2) {
    return { opcode: 0, payload: Buffer.alloc(0), consumed: 0 };
  }
  const opcode = (data[0] ?? 0) & 0x0f;
  const masked = ((data[1] ?? 0) & 0x80) !== 0;
  let length = (data[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (data.length < 4) {
      return { opcode: 0, payload: Buffer.alloc(0), consumed: 0 };
    }
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) {
      return { opcode: 0, payload: Buffer.alloc(0), consumed: 0 };
    }
    const big = data.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebSocket frame too large');
    }
    length = Number(big);
    offset = 10;
  }
  if (!masked) {
    throw new Error('Client frames must be masked');
  }
  if (data.length < offset + 4 + length) {
    return { opcode: 0, payload: Buffer.alloc(0), consumed: 0 };
  }
  const mask = data.subarray(offset, offset + 4);
  const payload = data.subarray(offset + 4, offset + 4 + length);
  const unmasked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    unmasked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return { opcode, payload: unmasked, consumed: offset + 4 + length };
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  socket.destroy();
}

export class WsHub {
  private readonly clients = new Set<{ socket: Socket; label: string }>();
  private pingTimer: NodeJS.Timeout | undefined;

  /** Attach an upgrade handler; call once per HTTP server. */
  attach(
    getServer: () => { on(event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void): void },
    authenticate: WsAuthenticator,
  ): void {
    getServer().on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head, authenticate).catch(() => {
        socket.destroy();
      });
    });
  }

  /** Broadcast a JSON-serializable event to every connected client. */
  broadcast(event: unknown): void {
    const frame = encodeTextFrame(Buffer.from(JSON.stringify(event), 'utf8'));
    for (const client of this.clients) {
      client.socket.write(frame);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  startHeartbeat(intervalMs = 30_000): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      const ping = encodeControlFrame(OPCODE_PING);
      for (const client of [...this.clients]) {
        try {
          client.socket.write(ping);
        } catch {
          this.clients.delete(client);
        }
      }
    }, intervalMs);
    this.pingTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  close(): void {
    this.stopHeartbeat();
    for (const client of this.clients) {
      try {
        client.socket.write(encodeControlFrame(OPCODE_CLOSE));
      } catch {
        // ignore
      }
      client.socket.destroy();
    }
    this.clients.clear();
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    authenticate: WsAuthenticator,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/events') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (
      req.method !== 'GET' ||
      req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !req.headers['sec-websocket-key'] ||
      req.headers['sec-websocket-version'] !== '13'
    ) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const presented = url.searchParams.get('token');
    const label = presented ? await authenticate(presented) : null;
    if (!label) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const entry = { socket, label };
    this.clients.add(entry);

    // Say hello: lets the dashboard confirm auth + subscription immediately.
    socket.write(encodeTextFrame(Buffer.from(JSON.stringify({ type: 'hello', tokenId: label }), 'utf8')));

    let pending = head.length > 0 ? head : Buffer.alloc(0);
    const onData = (data: Buffer): void => {
      pending = Buffer.concat([pending, data]);
      for (;;) {
        let frame: DecodedFrame;
        try {
          frame = decodeClientFrame(pending);
        } catch {
          socket.destroy();
          return;
        }
        if (frame.consumed === 0) {
          return; // wait for more bytes
        }
        pending = pending.subarray(frame.consumed);
        if (frame.opcode === OPCODE_CLOSE) {
          socket.write(encodeControlFrame(OPCODE_CLOSE, frame.payload.subarray(0, 125)));
          socket.destroy();
          return;
        }
        if (frame.opcode === OPCODE_PING) {
          socket.write(encodeControlFrame(OPCODE_PONG, frame.payload.subarray(0, 125)));
        }
        // Text/binary messages from clients are ignored (broadcast-only hub).
      }
    };
    const onGone = (): void => {
      this.clients.delete(entry);
      socket.off('data', onData);
    };
    socket.on('data', onData);
    socket.on('close', onGone);
    socket.on('error', onGone);
    if (pending.length > 0) {
      onData(Buffer.alloc(0));
    }
  }
}
