import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_WINDOW,
  FrameParser,
  FrameType,
  MAX_DATA_CHUNK,
  ProtocolError,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeWindowFrame,
} from './frames.js';
import type { CloseReason, ControlMessage, OpenRequest } from './messages.js';

/**
 * One logical stream inside a tunnel connection.
 *
 * Reads are held in a local queue rather than pushed straight into the Duplex
 * buffer, so a slow consumer really does stop the sender: we only grant window
 * credits for bytes the consumer has actually taken.
 */
export class TunnelStream extends Duplex {
  readonly id: number;
  readonly open: OpenRequest;

  private mux: Mux;
  private sendWindow = DEFAULT_WINDOW;
  private ungrantedBytes = 0;
  private inbound: Buffer[] = [];
  private flowing = false;
  private remoteEnded = false;
  private localEnded = false;
  private shutDown = false;
  /** A write parked because the send window is exhausted. */
  private parked: { chunk: Buffer; callback: (err?: Error | null) => void } | null = null;

  bytesIn = 0;
  bytesOut = 0;

  constructor(mux: Mux, id: number, open: OpenRequest) {
    super({ allowHalfOpen: true, highWaterMark: DEFAULT_WINDOW });
    this.mux = mux;
    this.id = id;
    this.open = open;
  }

  /* ------------------------------------------------------------- outbound */

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.shutDown) return callback(new Error('stream closed'));
    if (buf.length === 0) return callback();
    this.pump(buf, callback);
  }

  private pump(buf: Buffer, callback: (err?: Error | null) => void): void {
    let offset = 0;
    while (offset < buf.length) {
      if (this.sendWindow <= 0) {
        // Park the remainder until the peer grants more credit.
        this.parked = { chunk: buf.subarray(offset), callback };
        return;
      }
      const size = Math.min(buf.length - offset, MAX_DATA_CHUNK, this.sendWindow);
      const slice = buf.subarray(offset, offset + size);
      this.sendWindow -= size;
      this.bytesOut += size;
      this.mux.sendFrame(FrameType.DATA, this.id, slice);
      offset += size;
    }
    callback();
  }

  /** Called by the mux when a WINDOW frame arrives for this stream. */
  grantCredits(credits: number): void {
    this.sendWindow += credits;
    const parked = this.parked;
    if (parked && this.sendWindow > 0) {
      this.parked = null;
      this.pump(parked.chunk, parked.callback);
    }
  }

  override _final(callback: (err?: Error | null) => void): void {
    this.localEnded = true;
    if (!this.shutDown) this.mux.sendFrame(FrameType.CLOSE, this.id);
    callback();
    this.maybeDestroy();
  }

  /* -------------------------------------------------------------- inbound */

  override _read(): void {
    this.flowing = true;
    this.drainInbound();
  }

  /** Called by the mux when a DATA frame arrives for this stream. */
  acceptData(payload: Buffer): void {
    if (this.shutDown) return;
    this.bytesIn += payload.length;
    this.inbound.push(payload);
    this.drainInbound();
  }

  private drainInbound(): void {
    while (this.flowing && this.inbound.length > 0) {
      const chunk = this.inbound.shift()!;
      const wantsMore = this.push(chunk);
      this.ungrantedBytes += chunk.length;
      if (!wantsMore) {
        this.flowing = false;
        break;
      }
    }
    // Only hand back credit for bytes the consumer has taken.
    if (this.ungrantedBytes >= DEFAULT_WINDOW / 2) {
      const credits = this.ungrantedBytes;
      this.ungrantedBytes = 0;
      if (!this.shutDown) this.mux.sendFrame(FrameType.WINDOW, this.id, credits);
    }
    if (this.remoteEnded && this.inbound.length === 0) {
      this.push(null);
    }
  }

  /** Called by the mux when the peer sends CLOSE. */
  acceptClose(reason?: CloseReason): void {
    this.remoteEnded = true;
    if (reason?.reason) {
      this.emit('remote-close', reason);
    }
    if (this.inbound.length === 0) this.push(null);
    this.maybeDestroy();
  }

  private maybeDestroy(): void {
    if (this.localEnded && this.remoteEnded && !this.shutDown) {
      this.shutDown = true;
      this.mux.forgetStream(this.id);
    }
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    if (!this.shutDown) {
      this.shutDown = true;
      const payload: CloseReason | undefined = err ? { reason: err.message } : undefined;
      this.mux.sendClose(this.id, payload);
      this.mux.forgetStream(this.id);
    }
    if (this.parked) {
      this.parked.callback(err ?? new Error('stream destroyed'));
      this.parked = null;
    }
    callback(err);
  }

  /* --------------------------------------------------- net.Socket shims --
   * Node's HTTP client and server drive their transport as if it were a
   * net.Socket. A TunnelStream is a plain Duplex, so it needs these no-ops to be
   * usable directly as `createConnection` output.
   */

  setTimeout(ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (ms > 0) {
      this.timeoutTimer = setTimeout(() => this.emit('timeout'), ms);
      this.timeoutTimer.unref?.();
    }
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  get remoteAddress(): string {
    return this.open.remoteAddr.split(':').slice(0, -1).join(':') || this.open.remoteAddr;
  }
  get remotePort(): number {
    return Number(this.open.remoteAddr.split(':').pop()) || 0;
  }
  address(): Record<string, never> {
    return {};
  }

  private timeoutTimer: NodeJS.Timeout | null = null;

  /** Tear down without emitting another CLOSE — used when the whole tunnel drops. */
  abort(err: Error): void {
    this.shutDown = true;
    if (this.parked) {
      this.parked.callback(err);
      this.parked = null;
    }
    this.destroy(err);
  }
}

