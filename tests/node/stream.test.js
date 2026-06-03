import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { BitReader, BitWriter } from '../../js/src/bitstream.js';
import { streamWrap, streamUnwrap, escapeBytes, unescapeBytes, EOF_MARKER_BYTES } from '../../js/src/stream.js';
import { mulberry32 } from '../../js/src/random.js';

function bytesToStream(bytes) {
  return new ReadableStream({
    start(c) {
      if (bytes && bytes.length > 0) c.enqueue(bytes);
      c.close();
    },
  });
}

// Pull n bytes from an AsyncBitReader (the streamWrap return shape).
const drainAsBytes = async (reader, n) => {
  const w = new BitWriter();
  for (let i = 0; i < n; i++) {
    if (!reader.hasBits(8)) await reader.refill();
    w.writeBits(reader.readBitsSync(8), 8);
  }
  return w.finish();
};

test('escapeBytes: bytes that are neither 0xAA nor 0x55 pass through', () => {
  const src = new Uint8Array([0x00, 0x01, 0x42, 0xFE, 0xFF]);
  assert.deepEqual(escapeBytes(src), src);
});

test('escapeBytes: 0xAA and 0x55 expand to 2 bytes', () => {
  assert.deepEqual(escapeBytes(new Uint8Array([0xAA])),       new Uint8Array([0x55, 0x8A]));
  assert.deepEqual(escapeBytes(new Uint8Array([0x55])),       new Uint8Array([0x55, 0x75]));
  assert.deepEqual(escapeBytes(new Uint8Array([0xAA, 0xAA])), new Uint8Array([0x55, 0x8A, 0x55, 0x8A]));
});

test('escape/unescape round-trip on every possible byte', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual(unescapeBytes(escapeBytes(all)), all);
});

test('escape/unescape round-trip on random sequences', () => {
  const rng = mulberry32(42);
  for (const len of [0, 1, 7, 8, 100, 1000]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(rng() * 256);
    assert.deepEqual(unescapeBytes(escapeBytes(bytes)), bytes);
  }
});

test('streamWrap: empty payload, first 4 bytes are the marker', async () => {
  const reader = streamWrap(bytesToStream(new Uint8Array(0)));
  const first4 = await drainAsBytes(reader, 4);
  assert.deepEqual(first4, EOF_MARKER_BYTES);
});

test('streamWrap: 0xAA-only payload is fully escaped before marker', async () => {
  const reader = streamWrap(bytesToStream(new Uint8Array([0xAA, 0xAA])));
  // Expect 4 escaped bytes (2 0xAAs x 2 bytes each) + 4 marker bytes
  const eight = await drainAsBytes(reader, 8);
  assert.deepEqual(eight, new Uint8Array([0x55, 0x8A, 0x55, 0x8A, 0xAA, 0xAA, 0xAA, 0xAA]));
});

test('streamWrap to streamUnwrap round-trip on various payloads', async () => {
  for (const len of [0, 1, 7, 8, 9, 100, 1000]) {
    const rng = mulberry32(len * 13 + 7);
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = Math.floor(rng() * 256);
    const reader = streamWrap(bytesToStream(payload));
    // Drain into a byte buffer the way the encoder/decoder pipeline does.
    // Just the meaningful bytes (escaped + marker), no random tail.
    const escapedLen = escapeBytes(payload).length;
    const wireBytes = await drainAsBytes(reader, escapedLen + 4);
    assert.deepEqual(streamUnwrap(wireBytes), payload, `len ${len}`);
  }
});

test('streamUnwrap: stops at the marker, ignores trailing garbage', async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const reader = streamWrap(bytesToStream(payload));
  const meaningful = await drainAsBytes(reader, 5 + 4); // payload + marker
  const w = new BitWriter();
  for (const b of meaningful) w.writeBits(b, 8);
  for (let i = 0; i < 100; i++) w.writeBits(0xCC, 8); // random garbage after
  assert.deepEqual(streamUnwrap(w.finish()), payload);
});

test('streamUnwrap: graceful on a corrupt marker (returns what we have)', () => {
  // Hand-build a stream where 0xAA appears in the middle (looks like marker)
  // but the next 3 bytes aren't all 0xAA. We bail with the bytes already
  // consumed before the false-positive marker.
  const bytes = new Uint8Array([0x42, 0xAA, 0xAA, 0x42, 0xAA]);
  const recovered = streamUnwrap(bytes);
  assert.deepEqual(recovered, new Uint8Array([0x42]));
});

test('streamUnwrap: graceful on EOF before any marker', () => {
  // Random bytes with no marker at all → return all of them.
  assert.deepEqual(streamUnwrap(new Uint8Array([1, 2, 3])), new Uint8Array([1, 2, 3]));
  // Empty input → empty output, no throw.
  assert.deepEqual(streamUnwrap(new Uint8Array(0)), new Uint8Array(0));
});

test('streamUnwrap: graceful on truncated escape sequence', () => {
  // 0x55 at the very end with no follow-up byte. Stop, return what we had.
  assert.deepEqual(streamUnwrap(new Uint8Array([0x42, 0x55])), new Uint8Array([0x42]));
});

test('decode: garbage cover text returns SOMETHING, never throws (best-effort)', async () => {
  const { decodeToBytes, loadDictFixture, fixtureURL } = await import('./_helpers.js');
  const dict = loadDictFixture(fixtureURL('mit', import.meta.url));
  // Random English text that's not from our encoder
  await assert.doesNotReject(decodeToBytes('Lorem ipsum dolor sit amet, consectetur adipiscing elit.', dict));
  // Pure punctuation
  await assert.doesNotReject(decodeToBytes('!!! ??? ... ,,,', dict));
  // Empty-ish
  await assert.doesNotReject(decodeToBytes('   \n\n   ', dict));
});

test('encode → decode round-trip preserves payload (live integration)', async () => {
  const { weightedTypeStream } = await import('../../js/src/typestream.js');
  const { encodeToString, decodeToBytes, loadDictFixture, fixtureURL } = await import('./_helpers.js');
  const dict = loadDictFixture(fixtureURL('mit', import.meta.url));
  for (const text of ['hi', 'hello world', 'A long-ish payload to encode round-trip.']) {
    const stream = weightedTypeStream(dict, { random: mulberry32(7) });
    const cover = await encodeToString(new TextEncoder().encode(text), dict, { typeStream: stream, randomSeed: 99 });
    const recovered = new TextDecoder().decode(await decodeToBytes(cover, dict));
    assert.equal(recovered, text);
  }
});
