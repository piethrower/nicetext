// entries-sab.test.js: pack/unpack round-trip and SAB-native dedup
// table behaviors for the aug-pipeline foundation. See
// docs/research-notes.md §18.4.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  createEntriesSAB,
  wrapEntriesSAB,
  appendEntry,
  entryAt,
  entryCount,
  poolUsed,
  iterEntries,
  packEntries,
  unpackEntries,
  createDedupTable,
  wrapDedupTable,
  dedupHas,
  dedupAdd,
  dedupHasJSKey,
  dedupOccupied,
  dedupSlotCountFor,
} from '../../js/src/builder/entries-sab.js';

// ---------- entries-SAB pack/unpack ----------

test('pack + unpack: round-trip a small entries array', () => {
  const entries = [
    { type: 'noun', word: 'cat' },
    { type: 'noun', word: 'dog' },
    { type: 'verb', word: 'run' },
    { type: 'em16_face_smile', word: '😀' },
    { type: 'phrase', word: 'happy 😀' },
  ];
  const view = packEntries(entries);
  assert.equal(entryCount(view), entries.length);
  const out = unpackEntries(view);
  assert.deepEqual(out, entries);
});

test('pack + transfer: re-wrap a SAB after sending across a boundary', () => {
  const entries = [{ type: 'a', word: 'x' }, { type: 'b', word: 'y' }];
  const view = packEntries(entries);
  // Simulate worker boundary: only the SAB ref crosses, the wrap is
  // re-derived on the other side.
  const reWrapped = wrapEntriesSAB(view.sab);
  const out = unpackEntries(reWrapped);
  assert.deepEqual(out, entries);
});

test('appendEntry: returns false on entry-table capacity overflow', () => {
  const view = createEntriesSAB(2, 1024);
  assert.ok(appendEntry(view, 'a', 'x'));
  assert.ok(appendEntry(view, 'b', 'y'));
  assert.equal(appendEntry(view, 'c', 'z'), false, 'third append exceeds entryCapacity');
});

test('appendEntry: returns false on string-pool overflow', () => {
  // Pool capacity exactly fits one (1B + 1B + 1B + 1B) = 4B + the
  // u16 length prefixes (2 bytes each) = 6 bytes. Allocate 5 to force
  // overflow on the very first append.
  const view = createEntriesSAB(10, 5);
  assert.equal(appendEntry(view, 'a', 'b'), false);
});

test('iterEntries: order matches insertion', () => {
  const entries = [
    { type: 't', word: '1' },
    { type: 't', word: '2' },
    { type: 't', word: '3' },
  ];
  const view = packEntries(entries);
  const out = [...iterEntries(view)];
  assert.deepEqual(out, entries);
});

test('UTF-8 round-trip: emoji + multi-byte scripts survive', () => {
  const entries = [
    { type: 'em', word: '🌹' },
    { type: 'em', word: '🌧️' }, // includes variation selector
    { type: 'cyr', word: 'привет' },
    { type: 'jp', word: 'こんにちは' },
    { type: 'mixed', word: 'happy 😀' },
  ];
  const view = packEntries(entries);
  const out = unpackEntries(view);
  assert.deepEqual(out, entries);
});

test('poolUsed accounting matches the decoded back', () => {
  const view = createEntriesSAB(3, 1024);
  appendEntry(view, 'a', 'b');
  // 1B 'a' + 1B 'b' + 2 length prefixes = 6 bytes
  assert.equal(poolUsed(view), 6);
  appendEntry(view, 'noun', 'cat');
  // +4 +3 +2+2 = 11 → 6 + 11 = 17
  assert.equal(poolUsed(view), 17);
});

test('packEntries throws on a string longer than 65535 bytes', () => {
  const huge = 'x'.repeat(65536);
  assert.throws(() => packEntries([{ type: 't', word: huge }]), /65535/);
});

// ---------- dedup table ----------

test('dedupSlotCountFor: rounds up to next power of two with min 16', () => {
  assert.equal(dedupSlotCountFor(0), 16);
  assert.equal(dedupSlotCountFor(1), 16);
  assert.equal(dedupSlotCountFor(8), 16); // 2*8 = 16
  assert.equal(dedupSlotCountFor(9), 32); // 2*9 = 18 → 32
  assert.equal(dedupSlotCountFor(64), 128); // 2*64 = 128
  assert.equal(dedupSlotCountFor(100), 256);
});

test('dedupTable: createDedupTable rejects non-power-of-two', () => {
  assert.throws(() => createDedupTable(15), /power of two/);
  assert.throws(() => createDedupTable(0), /positive/);
});

