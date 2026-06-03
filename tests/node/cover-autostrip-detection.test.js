// Guard test: every envelope prefix that detectWrapper looks for must
// be visible in the bytes autoStrip actually peeks. The original bug
// was a 32-byte peek window vs. a 47-byte JavaScript-envelope prefix
// (`process.stdout.write(require("zlib").gunzipSync`), autoStrip
// silently failed to detect the JS envelope after a uuencode strip
// surfaced it as iteration 2.
//
// We don't import the constant; we drive a real autoStrip round trip
// against a wrapped stream that we know carries the longest-known
// prefix, and assert it bares cleanly. If a future envelope adds a
// longer literal prefix without bumping the peek window, this test
// fires.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  applyStack, autoStrip, escapeTransform,
} from '../../js/src/cover-pipeline.js';

function streamFromString(s) {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({
    start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
  });
}

async function streamToString(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

const COVER = 'detection-window-cover\nsecond line of cover content\n';

// JavaScript envelope wrapped inside uuencode: the JS prefix surfaces
// only after uuencode is stripped (iteration 2). If the peek window
// can't see the full JS prefix at iteration 2, autoStrip leaves the
// stream wrapped and the recovered text starts with `process.stdout.`.
test('autoStrip peels JavaScript envelope inside uuencode (long-prefix detection)', async () => {
  const escaped = streamFromString(COVER).pipeThrough(escapeTransform());
  const wrapped = applyStack(escaped, [
    { type: 'javascript', filename: 'message' },
    { type: 'uuencode', filename: 'message.js' },
  ]);
  const bare = await autoStrip(wrapped);
  const recovered = await streamToString(bare);
  assert.equal(recovered, COVER, `expected bare cover, got: ${recovered.slice(0, 80)}...`);
});

// Same shape but with base64 outermost (hits the bare-base64 detector
// first, then the inner JS detector).
test('autoStrip peels JavaScript envelope inside base64 (long-prefix detection)', async () => {
  const escaped = streamFromString(COVER).pipeThrough(escapeTransform());
  const wrapped = applyStack(escaped, [
    { type: 'javascript', filename: 'message' },
    { type: 'base64', filename: 'message.js' },
  ]);
  const bare = await autoStrip(wrapped);
  const recovered = await streamToString(bare);
  assert.equal(recovered, COVER);
});

// Same shape but with gzip outermost, gzip strip surfaces the JS
// envelope as the next iteration's input.
test('autoStrip peels JavaScript envelope inside gzip (long-prefix detection)', async () => {
  const escaped = streamFromString(COVER).pipeThrough(escapeTransform());
  const wrapped = applyStack(escaped, [
    { type: 'javascript', filename: 'message' },
    { type: 'gzip', filename: 'message.js' },
  ]);
  const bare = await autoStrip(wrapped);
  const recovered = await streamToString(bare);
  assert.equal(recovered, COVER);
});
