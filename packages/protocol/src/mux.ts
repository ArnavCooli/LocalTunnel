import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_WINDOW,
  FrameParser,
  FrameType,
  encodeHeader,
  MAX_CONCURRENT_STREAMS,
  MAX_DATA_CHUNK,
  MAX_STREAM_ID,
  ProtocolError,
  WINDOW_OVERRUN_SLACK,
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
  /** Read cursor into `inbound`, so draining is not a repeated O(n) shift. */
  private inboundHead = 0;
  /**
   * Bytes received for which no credit has been handed back yet. Flow control is
   * only a bound on memory if the *receiver* enforces it, so this is checked
   * against the window rather than trusted to the sender.
   */
  private receiveOutstanding = 0;
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
    // A peer handing out absurd credit does not get to switch our own bounds off.
    this.sendWindow = Math.min(this.sendWindow + credits, DEFAULT_WINDOW * 4);
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
    this.receiveOutstanding += payload.length;
    if (this.receiveOutstanding > DEFAULT_WINDOW + WINDOW_OVERRUN_SLACK) {
      // The peer is ignoring the window it was granted. Queueing the data anyway
      // is an unbounded allocation driven by the other end, so refuse the frame
      // and let the mux tear the connection down.
      throw new ProtocolError(
        `stream ${this.id} exceeded its receive window by ${this.receiveOutstanding - DEFAULT_WINDOW} bytes`,
      );
    }
    this.bytesIn += payload.length;
    this.inbound.push(payload);
    this.drainInbound();
  }

  private get queued(): number {
    return this.inbound.length - this.inboundHead;
  }

  private drainInbound(): void {
    while (this.flowing && this.inboundHead < this.inbound.length) {
      const chunk = this.inbound[this.inboundHead];
      this.inbound[this.inboundHead] = undefined as unknown as Buffer;
      this.inboundHead += 1;
      if (this.inboundHead === this.inbound.length) {
        this.inbound.length = 0;
        this.inboundHead = 0;
      }
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
      this.receiveOutstanding = Math.max(0, this.receiveOutstanding - credits);
      if (!this.shutDown) this.mux.sendFrame(FrameType.WINDOW, this.id, credits);
    }
    if (this.remoteEnded && this.queued === 0) {
      this.push(null);
    }
  }

  /** Called by the mux when the peer sends CLOSE. */
  acceptClose(reason?: CloseReason): void {
    this.remoteEnded = true;
    if (reason?.reason) {
      this.emit('remote-close', reason);
    }
    if (this.queued === 0) this.push(null);
    this.maybeDestroy();
  }

  private maybeDestroy(): void {
    if (this.localEnded && this.remoteEnded && !this.shutDown) {
      this.shutDown = true;
      this.mux.forgetStream(this.id);
    }
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
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
    if (type === FrameType.WINDOW && typeof payload === 'number') {
      const frame = encodeWindowFrame(streamId, payload);
      this.bytesOut += frame.length;
      this.socket.write(frame);
      return;
    }
    const body = payload as Buffer | undefined;
    if (body !== undefined && body.length > 0) {
      // Header and payload are corked into one write rather than copied into a
      // single buffer: on a 64 KiB DATA frame that copy was the most expensive
      // thing on the forwarding path, and the socket still emits one TLS record.
      const header = encodeHeader(type, streamId, body.length);
      this.bytesOut += header.length + body.length;
      this.socket.cork();
      this.socket.write(header);
      this.socket.write(body);
      this.socket.uncork();
      return;
    }
    const frame = encodeFrame(type, streamId, undefined);
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
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      throw new Error('too many concurrent streams on this tunnel');
    }
    const id = this.nextStreamId;
    if (id > MAX_STREAM_ID) {
      // Ids are never reused, so a connection that has burned through the whole
      // space has to be replaced rather than wrapped round onto live streams.
      throw new Error('this tunnel has exhausted its stream ids; reconnect');
    }
    this.nextStreamId += 2;
    const stream = new TunnelStream(this, id, open);
    this.register(stream);
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

  /**
   * Track a stream the mux owns.
   *
   * The no-op error listener is load-bearing. Tearing a connection down aborts
   * every stream on it with an error, and a Duplex that emits 'error' with no
   * listener throws an uncaughtException — so a single malformed frame from the
   * peer could take the whole process down before a consumer had attached its
   * own handler. Consumers that do listen still receive the error normally.
   */
  private register(stream: TunnelStream): void {
    stream.on('error', () => {});
    this.streams.set(stream.id, stream);
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
      // Only the gateway opens streams, and it opens odd ids. An OPEN carrying an
      // id from our own half of the space is a peer trying to confuse the mapping.
      if (streamId % 2 === 0) {
        throw new ProtocolError(`stream ${streamId} is not in the opener's id space`);
      }
      if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
        // Refuse the stream without killing the healthy ones already running.
        this.sendClose(streamId, { reason: 'too many concurrent streams', code: 'limit' });
        return;
      }
      const open = decodeJson<OpenRequest>(payload);
      const stream = new TunnelStream(this, streamId, open);
      this.register(stream);
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
        stream.acceptData(payload);
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
