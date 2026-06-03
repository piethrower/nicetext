// Tests for the new explicit detect+strip entry points
// (detectLayers, applyStrips, stripWithFallback) added to support the
// layer-picker UI. autoStrip remains as the silent path.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  applyStack, escapeTransform,
  detectLayers, detectLayersFromFactory,
  applyStrips, applyStripsToStream,
  stripWithFallback,
} from '../../js/src/cover-pipeline.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamFromBytes(bytes) {
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
  return dec.decode(out);
}

const COVER = 'hello cover\nsecond line\nthird\n';

async function wrap(cover, stack) {
  const escaped = streamFromBytes(enc.encode(cover)).pipeThrough(escapeTransform());
  const out = await streamToString(applyStack(escaped, stack));
  return enc.encode(out);
}

test('detectLayers: bare cover has empty layer chain', async () => {
  const bytes = enc.encode('plain cover with no wrapper\n');
  const { layers } = await detectLayers(streamFromBytes(bytes));
  assert.deepEqual(layers, []);
});

test('detectLayers: single-layer wrap reports the wrapper name', async () => {
  const wrapped = await wrap(COVER, [{ type: 'html', subject: 'Note' }]);
  const { layers } = await detectLayers(streamFromBytes(wrapped));
  assert.deepEqual(layers, ['html']);
});

test('detectLayers: two-layer wrap reports both layers top-to-bottom', async () => {
  const wrapped = await wrap(COVER, [
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  const { layers } = await detectLayers(streamFromBytes(wrapped));
  assert.deepEqual(layers, ['base64', 'gzip']);
});

test('detectLayers: envelope+format stack reports the full chain', async () => {
  // Valid 3-layer stack: html inside, then gzip, then base64 outermost.
  // (gzip output is binary, so a base64 layer is needed for any text
  // envelope to follow it.)
  const wrapped = await wrap(COVER, [
    { type: 'html', subject: 'Note' },
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  const { layers } = await detectLayers(streamFromBytes(wrapped));
  assert.deepEqual(layers, ['base64', 'gzip', 'html']);
});

test('detectLayers: returned bytes match the original input', async () => {
  const wrapped = await wrap(COVER, [{ type: 'html', subject: 'Note' }]);
  const { bytes } = await detectLayers(streamFromBytes(wrapped));
  assert.equal(bytes.length, wrapped.length);
  for (let i = 0; i < wrapped.length; i++) assert.equal(bytes[i], wrapped[i]);
});

test('applyStrips: with the full detected chain recovers the cover', async () => {
  const wrapped = await wrap(COVER, [
    { type: 'html', subject: 'Note' },
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  const { layers, bytes } = await detectLayers(streamFromBytes(wrapped));
  const stripped = await streamToString(applyStrips(bytes, layers));
  assert.equal(stripped, COVER);
});

test('applyStrips: with empty chain returns the original bytes', async () => {
  const wrapped = await wrap(COVER, [{ type: 'html', subject: 'Note' }]);
  const stripped = await streamToString(applyStrips(wrapped, []));
  assert.equal(stripped, dec.decode(wrapped));
});

test('applyStrips: stripping a subset (top layer only) leaves the inner wrap intact', async () => {
  // Stack: base64 outermost, gzip middle. Strip only the base64 →
  // result is still gzipped bytes (binary). Verify first 2 bytes are
  // the gzip magic (0x1F 0x8B).
  const wrapped = await wrap(COVER, [
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  const { layers, bytes } = await detectLayers(streamFromBytes(wrapped));
  assert.deepEqual(layers, ['base64', 'gzip']);
  const partial = applyStrips(bytes, ['base64']);
  const r = partial.getReader();
  const chunks = []; let total = 0;
  for (;;) { const x = await r.read(); if (x.done) break; if (x.value) { chunks.push(x.value); total += x.value.length; } }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  assert.ok(out.length > 0);
  assert.equal(out[0], 0x1F);
  assert.equal(out[1], 0x8B);
});

test('stripWithFallback: success path returns the stripped bytes, fellBack=false', async () => {
  const wrapped = await wrap(COVER, [{ type: 'html', subject: 'Note' }]);
  const { layers, bytes } = await detectLayers(streamFromBytes(wrapped));
  const result = await stripWithFallback(bytes, layers);
  assert.equal(result.fellBack, false);
  assert.equal(dec.decode(result.bytes), COVER);
});

test('stripWithFallback: gzip strip on non-gzip input falls back to raw', async () => {
  const bytes = enc.encode('this is not gzip\n');
  const result = await stripWithFallback(bytes, ['gzip']);
  assert.equal(result.fellBack, true);
  // Some failure mode set: either error (thrown) or empty.
  // For non-gzip into DecompressionStream, expect error.
  assert.ok(result.error, 'expected decode error to be reported');
  // Fallback bytes = original input.
  assert.equal(dec.decode(result.bytes), 'this is not gzip\n');
});

test('stripWithFallback: empty strip output triggers fallback', async () => {
  // Construct an envelope whose strip yields empty body when given a
  // truncated/wrong input. html strip with input that has <pre></pre>
  // with no body content → empty output.
  const bytes = enc.encode('<!DOCTYPE html>\n<html><body><pre></pre></body></html>\n');
  const result = await stripWithFallback(bytes, ['html']);
  assert.equal(result.fellBack, true);
  assert.equal(dec.decode(result.bytes), '<!DOCTYPE html>\n<html><body><pre></pre></body></html>\n');
});

test('stripWithFallback: empty layer list returns input as-is, fellBack=false', async () => {
  const bytes = enc.encode('plain cover\n');
  const result = await stripWithFallback(bytes, []);
  assert.equal(result.fellBack, false);
  assert.equal(dec.decode(result.bytes), 'plain cover\n');
});

test('detectLayersFromFactory: detects chain without consuming the caller\'s bytes buffer', async () => {
  const wrapped = await wrap(COVER, [
    { type: 'html', subject: 'Note' },
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  // Track factory invocations so caller can re-stream from File later.
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls++;
    return streamFromBytes(wrapped);
  };
  const layers = await detectLayersFromFactory(factory);
  assert.deepEqual(layers, ['base64', 'gzip', 'html']);
  assert.equal(factoryCalls, 1);
});

test('applyStripsToStream: stream-in pipeline composes the strip chain', async () => {
  const wrapped = await wrap(COVER, [
    { type: 'html', subject: 'Note' },
    { type: 'gzip', subject: 'Note' },
    { type: 'base64', subject: 'Note' },
  ]);
  const factory = () => streamFromBytes(wrapped);
  const layers = await detectLayersFromFactory(factory);
  const stripped = await streamToString(applyStripsToStream(factory(), layers));
  assert.equal(stripped, COVER);
});
