// typehash.test.js: hash + dehash for sortDict's merged-type strings.
//
// Covers:
//   1. hashMergedType is deterministic, 11 chars, URL-safe-base64 alphabet only.
//   2. dehashDict resolves a flat (non-layered) hashmap.
//   3. dehashDict resolves a layered hashmap (layer-2 hash references layer-1 hash).
//   4. Atomic tokens (non-hash strings present in the merged-string but
//      not in the map) pass through as-is.
//   5. Round-trip: await sortDict(t0, {hashed:true,hashMap:M}) → dehashDict
//      yields per-word atomic-type-sets equivalent to await sortDict(t0)
//      without hashing.
//   6. Layered round-trip: two sortDict calls sharing a single hashMap
//      (the t0-collapse + final-merge pattern), then dehash, matches
//      the un-hashed equivalent.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { hashMergedType, dehashDict } from '../../js/src/builder/typehash.js';
import { sortDict } from '../../js/src/builder/sortdct.js';

const URL_B64_RE = /^[A-Za-z0-9_-]+$/;

test('hashMergedType: deterministic + 11 chars + URL-safe-b64', async () => {
  const a = hashMergedType('noun_object,em16_heart');
  const b = hashMergedType('noun_object,em16_heart');
  assert.equal(a, b);
  assert.equal(a.length, 11);
  assert.match(a, URL_B64_RE);
});

test('hashMergedType: different inputs → different hashes', async () => {
  const a = hashMergedType('noun_object,em16_heart');
  const b = hashMergedType('noun_object,em16_face_smile');
  assert.notEqual(a, b);
});

test('dehashDict: flat map, no layering', async () => {
  const h1 = hashMergedType('A,B');
  const h2 = hashMergedType('C,D');
  const map = new Map([
    [h1, 'A,B'],
    [h2, 'C,D'],
  ]);
  const dict = {
    types: [
      { name: h1, other: 1 },
      { name: h2, other: 2 },
    ],
    other: 'preserved',
  };
  const d = dehashDict(dict, map);
  assert.equal(d.types[0].name, 'A,B');
  assert.equal(d.types[1].name, 'C,D');
  assert.equal(d.types[0].other, 1);     // pass-through fields
  assert.equal(d.other, 'preserved');     // pass-through top-level
});

test('dehashDict: layered map, layer-2 references layer-1', async () => {
  const h1 = hashMergedType('A,B');
  // Layer-2 stored value contains the layer-1 hash as a token.
  const h2Stored = `${h1},C,D`;
  const h2 = hashMergedType(h2Stored);
  const map = new Map([
    [h1, 'A,B'],
    [h2, h2Stored],
  ]);
  const dict = { types: [{ name: h2 }] };
  const d = dehashDict(dict, map);
  // h2 should resolve to A,B,C,D (sorted, atomic).
  assert.equal(d.types[0].name, 'A,B,C,D');
});

test('dehashDict: atomic tokens pass through unchanged', async () => {
  // Uses an arbitrary atomic type ('xanax_a' picked because it's a
  // live source-type name post-cover-transforms; previously this
  // test used the retired 'begins_with_a_vowel').
  const h1 = hashMergedType('A,B');
  const h2 = hashMergedType(`${h1},xanax_a`);
  const map = new Map([
    [h1, 'A,B'],
    [h2, `${h1},xanax_a`],
  ]);
  const dict = { types: [{ name: h2 }] };
  const d = dehashDict(dict, map);
  assert.equal(d.types[0].name, 'A,B,xanax_a');
});

test('dehashDict: missing hash in map → token left as-is', async () => {
  // Defensive: if a hash isn't in the map (shouldn't normally happen
  // but useful as a non-throwing fallback), it passes through verbatim.
  const dict = { types: [{ name: 'unknown_hash_xyz' }] };
  const d = dehashDict(dict, new Map());
  assert.equal(d.types[0].name, 'unknown_hash_xyz');
});

