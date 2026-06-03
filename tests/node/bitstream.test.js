import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { BitReader, BitWriter } from '../../js/src/bitstream.js';

test('BitWriter: MSB-first within byte', () => {
  // Write 0b101 then 0b11 then 0b000 → byte = 1011_1000 = 0xB8
  const w = new BitWriter();
  w.writeBits(0b101, 3);
  w.writeBits(0b11, 2);
  w.writeBits(0b000, 3);
  const bytes = w.finish();
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0xB8);
});

test('BitWriter: trailing partial byte is zero-padded', () => {
  const w = new BitWriter();
  w.writeBits(0b1, 1);
  const bytes = w.finish();
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0x80);
});

test('BitWriter: writeBits(0, 0) is a no-op', () => {
  const w = new BitWriter();
  w.writeBits(0, 0);
  assert.equal(w.finish().length, 0);
});

test('BitWriter: bitsWritten counter', () => {
  const w = new BitWriter();
  w.writeBits(0xff, 8);
  w.writeBits(0b101, 3);
  assert.equal(w.bitsWritten, 11);
});

test('BitWriter: writeBits rejects n out of range', () => {
  const w = new BitWriter();
  assert.throws(() => w.writeBits(0, -1), RangeError);
  assert.throws(() => w.writeBits(0, 54), RangeError);
});

test('BitReader: MSB-first within byte', () => {
  // 0xB8 = 1011_1000 → reads should give 1,0,1,1,1,0,0,0
  const r = new BitReader(new Uint8Array([0xB8]));
  assert.equal(r.readBits(3), 0b101);
  assert.equal(r.readBits(2), 0b11);
  assert.equal(r.readBits(3), 0b000);
});

test('BitReader: zero-fill past EOF when no random source', () => {
  const r = new BitReader(new Uint8Array([0xff]));
  assert.equal(r.readBits(8), 0xff);
  assert.equal(r.exhausted, false);
  assert.equal(r.readBits(8), 0);
  assert.equal(r.exhausted, true);
});

test('BitReader: random source past EOF', () => {
  // randomBits returns [0, 1) like Math.random; reader scales to a byte.
  let calls = 0;
  const rng = () => { calls++; return 0x42 / 256; }; // produces byte 0x42
  const r = new BitReader(new Uint8Array([0xff]), { randomBits: rng });
  r.readBits(8);
  assert.equal(r.readBits(8), 0x42);
  assert.equal(calls, 1);
  assert.equal(r.tailBitsRead, 8);
});

test('round-trip: random bytes through Writer then Reader', () => {
  // Generate 1000 random bytes, write byte-by-byte, then read back byte-by-byte.
  const original = new Uint8Array(1000);
  for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff;
  const w = new BitWriter();
  for (const b of original) w.writeBits(b, 8);
  const bytes = w.finish();
  assert.deepEqual(bytes, original);
  const r = new BitReader(bytes);
  for (let i = 0; i < original.length; i++) {
    assert.equal(r.readBits(8), original[i]);
  }
});

test('round-trip: variable bit-width writes/reads', () => {
  const widths = [1, 2, 3, 5, 7, 8, 9, 11, 13, 16, 17, 23, 32];
  const values = [1, 2, 5, 17, 100, 200, 511, 1500, 7777, 0xCAFE, 0x1FFFF, 0x7FFFFF, 0xDEADBEEF];
  const masked = (v, w) => (w === 32 ? (v >>> 0) : ((v & ((1 << w) - 1)) >>> 0));
  const writer = new BitWriter();
  for (let i = 0; i < widths.length; i++) {
    writer.writeBits(masked(values[i], widths[i]), widths[i]);
  }
  const bytes = writer.finish();
  const r = new BitReader(bytes);
  for (let i = 0; i < widths.length; i++) {
    assert.equal(r.readBits(widths[i]), masked(values[i], widths[i]), `width ${widths[i]}`);
  }
});

test('round-trip: write-bytes vs write-bits-one-at-a-time give same output', () => {
  const src = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
  const wA = new BitWriter();
  for (const b of src) wA.writeBits(b, 8);
  const wB = new BitWriter();
  for (const b of src) {
    for (let i = 7; i >= 0; i--) wB.writeBits((b >>> i) & 1, 1);
  }
  assert.deepEqual(wA.finish(), wB.finish());
});