test('dedupTable: detects duplicates against an entries-SAB', () => {
  const entries = [
    { type: 'noun', word: 'cat' },
    { type: 'noun', word: 'dog' },
    { type: 'verb', word: 'run' },
  ];
  const view = packEntries(entries);
  const table = createDedupTable(dedupSlotCountFor(entries.length));
  for (let i = 0; i < entries.length; i++) {
    const inserted = dedupAdd(table, view, i);
    assert.equal(inserted, true, `entry ${i} should be a fresh insert`);
  }
  assert.equal(dedupOccupied(table), entries.length);
  // Querying for a present key returns true.
  assert.equal(dedupHasJSKey(table, view, 'noun', 'cat'), true);
  assert.equal(dedupHasJSKey(table, view, 'verb', 'run'), true);
  // Querying for an absent key returns false.
  assert.equal(dedupHasJSKey(table, view, 'noun', 'fish'), false);
  assert.equal(dedupHasJSKey(table, view, 'verb', 'cat'), false);
});

test('dedupTable: re-adding the same entry index returns false (already present)', () => {
  const view = packEntries([{ type: 'noun', word: 'cat' }]);
  const table = createDedupTable(16);
  assert.equal(dedupAdd(table, view, 0), true);
  assert.equal(dedupAdd(table, view, 0), false);
  assert.equal(dedupOccupied(table), 1);
});

test('dedupTable: distinguishes (a, b) from (b, a)', () => {
  const view = packEntries([
    { type: 'a', word: 'b' },
    { type: 'b', word: 'a' },
  ]);
  const table = createDedupTable(16);
  assert.equal(dedupAdd(table, view, 0), true);
  assert.equal(dedupAdd(table, view, 1), true);
  assert.equal(dedupOccupied(table), 2);
  assert.equal(dedupHasJSKey(table, view, 'a', 'b'), true);
  assert.equal(dedupHasJSKey(table, view, 'b', 'a'), true);
});

test('dedupTable: full table throws on insert', () => {
  // 16-slot table; load it past capacity with unique entries.
  const list = [];
  for (let i = 0; i < 17; i++) list.push({ type: 't', word: `w${i}` });
  const view = packEntries(list);
  const table = createDedupTable(16);
  // Fill 15 (load factor 15/16 ~= 0.94). The next insert may succeed
  // depending on probe luck, but at some point we'll throw.
  let inserted = 0;
  let threw = false;
  try {
    for (let i = 0; i < list.length; i++) {
      dedupAdd(table, view, i);
      inserted++;
    }
  } catch (err) {
    threw = true;
    assert.match(err.message, /full/);
  }
  assert.ok(threw, 'eventually threw on full table');
  assert.ok(inserted < list.length, 'didn\'t insert all entries');
});

test('dedupTable: byte-level distinction for matching JS strings vs distinct UTF-8', () => {
  // 'á' as precomposed (U+00E1) vs decomposed (U+0061 U+0301), the
  // bytes differ even though they may render identically. Dedup
  // should treat them as distinct.
  const precomposed = 'á';
  const decomposed = 'á';
  assert.notEqual(precomposed, decomposed);
  const view = packEntries([
    { type: 't', word: precomposed },
    { type: 't', word: decomposed },
  ]);
  const table = createDedupTable(16);
  assert.equal(dedupAdd(table, view, 0), true);
  assert.equal(dedupAdd(table, view, 1), true);
});

test('dedupTable: wrapDedupTable round-trips across SAB transfer', () => {
  const view = packEntries([{ type: 'a', word: 'b' }]);
  const table = createDedupTable(16);
  dedupAdd(table, view, 0);
  // Re-wrap from raw SAB.
  const rewrapped = wrapDedupTable(table.sab);
  assert.equal(dedupHasJSKey(rewrapped, view, 'a', 'b'), true);
  assert.equal(dedupOccupied(rewrapped), 1);
});

test('dedupHas: cross-SAB lookup with a separate keyView buffer', () => {
  const view = packEntries([{ type: 'noun', word: 'cat' }]);
  const table = createDedupTable(16);
  dedupAdd(table, view, 0);
  // Construct a keyView that's NOT the entries SAB. Encode the same
  // (type, word) pair into a separate buffer and call dedupHas via
  // raw spans.
  const enc = new TextEncoder();
  const t = enc.encode('noun');
  const w = enc.encode('cat');
  const buf = new Uint8Array(t.length + w.length);
  buf.set(t, 0);
  buf.set(w, t.length);
  const keyView = { bytes: buf };
  assert.equal(
    dedupHas(table, view, keyView, 0, t.length, t.length, w.length),
    true,
    'cross-SAB key lookup hits',
  );
});
