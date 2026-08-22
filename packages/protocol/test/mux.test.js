const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const {
  FrameParser,
  FrameType,
  encodeFrame,
  encodeJsonFrame,
  Mux,
  Backoff,
  isValidHostname,
  DEFAULT_WINDOW,
} = require('../dist/index.js');

/** Build two Duplexes that write to each other — an in-memory stand-in for TLS. */
function socketPair() {
  const left = new PassThrough();
  const right = new PassThrough();
  const leftSide = new (require('node:stream').Duplex)({
    write(chunk, enc, cb) {
      right.write(chunk);
      cb();
    },
    read() {},
  });
  const rightSide = new (require('node:stream').Duplex)({
    write(chunk, enc, cb) {
      left.write(chunk);
      cb();
    },
    read() {},
  });
  left.on('data', (c) => leftSide.push(c));
  right.on('data', (c) => rightSide.push(c));
  return [leftSide, rightSide];
}

test('FrameParser reassembles frames split across chunks', () => {
  const parser = new FrameParser();
  const frame = encodeFrame(FrameType.DATA, 7, Buffer.from('hello world'));
  assert.deepEqual(parser.push(frame.subarray(0, 4)), []);
  assert.deepEqual(parser.push(frame.subarray(4, 10)), []);
  const frames = parser.push(frame.subarray(10));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FrameType.DATA);
  assert.equal(frames[0].streamId, 7);
  assert.equal(frames[0].payload.toString(), 'hello world');
  assert.equal(parser.pending, 0);
});

test('FrameParser handles several frames in one chunk', () => {
  const parser = new FrameParser();
  const chunk = Buffer.concat([
    encodeJsonFrame(FrameType.CONTROL, 0, { t: 'ping', ts: 1 }),
    encodeFrame(FrameType.DATA, 1, Buffer.from('abc')),
    encodeFrame(FrameType.CLOSE, 1),
  ]);
  const frames = parser.push(chunk);
  assert.equal(frames.length, 3);
  assert.equal(frames[2].type, FrameType.CLOSE);
});

test('FrameParser rejects unknown frame types', () => {
  const parser = new FrameParser();
  const bad = Buffer.alloc(9);
  bad.writeUInt8(0x77, 0);
  assert.throws(() => parser.push(bad), /unknown frame type/);
});

test('control messages round-trip between the two sides', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  const received = new Promise((resolve) => agent.once('control', resolve));
  gateway.sendControl({ t: 'hello.ok', gatewayVersion: '1.0.0', gatewayId: 'gw_1', publicIp: '1.2.3.4', heartbeatMs: 15000 });
  const msg = await received;
  assert.equal(msg.t, 'hello.ok');
  assert.equal(msg.gatewayId, 'gw_1');
});

test('a stream opened by the gateway carries bytes both ways', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  const incoming = new Promise((resolve) => agent.once('stream', resolve));
  const out = gateway.openStream({ serviceId: 'svc_1', remoteAddr: '9.9.9.9:5000', proto: 'tcp' });

  const server = await incoming;
  assert.equal(server.open.serviceId, 'svc_1');
  // Echo back, uppercased.
  server.on('data', (chunk) => server.write(chunk.toString().toUpperCase()));

  out.write('ping');
  const reply = await new Promise((resolve) => out.once('data', resolve));
  assert.equal(reply.toString(), 'PING');
  assert.equal(gateway.activeStreams, 1);
});

test('flow control moves a payload larger than the window', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  const incoming = new Promise((resolve) => agent.once('stream', resolve));
  const out = gateway.openStream({ serviceId: 'svc_1', remoteAddr: '9.9.9.9:5000', proto: 'tcp' });
  const server = await incoming;

  const payload = Buffer.alloc(DEFAULT_WINDOW * 3, 0x61);
  const done = new Promise((resolve) => {
    const chunks = [];
    server.on('data', (c) => {
      chunks.push(c);
      const total = chunks.reduce((n, x) => n + x.length, 0);
      if (total >= payload.length) resolve(Buffer.concat(chunks));
    });
  });

  out.write(payload);
  const got = await done;
  assert.equal(got.length, payload.length);
  assert.ok(got.equals(payload));
});

