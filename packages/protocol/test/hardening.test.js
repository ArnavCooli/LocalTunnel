const test = require('node:test');
const assert = require('node:assert');
const { Duplex } = require('node:stream');
const {
  DEFAULT_WINDOW,
  FrameParser,
  FrameType,
  MAX_CONCURRENT_STREAMS,
  MAX_FRAME_PAYLOAD,
  Mux,
  encodeFrame,
  encodeJsonFrame,
} = require('../dist/index.js');

/**
 * Regression tests for the protocol's behaviour under hostile input. Everything
 * here is something a peer on the other end of an authenticated TLS connection
 * could send: authentication proves who they are, not that they are honest.
 */

/** A mux whose peer is us: we hand it bytes and read back what it writes. */
function harness(role) {
  const written = [];
  const socket = new Duplex({
    write(chunk, _enc, cb) {
      written.push(Buffer.from(chunk));
      cb();
    },
    read() {},
  });
  const mux = new Mux(socket, { role });
  const errors = [];
  mux.on('error', (err) => errors.push(err));
  return {
    mux,
    errors,
    /** Deliver bytes as if they had arrived from the peer. */
    feed: (buf) => socket.emit('data', buf),
    /** Every frame the mux has written back to the peer. */
    sent: () => {
      const parser = new FrameParser();
      return parser.push(Buffer.concat(written));
    },
  };
}

function openFrame(id, serviceId = 'svc_1') {
  return encodeJsonFrame(FrameType.OPEN, id, {
    serviceId,
    remoteAddr: '203.0.113.5:4000',
    proto: 'tcp',
  });
}

test('a peer that ignores the receive window is disconnected, not buffered', () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  h.feed(openFrame(1));
  assert.equal(streams.length, 1);
  // Nothing reads from the stream, so no credit is ever granted back. A well
  // behaved peer stops after one window; this one keeps going.
  const chunk = Buffer.alloc(MAX_FRAME_PAYLOAD, 0x41);
  let delivered = 0;
  for (let i = 0; i < 8; i++) {
    h.feed(encodeFrame(FrameType.DATA, 1, chunk));
    delivered += chunk.length;
    if (h.errors.length > 0) break;
  }
  assert.equal(h.errors.length, 1, 'the overrun should have failed the connection');
  assert.match(h.errors[0].message, /receive window/);
  // The point of the check: it fires while the buffered data is still bounded.
  assert.ok(delivered <= DEFAULT_WINDOW + 2 * MAX_FRAME_PAYLOAD, `buffered ${delivered} bytes`);
});

test('data within the window is accepted normally', () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  h.feed(openFrame(1));
  const chunk = Buffer.alloc(64 * 1024, 0x42);
  for (let i = 0; i < 4; i++) h.feed(encodeFrame(FrameType.DATA, 1, chunk));
  assert.equal(h.errors.length, 0);
  assert.equal(streams[0].bytesIn, 4 * chunk.length);
});

test('a consumer that drains keeps receiving past one window', async () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  h.feed(openFrame(1));
  let read = 0;
  streams[0].on('data', (c) => {
    read += c.length;
  });
  const chunk = Buffer.alloc(128 * 1024, 0x43);
  // Ten windows' worth, delivered to a consumer that is keeping up.
  for (let i = 0; i < 20; i++) {
    h.feed(encodeFrame(FrameType.DATA, 1, chunk));
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(h.errors.length, 0, h.errors[0]?.message);
  assert.equal(read, 20 * chunk.length);
});

test('OPEN frames stop at the concurrent stream limit instead of growing forever', () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  for (let i = 0; i < MAX_CONCURRENT_STREAMS + 16; i++) {
    h.feed(openFrame(2 * i + 1));
  }
  assert.equal(h.errors.length, 0, 'refusing a stream must not kill healthy ones');
  assert.equal(h.mux.activeStreams, MAX_CONCURRENT_STREAMS);
  const closes = h.sent().filter((f) => f.type === FrameType.CLOSE);
  assert.ok(closes.length >= 16, 'refused opens should be answered with CLOSE');
  assert.match(JSON.parse(closes[0].payload.toString()).reason, /too many/);
});

test('an OPEN in the receiver own id space is rejected as stream confusion', () => {
  const h = harness('agent');
  h.feed(openFrame(2));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /id space/);
});

test('an agent may not open streams towards the gateway', () => {
  const h = harness('gateway');
  h.feed(openFrame(1));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /OPEN frame/);
});

test('a WINDOW frame cannot grow the send window without bound', () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  h.feed(openFrame(1));
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(0xffffffff, 0);
  for (let i = 0; i < 8; i++) h.feed(encodeFrame(FrameType.WINDOW, 1, huge));
  assert.equal(h.errors.length, 0);
  // Write more than the clamp allows and check the excess is parked rather than
  // flushed on the strength of the peer's inflated credit.
  const written = [];
  streams[0].write(Buffer.alloc(DEFAULT_WINDOW * 6, 0x44), () => written.push('done'));
  assert.equal(written.length, 0, 'the write should still be flow-controlled');
});

test('malformed frames fail the connection rather than desynchronising the parser', () => {
  for (const bad of [
    Buffer.from([0x7f, 0, 0, 0, 1, 0, 0, 0, 0]), // unknown frame type
    Buffer.from([FrameType.DATA, 0, 0, 0, 0, 0, 0, 0, 1, 0x41]), // DATA on stream 0
    Buffer.concat([
      Buffer.from([FrameType.WINDOW, 0, 0, 0, 1, 0, 0, 0, 2]),
      Buffer.from([0, 0]),
    ]), // short WINDOW payload
  ]) {
    const h = harness('agent');
    h.mux.on('stream', () => {});
    h.feed(openFrame(1));
    h.feed(bad);
    assert.equal(h.errors.length, 1, `expected a failure for ${bad.toString('hex')}`);
  }
});

test('an oversized declared payload length is refused', () => {
  const parser = new FrameParser();
  const header = Buffer.alloc(9);
  header.writeUInt8(FrameType.DATA, 0);
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(0xffffffff, 5);
  assert.throws(() => parser.push(header), /exceeds maximum/);
});

test('CONTROL is the only frame type valid on stream 0', () => {
  const h = harness('agent');
  h.feed(encodeFrame(FrameType.CLOSE, 0));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /stream 0/);
});

test('frames for an unknown stream are ignored, not fatal', () => {
  const h = harness('agent');
  h.feed(encodeFrame(FrameType.DATA, 9, Buffer.from('late')));
  h.feed(encodeFrame(FrameType.CLOSE, 9));
  assert.equal(h.errors.length, 0);
});

test('tearing a tunnel down does not raise an uncaught error on its streams', async () => {
  const h = harness('agent');
  const streams = [];
  h.mux.on('stream', (s) => streams.push(s));
  h.feed(openFrame(1));
  h.feed(openFrame(3));
  // No consumer has attached an 'error' handler yet — which is exactly the window
  // in which a malformed frame used to crash the process.
  h.feed(Buffer.from([0x7f, 0, 0, 0, 1, 0, 0, 0, 0]));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.errors.length, 1);
  assert.equal(h.mux.activeStreams, 0);
  assert.ok(streams.every((s) => s.destroyed));
});
