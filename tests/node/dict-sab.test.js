// Anchor tests for the SAB-backed dict implementation. The end-to-end
// engine smokes (roundtrip.test.js) already exercise correctness via
// encode/decode round-trips on real dicts; this file pins down
// SAB-specific invariants so a future regression in the binary layout
// surfaces with a clear error rather than as a mysterious round-trip
// mismatch.
//
// See docs/architecture-sab.md for the locked-in layout.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import {
  lookupWord,
  lookupType,
  lookupTypeByName,
  readTreeNode,
  TREE_NO_NODE,
} from '../../js/src/dictionary.js';
import { SAB_CONSTANTS } from '../../js/src/builder/sab-pack.js';
import { loadDictFixture, loadDictJsonFixture, fixtureURL } from './_helpers.js';

const dict = loadDictFixture(fixtureURL('mit', import.meta.url));
// JSON-shape companion used by the cross-format invariants below.
// loadDictFixture no longer attaches a `.json` to the SAB wrapper
// because the runtime path (post sab-fixtures arc) loads SAB-only
// fixtures and never parses JSON. The cross-shape assertions still
// need both views; we unpack the SAB back to JSON for that purpose.
const dictJson = loadDictJsonFixture(fixtureURL('mit', import.meta.url));

test('sab: header has correct magic and version', () => {
  const view = new DataView(dict.sab);
  assert.equal(view.getUint32(0, true), SAB_CONSTANTS.MAGIC);
  assert.equal(view.getUint32(4, true), SAB_CONSTANTS.VERSION);
});

test('sab: header counts match JSON', () => {
  assert.equal(dict.header.typeCount, dictJson.types.length);
  assert.equal(dict.header.wordCount, dictJson.words.length);
});

test('sab: maxWordLength is the longest word in the dict', () => {
  let expected = 0;
  for (const w of dictJson.words) {
    if (w.word.length > expected) expected = w.word.length;
  }
  assert.equal(dict.maxWordLength, expected);
  assert.equal(dict.header.maxWordLength, expected);
});

test('sab: lookupWord returns null for unknown words', () => {
  assert.equal(lookupWord(dict, 'definitely-not-a-real-word-xyzzy'), null);
});

test('sab: lookupWord agrees with JSON for every word', () => {
  // Spot-check a sample to keep the test fast on large dicts.
  const words = dictJson.words;
  const N = Math.min(words.length, 200);
  for (let i = 0; i < N; i++) {
    const w = words[Math.floor(i * words.length / N)];
    const got = lookupWord(dict, w.word);
    assert.ok(got, `lookupWord("${w.word}") should not be null`);
    assert.equal(got.typeIndex, w.typeIndex);
    assert.equal(got.code, w.code);
    assert.equal(got.bits, w.bits);
  }
});

test('sab: lookupType returns null for out-of-range indices', () => {
  assert.equal(lookupType(dict, 0), null);
  assert.equal(lookupType(dict, dict.header.typeCount + 1), null);
  assert.equal(lookupType(dict, -1), null);
});

test('sab: lookupType + lookupTypeByName round-trip on every type', () => {
  for (const t of dictJson.types) {
    const byIdx = lookupType(dict, t.index);
    const byName = lookupTypeByName(dict, t.name);
    assert.ok(byIdx, `lookupType(${t.index}) should not be null`);
    assert.ok(byName, `lookupTypeByName("${t.name}") should not be null`);
    assert.equal(byIdx.typeIndex, t.index);
    assert.equal(byIdx.name, t.name);
    assert.equal(byIdx.wordCount, t.wordCount);
    assert.equal(byName.typeIndex, t.index);
    assert.equal(byName.name, t.name);
  }
});

test('sab: tree walk on every word reproduces the dict-encoded path', () => {
  // For each word, walk the tree from root following the (bits, code) path
  // and assert the reached leaf is exactly that word.
  for (const w of dictJson.words) {
    const typeRec = lookupType(dict, w.typeIndex);
    let node = readTreeNode(dict, typeRec, 0);
    if (w.bits === 0) {
      // Single-word type: root IS the leaf.
      assert.equal(node.word, w.word, `single-word type ${w.typeIndex} root should be "${w.word}"`);
      continue;
    }
    let mask = Math.pow(2, w.bits - 1);
    let code = w.code;
    for (let i = 0; i < w.bits; i++) {
      const bit = code >= mask ? 1 : 0;
      if (bit === 1) code -= mask;
      mask /= 2;
      const childIdx = bit === 0 ? node.leftChild : node.rightChild;
      assert.notEqual(childIdx, TREE_NO_NODE,
        `walking word "${w.word}" hit no-child at bit ${i + 1}/${w.bits}`);
      node = readTreeNode(dict, typeRec, childIdx);
    }
    assert.equal(node.word, w.word,
      `walked path for "${w.word}" landed on "${node.word}"`);
  }
});