test('closing a stream on one side ends it on the other', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  const incoming = new Promise((resolve) => agent.once('stream', resolve));
  const out = gateway.openStream({ serviceId: 'svc_1', remoteAddr: '1.1.1.1:1', proto: 'tcp' });
  const server = await incoming;
  server.resume();

  const ended = new Promise((resolve) => server.once('end', resolve));
  out.end('bye');
  await ended;
});

test('tearing down the connection aborts live streams', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  const incoming = new Promise((resolve) => agent.once('stream', resolve));
  const out = gateway.openStream({ serviceId: 'svc_1', remoteAddr: '1.1.1.1:1', proto: 'tcp' });
  await incoming;

  const errored = new Promise((resolve) => out.once('error', resolve));
  gateway.close();
  const err = await errored;
  assert.match(err.message, /closing/);
});

test('the agent side refuses to open streams', () => {
  const [, b] = socketPair();
  const agent = new Mux(b, { role: 'agent' });
  agent.on('error', () => {});
  assert.throws(() => agent.openStream({ serviceId: 'x', remoteAddr: '', proto: 'tcp' }), /only the gateway/);
});

test('backoff grows and resets', () => {
  const backoff = new Backoff(1000, 30000);
  const first = backoff.next();
  assert.ok(first >= 250 && first <= 1000, `got ${first}`);
  for (let i = 0; i < 10; i++) backoff.next();
  const late = backoff.next();
  assert.ok(late <= 30000);
  assert.ok(late >= 7500);
  backoff.reset();
  assert.equal(backoff.attempts, 0);
});

test('hostname validation', () => {
  assert.ok(isValidHostname('mysite.example.com'));
  assert.ok(isValidHostname('mc.example.co.uk'));
  assert.ok(!isValidHostname('localhost'));
  assert.ok(!isValidHostname('-bad.example.com'));
  assert.ok(!isValidHostname('has space.example.com'));
});

test('a frame split across many reads is reassembled without quadratic copying', () => {
  const body = Buffer.alloc(1024 * 1024, 9);
  const frame = encodeFrame(FrameType.DATA, 7, body);
  const parser = new FrameParser();
  const frames = [];
  for (let offset = 0; offset < frame.length; offset += 1500) {
    frames.push(...parser.push(frame.subarray(offset, Math.min(offset + 1500, frame.length))));
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].streamId, 7);
  assert.equal(frames[0].payload.length, body.length);
  assert.equal(parser.pending, 0);

  // Two frames arriving inside one read are both returned, in order.
  const pair = Buffer.concat([
    encodeFrame(FrameType.DATA, 1, Buffer.from('one')),
    encodeFrame(FrameType.DATA, 3, Buffer.from('two')),
  ]);
  const both = new FrameParser().push(pair);
  assert.equal(both.length, 2);
  assert.equal(both[0].payload.toString(), 'one');
  assert.equal(both[1].payload.toString(), 'two');
});

test('a transfer of several windows survives a stop-start reader', async () => {
  const [a, b] = socketPair();
  const gateway = new Mux(a, { role: 'gateway' });
  const agent = new Mux(b, { role: 'agent' });
  gateway.on('error', () => {});
  agent.on('error', () => {});

  // More than one window, and not a whole number of them: credit has to keep
  // flowing back for the sender to get past the first window, and the tail must
  // still arrive once the reader has caught up. (The end-to-end suite covers the
  // same rule through a real HTTP response, where a stalled grant used to hang
  // the request outright.)
  const total = DEFAULT_WINDOW * 2 + 7777;
  const payload = Buffer.alloc(total, 3);

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the stream stalled under flow control')), 10000);
    agent.on('stream', (incoming) => {
      let got = 0;
      // A reader that pauses is what leaves credit sitting below the threshold.
      incoming.on('data', (chunk) => {
        got += chunk.length;
        incoming.pause();
        setImmediate(() => incoming.resume());
      });
      incoming.on('end', () => {
        clearTimeout(timer);
        resolve(got);
      });
    });
  });

  const stream = gateway.openStream({ serviceId: 'svc', remoteAddr: '198.51.100.7:1234', proto: 'tcp' });
  stream.end(payload);

  assert.equal(await received, total);
});
