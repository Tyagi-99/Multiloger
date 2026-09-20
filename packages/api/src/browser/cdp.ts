/**
 * Minimal raw-CDP client over node:net — no WebSocket dependency.
 *
 * Used for the graceful shutdown path: ProfileManager sends `Browser.close`
 * over CDP first and only escalates to SIGTERM/SIGKILL when the browser does
 * not cooperate. Client→server frames are masked per RFC 6455; server→client
 * frames are parsed unmasked.
 */

import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';

export class CdpError extends Error {
  readonly code = 'CDP_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

function maskFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** Parse one server→client frame (unmasked per RFC 6455). */
function parseServerFrame(data: Buffer): ServerFrame {
  const empty = { opcode: 0, payload: Buffer.alloc(0), consumed: 0 };
  if (data.length < 2) {
    return empty;
  }
  const opcode = (data[0] ?? 0) & 0x0f;
  let length = (data[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (data.length < 4) {
      return empty;
    }
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) {
      return empty;
    }
    const big = data.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CdpError('CDP frame too large');
    }
    length = Number(big);
    offset = 10;
  }
  if (data.length < offset + length) {
    return empty;
  }
  return { opcode, payload: data.subarray(offset, offset + length), consumed: offset + length };
}

interface CdpConnection {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Resolves when the socket closes for any reason. */
  closed: Promise<void>;
  close: () => void;
}

async function connectCdp(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:') {
    throw new CdpError(`Unsupported CDP URL protocol: ${url.protocol}`);
  }
  const socket = new Socket();
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError('CDP TCP connect timed out'));
    }, timeoutMs);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect(Number(url.port), url.hostname, () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await connected;

  const key = randomBytes(16).toString('base64');
  const path = `${url.pathname}${url.search}`;
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: ${url.hostname}:${url.port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new CdpError('CDP handshake timed out'));
    }, timeoutMs);
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('utf8');
      if (head.includes('\r\n\r\n')) {
        socket.off('data', onData);
        clearTimeout(timer);
        if (head.includes('101')) {
          // Any bytes after the header belong to the first frames; feed them
          // back through the frame parser below.
          const rest = Buffer.from(head.slice(head.indexOf('\r\n\r\n') + 4), 'utf8');
          if (rest.length > 0) {
            socket.emit('data', rest);
          }
          resolve();
        } else {
          reject(new CdpError(`CDP handshake failed: ${(head.split('\r\n')[0] ?? '').slice(0, 80)}`));
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let recvBuf = Buffer.alloc(0);
  let closedResolve: () => void = () => {
    /* replaced below by the promise executor */
  };
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let socketClosed = false;
  const onSocketClose = (): void => {
    if (socketClosed) {
      return;
    }
    socketClosed = true;
    closedResolve();
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new CdpError('CDP connection closed before a response arrived'));
    }
  };
  socket.on('close', onSocketClose);
  socket.on('error', () => {
    // 'close' follows and settles everything; nothing to do here.
  });

  socket.on('data', (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    for (;;) {
      const frame = parseServerFrame(recvBuf);
      if (frame.consumed === 0) {
        return;
      }
      recvBuf = recvBuf.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        socket.destroy();
        return;
      }
      if (frame.opcode !== 0x1 || frame.payload.length === 0) {
        continue;
      }
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(frame.payload.toString('utf8')) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') {
        continue; // Event broadcast — no one is waiting on it here.
      }
      const waiter = pending.get(msg.id);
      if (!waiter) {
        continue;
      }
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new CdpError(msg.error.message ?? 'CDP command failed'));
      } else {
        waiter.resolve(msg.result);
      }
    }
  });

  return {
    send: (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError(`CDP command timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.write(maskFrame(JSON.stringify({ id, method, params: params ?? {} })));
      }),
    closed,
    close: () => {
      socket.destroy();
    },
  };
}

/**
 * Read the debugger WebSocket URL from the browser's /json/version endpoint.
 */
export async function getDebuggerWsUrl(cdpHttpUrl: string, timeoutMs: number): Promise<string> {
  const response = await fetch(`${cdpHttpUrl}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    throw new CdpError(`CDP /json/version unreachable: ${(error as Error).message}`);
  });
  if (!response.ok) {
    throw new CdpError(`CDP /json/version answered HTTP ${String(response.status)}`);
  }
  const version = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (typeof version.webSocketDebuggerUrl !== 'string' || version.webSocketDebuggerUrl.length === 0) {
    throw new CdpError('CDP /json/version had no webSocketDebuggerUrl');
  }
  return version.webSocketDebuggerUrl;
}

/**
 * Send one raw-CDP command and resolve with its result. Rejects on timeout,
 * handshake failure, CDP error responses, or a dropped connection.
 */
export async function sendCdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const connection = await connectCdp(wsUrl, timeoutMs);
  try {
    return await connection.send(method, params);
  } finally {
    connection.close();
  }
}

/**
 * Gracefully ask the browser to shut down via raw-CDP `Browser.close`.
 *
 * Returns true when the close was acknowledged OR the debugger socket dropped
 * after we sent the command (the browser exiting tears the socket down —
 * that is the success case, not an error). Returns false on any failure and
 * never throws, so callers can fall back to SIGTERM/SIGKILL.
 */
export async function closeBrowserViaCdp(cdpHttpUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const wsUrl = await getDebuggerWsUrl(cdpHttpUrl, timeoutMs);
    const connection = await connectCdp(wsUrl, timeoutMs);
    let sent = false;
    try {
      const response = connection.send('Browser.close', {});
      // Mark sent synchronously: the frame is in the socket buffer, so a
      // socket drop from here on means the browser is going away.
      sent = true;
      const outcome = await Promise.race([
        response.then(
          () => 'acked' as const,
          () => 'failed' as const,
        ),
        connection.closed.then(() => 'dropped' as const),
      ]);
      if (outcome === 'acked') {
        return true;
      }
      // The debugger socket dropping after our close frame means the browser
      // is exiting because of it — the success case, not an error.
      return outcome === 'dropped' && sent;
    } finally {
      connection.close();
    }
  } catch {
    return false;
  }
}
