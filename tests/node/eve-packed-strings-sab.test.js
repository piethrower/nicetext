// packed-strings-sab: round-trip tests for the SAB-backed string
// array used by Eve's load-twlist and load-corpus-precompute job
// results. Verifies the layout's iteration and sorted-membership
// reader on a range of input sizes, including a synthetic ~250k-
// string set so the binary-search code path sees a non-trivial
// span.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  packStrings,
  wrapPackedStrings,
  copyIntoSharedArrayBuffer,
} from '../../js/src/eve/packed-strings-sab.js';

test('packed-strings: empty input round-trips', () => {
  const buf = packStrings([]);
  const v = wrapPackedStrings(buf);
  assert.equal(v.count, 0);
  assert.deepEqual([...v.iterate()], []);
  assert.equal(v.hasSorted('anything'), false);
});

test('packed-strings: single-item round-trip and membership', () => {
  const buf = packStrings(['hello']);
  const v = wrapPackedStrings(buf);
  assert.equal(v.count, 1);
  assert.equal(v.at(0), 'hello');
  assert.deepEqual([...v.iterate()], ['hello']);
  assert.equal(v.hasSorted('hello'), true);
  assert.equal(v.hasSorted('helio'), false);
});

test('packed-strings: preserves order across iterate()', () => {
  const input = ['zebra', 'apple', 'mango', 'apple']; // intentional dupe + unsorted
  const buf = packStrings(input);
  const v = wrapPackedStrings(buf);
  assert.equal(v.count, 4);
  assert.deepEqual([...v.iterate()], input);
});

test('packed-strings: sorted membership on sorted-unique input', () => {
  const sorted = ['apple', 'banana', 'cherry', 'date', 'elder'];
  const buf = packStrings(sorted);
  const v = wrapPackedStrings(buf);
  for (const w of sorted) assert.equal(v.hasSorted(w), true, `present: ${w}`);
  for (const w of ['ape', 'bananaa', 'cocoa', 'date2', 'fig']) {
    assert.equal(v.hasSorted(w), false, `absent: ${w}`);
  }
});

test('packed-strings: utf-8 multi-byte strings survive', () => {
  const input = ['café', '日本語', 'naïve', '🦊'];
  const buf = packStrings(input);
  const v = wrapPackedStrings(buf);
  for (let i = 0; i < input.length; i++) {
    assert.equal(v.at(i), input[i]);
  }
});

test('packed-strings: large sorted set membership (250k entries)', () => {
  const N = 250_000;
  const sorted = [];
  for (let i = 0; i < N; i++) sorted.push(`w${String(i).padStart(8, '0')}`);
  const buf = packStrings(sorted);
  const v = wrapPackedStrings(buf);
  assert.equal(v.count, N);
  assert.equal(v.hasSorted('w00000000'), true);
  assert.equal(v.hasSorted('w00012345'), true);
  assert.equal(v.hasSorted(`w${String(N - 1).padStart(8, '0')}`), true);
  assert.equal(v.hasSorted('w99999999'), false);
  assert.equal(v.hasSorted('zzzzz'), false);
  assert.equal(v.hasSorted('aaaa'), false);
});

test('packed-strings: shared option returns SharedArrayBuffer', () => {
  const buf = packStrings(['x', 'y'], { shared: true });
  assert.equal(typeof SharedArrayBuffer !== 'undefined', true);
  // node and modern browsers both expose SharedArrayBuffer; the
  // shared flag should pick it.
  assert.equal(buf instanceof SharedArrayBuffer, true);
  const v = wrapPackedStrings(buf);
  assert.deepEqual([...v.iterate()], ['x', 'y']);
});

test('packed-strings: default (non-shared) returns ArrayBuffer', () => {
  const buf = packStrings(['x', 'y']);
  assert.equal(buf instanceof ArrayBuffer, true);
});

test('packed-strings: copyIntoSharedArrayBuffer mirrors bytes', () => {
  const src = packStrings(['alpha', 'beta', 'gamma']);
  const sab = copyIntoSharedArrayBuffer(src);
  assert.equal(sab instanceof SharedArrayBuffer, true);
  assert.equal(sab.byteLength, src.byteLength);
  const v = wrapPackedStrings(sab);
  assert.deepEqual([...v.iterate()], ['alpha', 'beta', 'gamma']);
});

test('packed-strings: wrapPackedStrings throws on bad magic', () => {
  const buf = new ArrayBuffer(16);
  assert.throws(() => wrapPackedStrings(buf), /bad magic/);
});

test('packed-strings: at() bounds-check', () => {
  const v = wrapPackedStrings(packStrings(['a', 'b']));
  assert.throws(() => v.at(-1), /out of range/);
  assert.throws(() => v.at(2), /out of range/);
});

test('packed-strings: non-string entry throws at pack time', () => {
  assert.throws(() => packStrings(['ok', 42, 'also-ok']), /must be a string/);
});