export interface MuxOptions {
  /** Only the gateway side opens streams. */
  role: 'gateway' | 'agent';
}

export interface MuxEvents {
  control: (message: ControlMessage) => void;
  stream: (stream: TunnelStream) => void;
  error: (err: Error) => void;
  close: () => void;
}

/**
 * Multiplexes many TunnelStreams plus a control channel over one already-encrypted
 * socket. This layer does no cryptography of any kind — the socket it is given is
 * expected to be a completed TLS connection.
 */
export class Mux extends EventEmitter {
  private socket: Duplex;
  private parser = new FrameParser();
  private streams = new Map<number, TunnelStream>();
  private nextStreamId: number;
  private role: 'gateway' | 'agent';
  private ended = false;

  bytesIn = 0;
  bytesOut = 0;
  opensAccepted = 0;

  constructor(socket: Duplex, options: MuxOptions) {
    super();
    this.socket = socket;
    this.role = options.role;
    // Gateway opens odd ids; agents never open streams, but the split keeps the
    // id space unambiguous if that ever changes.
    this.nextStreamId = options.role === 'gateway' ? 1 : 2;

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('tunnel connection closed')));
    socket.on('end', () => this.fail(new Error('tunnel connection ended by peer')));
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  /* --------------------------------------------------------------- output */

  sendFrame(type: FrameType, streamId: number, payload?: Buffer | number): void {
    if (this.ended) return;
    let frame: Buffer;
    if (type === FrameType.WINDOW && typeof payload === 'number') {
      frame = encodeWindowFrame(streamId, payload);
    } else {
      frame = encodeFrame(type, streamId, payload as Buffer | undefined);
    }
    this.bytesOut += frame.length;
    this.socket.write(frame);
  }

  sendControl(message: ControlMessage): void {
    if (this.ended) return;
    const frame = encodeJsonFrame(FrameType.CONTROL, 0, message);
    this.bytesOut += frame.length;
    this.socket.write(frame);
  }

  sendClose(streamId: number, reason?: CloseReason): void {
    if (this.ended) return;
    const frame = reason
      ? encodeJsonFrame(FrameType.CLOSE, streamId, reason)
      : encodeFrame(FrameType.CLOSE, streamId);
    this.bytesOut += frame.length;
    this.socket.write(frame);
  }

  /** Gateway side: open a new stream to the agent for a public connection. */
  openStream(open: OpenRequest): TunnelStream {
    if (this.role !== 'gateway') {
      throw new Error('only the gateway side may open streams');
    }
    if (this.ended) throw new Error('tunnel is closed');
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = new TunnelStream(this, id, open);
    this.streams.set(id, stream);
    this.sendFrame(FrameType.OPEN, id, Buffer.from(JSON.stringify(open), 'utf8'));
    return stream;
  }

  /** Agent side: confirm a local dial succeeded. */
  confirmStream(streamId: number): void {
    this.sendFrame(FrameType.OPEN_OK, streamId);
  }

  forgetStream(id: number): void {
    this.streams.delete(id);
  }

  /* ---------------------------------------------------------------- input */

  private onData(chunk: Buffer): void {
    this.bytesIn += chunk.length;
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      return this.fail(err as Error);
    }
    for (const frame of frames) {
      try {
        this.dispatch(frame.type, frame.streamId, frame.payload);
      } catch (err) {
        return this.fail(err as Error);
      }
    }
  }

  private dispatch(type: FrameType, streamId: number, payload: Buffer): void {
    if (streamId === 0) {
      if (type !== FrameType.CONTROL) {
        throw new ProtocolError(`frame type ${type} is not valid on stream 0`);
      }
      this.emit('control', decodeJson<ControlMessage>(payload));
      return;
    }

    if (type === FrameType.OPEN) {
      if (this.role !== 'agent') throw new ProtocolError('gateway received an OPEN frame');
      if (this.streams.has(streamId)) throw new ProtocolError(`stream ${streamId} already exists`);
      const open = decodeJson<OpenRequest>(payload);
      const stream = new TunnelStream(this, streamId, open);
      this.streams.set(streamId, stream);
      this.opensAccepted += 1;
      this.emit('stream', stream);
      return;
    }

    const stream = this.streams.get(streamId);
    // Frames for a stream we already tore down are ignored: the peer may not have
    // seen our CLOSE yet. Only genuinely malformed framing kills the connection.
    if (!stream) return;

    switch (type) {
      case FrameType.OPEN_OK:
        stream.emit('open-ok');
        break;
      case FrameType.DATA:
        stream.acceptData(Buffer.from(payload));
        break;
      case FrameType.WINDOW:
        if (payload.length !== 4) throw new ProtocolError('WINDOW payload must be 4 bytes');
        stream.grantCredits(payload.readUInt32BE(0));
        break;
      case FrameType.CLOSE:
        stream.acceptClose(payload.length > 0 ? decodeJson<CloseReason>(payload) : undefined);
        break;
      default:
        throw new ProtocolError(`frame type ${type} is not valid on a stream`);
    }
  }

  /* ------------------------------------------------------------- shutdown */

  private fail(err: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const stream of this.streams.values()) stream.abort(err);
    this.streams.clear();
    this.emit('error', err);
    this.emit('close');
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const stream of this.streams.values()) {
      stream.abort(new Error('tunnel closing'));
    }
    this.streams.clear();
    this.socket.end();
    this.emit('close');
  }
}
