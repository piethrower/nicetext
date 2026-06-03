// Smoke tests for the MessagePort-backed stream primitive in
// js/src/worker/streams.js. Exercises chunk transfer, opt-in vs
// copy semantics, writer abort -> reader, reader cancel -> writer,
// and clean close. The primitive does per-chunk ack-based
// backpressure, so writer.write only resolves once the reader's
// pull (after a consumer read) has sent back an ack; tests
// interleave reads with writes accordingly.
// MessageChannel is a global in Node 20+ and in modern browsers.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { portWritable, portReadable } from '../../js/src/worker/streams.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('streams: chunks transfer end-to-end and close cleanly', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  // Drive reads concurrently so writer.write acks can flow.
  const readAll = (async () => {
    const got = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(...value);
    }
    return got;
  })();

  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.write(new Uint8Array([4, 5]));
  await writer.close();

  const got = await readAll;
  assert.deepEqual(got, [1, 2, 3, 4, 5]);

  port1.close();
  port2.close();
});

test('streams: opt-in transfer detaches the sender buffer (zero-copy)', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1, { transfer: true });
  const readable = portReadable(port2);

  const src = new Uint8Array([7, 8, 9]);
  const buf = src.buffer;
  const writer = writable.getWriter();
  const reader = readable.getReader();

  const writePromise = writer.write(src);
  await tick();
  assert.equal(buf.byteLength, 0, 'sender ArrayBuffer should be detached after transfer');

  const { value } = await reader.read();
  assert.deepEqual([...value], [7, 8, 9]);
  await writePromise;
  await writer.close();

  port1.close();
  port2.close();
});

test('streams: default write copies (caller keeps a valid Uint8Array)', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const src = new Uint8Array([10, 20, 30]);
  const writer = writable.getWriter();
  const reader = readable.getReader();

  const writePromise = writer.write(src);
  await tick();
  assert.equal(src.length, 3, 'sender Uint8Array should remain usable');
  assert.deepEqual([...src], [10, 20, 30]);

  const { value } = await reader.read();
  assert.deepEqual([...value], [10, 20, 30]);
  await writePromise;
  await writer.close();

  port1.close();
  port2.close();
});

test('streams: writer abort propagates to reader', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const writer = writable.getWriter();
  // After abort, writer.closed rejects; suppress so it isn't unhandled.
  writer.closed.catch(() => {});
  const reader = readable.getReader();

  const writePromise = writer.write(new Uint8Array([42]));
  const first = await reader.read();
  assert.deepEqual([...first.value], [42]);
  await writePromise;

  writer.abort(new Error('writer-bailed'));
  await assert.rejects(reader.read(), /writer-bailed/);

  port1.close();
  port2.close();
});

test('streams: reader cancel propagates to writer', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  await reader.cancel(new Error('reader-stopped'));
  // writer.closed settles when the cancel message has crossed the port
  // and errored the writable. Awaiting it sequences the next assertion.
  await writer.closed.catch(() => {});

  await assert.rejects(writer.write(new Uint8Array([1])), /reader-stopped/);

  port1.close();
  port2.close();
});

test('streams: writer close lets reader see end-of-stream without data', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  await writer.close();

  const { done, value } = await reader.read();
  assert.equal(done, true);
  assert.equal(value, undefined);

  port1.close();
  port2.close();
});

test('streams: backpressure blocks the writer until the consumer reads', async () => {
  const { port1, port2 } = new MessageChannel();
  const writable = portWritable(port1);
  const readable = portReadable(port2);

  const writer = writable.getWriter();
  const reader = readable.getReader();

  // First write goes into the reader's queue (size 1) without needing
  // an ack yet, but the second write must wait until the consumer
  // pulls. Track resolution to confirm the ordering.
  const w1 = writer.write(new Uint8Array([1]));
  const w2 = writer.write(new Uint8Array([2]));
  let w2Resolved = false;
  w2.then(() => { w2Resolved = true; });

  // Give the message-pump several ticks; w2 must still be pending
  // because nothing has read yet.
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(w2Resolved, false, 'second write should be blocked on backpressure');

  // Consume one chunk; that frees a slot, pull fires, the ack flows
  // back, and w1 (or whichever ack is first) resolves.
  const r1 = await reader.read();
  assert.deepEqual([...r1.value], [1]);
  await w1;

  // Read the second chunk, which lets w2's ack flow.
  const r2 = await reader.read();
  assert.deepEqual([...r2.value], [2]);
  await w2;
  assert.equal(w2Resolved, true);

  await writer.close();
  port1.close();
  port2.close();
});
