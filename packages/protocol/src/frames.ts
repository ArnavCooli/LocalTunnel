/**
 * Wire framing for the LocalTunnel tunnel protocol (see PROTOCOL.md §2).
 *
 *   +--------+--------------------+--------------------+-----------------+
 *   |  type  |     stream id      |   payload length   |     payload     |
 *   | 1 byte |  4 bytes, big-end  |  4 bytes, big-end  |    0..1 MiB     |
 *   +--------+--------------------+--------------------+-----------------+
 */

export const PROTOCOL_VERSION = 1;

export const ALPN = {
  tunnel: 'lt-tunnel/1',
  enroll: 'lt-enroll/1',
  admin: 'lt-admin/1',
} as const;

export const HEADER_SIZE = 9;
/** Largest payload we will send or accept in a single frame. */
export const MAX_FRAME_PAYLOAD = 1024 * 1024;
/** Chunk size used when slicing large writes into DATA frames. */
export const MAX_DATA_CHUNK = 64 * 1024;
/** Per-stream receive window, in bytes, in each direction. */
export const DEFAULT_WINDOW = 256 * 1024;
/**
 * How far past the advertised window a peer may run before we treat it as hostile.
 * A frame in flight when we grant credit is normal; a whole extra window of
 * unrequested data is not, and buffering it is how a peer would exhaust our memory.
 */
export const WINDOW_OVERRUN_SLACK = MAX_FRAME_PAYLOAD;
/**
 * Streams one connection may have open at once. The gateway applies its own,
 * lower, per-machine limit; this is the backstop each side enforces on its peer.
 */
export const MAX_CONCURRENT_STREAMS = 2048;
/** Stream ids are carried in 4 bytes, so they run out rather than wrapping. */
export const MAX_STREAM_ID = 0xffffffff;

export enum FrameType {
  CONTROL = 0x01,
  OPEN = 0x02,
  OPEN_OK = 0x03,
  DATA = 0x04,
  WINDOW = 0x05,
  CLOSE = 0x06,
}

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

export function encodeFrame(type: FrameType, streamId: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new RangeError(`frame payload ${body.length} exceeds ${MAX_FRAME_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  out.writeUInt32BE(body.length, 5);
  if (body.length > 0) body.copy(out, HEADER_SIZE);
  return out;
}

export function encodeJsonFrame(type: FrameType, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function encodeWindowFrame(streamId: number, credits: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32BE(credits >>> 0, 0);
  return encodeFrame(FrameType.WINDOW, streamId, payload);
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const KNOWN_TYPES = new Set<number>([
  FrameType.CONTROL,
  FrameType.OPEN,
  FrameType.OPEN_OK,
  FrameType.DATA,
  FrameType.WINDOW,
  FrameType.CLOSE,
]);

/**
 * Incremental frame parser. Feed it whatever arrives from the socket; it hands back
 * complete frames and keeps any partial remainder for next time.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      if (this.buffer.length < HEADER_SIZE) break;
      const type = this.buffer.readUInt8(0);
      const streamId = this.buffer.readUInt32BE(1);
      const length = this.buffer.readUInt32BE(5);

      if (!KNOWN_TYPES.has(type)) {
        throw new ProtocolError(`unknown frame type 0x${type.toString(16)}`);
      }
      if (length > MAX_FRAME_PAYLOAD) {
        throw new ProtocolError(`frame payload length ${length} exceeds maximum`);
      }
      if (this.buffer.length < HEADER_SIZE + length) break;

      frames.push({
        type,
        streamId,
        payload: this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
      });
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
    }

    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. Used by tests and diagnostics. */
  get pending(): number {
    return this.buffer.length;
  }
}

export function decodeJson<T>(payload: Buffer): T {
  if (payload.length === 0) throw new ProtocolError('expected JSON payload, got empty frame');
  try {
    return JSON.parse(payload.toString('utf8')) as T;
  } catch {
    throw new ProtocolError('malformed JSON payload');
  }
}