// Round-trip: sortDict on the same input with vs without hashing should
// produce the same per-word atomic-type-set after dehash.
test('round-trip: sortDict hashed + dehash matches sortDict raw', async () => {
  const twlist = [
    { type: 'noun_object', word: 'heart' },
    { type: 'em16_heart',  word: 'heart' },
    { type: 'noun_feeling', word: 'love' },
    { type: 'noun_object', word: 'box' },
    { type: 'verb_action', word: 'shine' },
  ];
  const raw = await sortDict(twlist);
  const map = new Map();
  const hashed = await sortDict(twlist, { hashed: true, hashMap: map });
  // Build pseudo-dict from each output (just the type names matter).
  const hashedDict = { types: dedupeTypeNames(hashed) };
  const dehashed = dehashDict(hashedDict, map);
  // Compare per-word type-set: atomic-set equality.
  const rawByWord = wordToAtomicSet(raw);
  const dehashedByWord = wordToAtomicSet(joinDehashed(hashed, dehashed));
  for (const [w, set] of rawByWord) {
    const got = dehashedByWord.get(w);
    assert.ok(got, `missing word in dehashed: "${w}"`);
    assert.deepEqual([...got].sort(), [...set].sort(),
      `word "${w}": expected ${[...set].sort()}, got ${[...got].sort()}`);
  }
});

// Layered round-trip: simulate the t0-collapse + final-merge pattern.
// Two sortDict calls share a single hashMap; the second call's input
// contains hashes from the first call as type strings.
test('layered round-trip: two sortDict passes sharing one hashMap', async () => {
  const t0 = [
    { type: 'A', word: 'apple' },
    { type: 'B', word: 'apple' },
    { type: 'C', word: 'banana' },
  ];
  const aug = [
    { type: 'X', word: 'apple' },        // adds atomic X to apple
    { type: 'Y,Z', word: 'banana' },     // adds atomics Y,Z to banana
  ];
  const map = new Map();

  // Pass 1: collapse t0 with hashing.
  const t0Hashed = await sortDict(t0, { hashed: true, hashMap: map });
  // t0Hashed entries: { type: hash, word }. apple → hash(A,B); banana → hash(C).

  // Pass 2: merge t0Hashed with aug emissions.
  const finalHashed = await sortDict([...t0Hashed, ...aug], { hashed: true, hashMap: map });

  // Build pseudo-dict + dehash.
  const dict = { types: dedupeTypeNames(finalHashed) };
  const dehashed = dehashDict(dict, map);

  // Compare to the un-hashed equivalent: just merge t0+aug raw.
  const raw = await sortDict([...t0, ...aug]);
  const rawByWord = wordToAtomicSet(raw);
  const dehashedByWord = wordToAtomicSet(joinDehashed(finalHashed, dehashed));
  for (const [w, set] of rawByWord) {
    const got = dehashedByWord.get(w);
    assert.ok(got, `missing word in dehashed: "${w}"`);
    assert.deepEqual([...got].sort(), [...set].sort(),
      `word "${w}": expected ${[...set].sort()}, got ${[...got].sort()}`);
  }
});

// ---------- helpers ----------

function dedupeTypeNames(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.type)) continue;
    seen.add(e.type);
    out.push({ name: e.type });
  }
  return out;
}
function wordToAtomicSet(arr) {
  const m = new Map();
  for (const e of arr) {
    if (!m.has(e.word)) m.set(e.word, new Set());
    const set = m.get(e.word);
    for (const part of (e.type ?? '').split(',')) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  return m;
}
// Stitch dehashed type names back onto the hashed entries by index of
// hash → name in the dehashed dict.types. Returns array of {type, word}
// where type is the dehashed (atomic-comma-joined) name.
function joinDehashed(hashedEntries, dehashedDict) {
  const hashToName = new Map();
  for (const t of dehashedDict.types) {
    // dehashedDict.types preserves the order of the dedupe; we don't
    // have the original hash, so build by reconstructing from input order.
  }
  // Simpler: iterate hashedEntries in order, look up dehashed name by
  // matching the hash to dehashedDict.types entries via dedupeTypeNames
  // ordering.
  const seen = new Map(); // hash → dehashed name
  let idx = 0;
  const seenSet = new Set();
  for (const e of hashedEntries) {
    if (seenSet.has(e.type)) continue;
    seenSet.add(e.type);
    seen.set(e.type, dehashedDict.types[idx].name);
    idx++;
  }
  return hashedEntries.map(e => ({ type: seen.get(e.type), word: e.word }));
}
