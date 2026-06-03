// Tests for the FNV-1a 32-bit streaming fingerprint used by encode()'s
// validate option. Covers known vectors, streaming-equals-one-shot,
// and basic divergence-detection sanity.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { Fingerprint, fingerprintBytes, fingerprintSink } from '../../js/src/fingerprint.js';

const enc = new TextEncoder();

test('empty input → FNV offset basis', () => {
  assert.equal(fingerprintBytes(new Uint8Array(0)), 0x811c9dc5);
});

test('FNV-1a 32-bit known vector: "a"', () => {
  assert.equal(fingerprintBytes(enc.encode('a')), 0xe40c292c);
});

test('FNV-1a 32-bit known vector: "foobar"', () => {
  assert.equal(fingerprintBytes(enc.encode('foobar')), 0xbf9cf968);
});

test('streaming chunked input matches single-shot input', () => {
  const data = enc.encode('the quick brown fox jumps over the lazy dog');
  const oneShot = fingerprintBytes(data);
  // Try several chunk boundaries.
  for (const chunkSize of [1, 3, 7, 16, data.length - 1, data.length]) {
    const fp = new Fingerprint();
    for (let i = 0; i < data.length; i += chunkSize) {
      fp.update(data.subarray(i, Math.min(i + chunkSize, data.length)));
    }
    assert.equal(fp.digest(), oneShot, `chunk size ${chunkSize} diverged`);
  }
});

test('one-byte difference produces different digest', () => {
  const a = enc.encode('hello world');
  const b = enc.encode('hello World');
  assert.notEqual(fingerprintBytes(a), fingerprintBytes(b));
});

test('different lengths produce different digests', () => {
  assert.notEqual(fingerprintBytes(enc.encode('foo')), fingerprintBytes(enc.encode('foobar')));
});

test('digest is unsigned 32-bit', () => {
  // High bit set in offset basis; ensure digest() returns a JS number
  // in [0, 2^32) not a sign-extended negative.
  const d = fingerprintBytes(new Uint8Array(0));
  assert.ok(d >= 0);
  assert.ok(d <= 0xffffffff);
});

test('fingerprintSink pipes a stream into a Fingerprint', async () => {
  const { writable, fingerprint } = fingerprintSink();
  const writer = writable.getWriter();
  await writer.write(enc.encode('foo'));
  await writer.write(enc.encode('bar'));
  await writer.close();
  assert.equal(fingerprint.digest(), 0xbf9cf968); // "foobar"
});

test('two independent Fingerprints over identical input agree', () => {
  // The validate plumbing relies on this: source-side hash and
  // decoded-side hash are independent instances and must agree iff
  // bytes match.
  const data = enc.encode('round-trip should match');
  const a = new Fingerprint();
  const b = new Fingerprint();
  a.update(data);
  b.update(data);
  assert.equal(a.digest(), b.digest());
});
