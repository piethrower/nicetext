// Anchor tests for the SAB-backed CFG-grammar implementation. Mirrors
// dict-sab.test.js and modeltable-sab.test.js: pin down the binary
// layout invariants and exercise a full encode/decode round-trip
// through modelStream so a future regression surfaces with a clear
// test failure rather than as a mysterious cover-text mismatch.
//
// See docs/architecture-sab.md (CFG grammar layout section) and
// js/src/builder/grammar-pack.js for the layout being verified.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';
import { parseGrammar } from '../../js/src/grammar/parser.js';
import { loadGrammar, makeModel, modelStream } from '../../js/src/grammar/expand.js';
import { GRAMMAR_SAB_CONSTANTS } from '../../js/src/builder/grammar-pack.js';
import { encodeToString, decodeToBytes, loadDictFixture, fixtureURL } from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

const dict = loadDictFixture(fixtureURL('mit', import.meta.url));

test('grammar-sab: header has correct magic and version', () => {
  const g = loadGrammar(parseGrammar('S: a b ;'));
  const view = new DataView(g.sab);
  assert.equal(view.getUint32(0, true), GRAMMAR_SAB_CONSTANTS.MAGIC);
  assert.equal(view.getUint32(4, true), GRAMMAR_SAB_CONSTANTS.VERSION);
});

test('grammar-sab: rule count, alt count, name count match parsed grammar', () => {
  const g = loadGrammar(parseGrammar('S: a @5 | b c @3 ; T: d ;'));
  assert.equal(g.header.ruleCount, 2);    // S, T
  assert.equal(g.header.altCount, 3);     // 2 in S, 1 in T
  assert.equal(g.header.punctCount, 0);
  assert.equal(g.header.nameCount, 4);    // a, b, c, d (none are rule names)
});

test('grammar-sab: rule-ref vs name-ref classification', () => {
  // S references both a rule (T) and a non-rule (foo). Pack-time
  // classification: tok 0 of S's only alt = rule-ref to T (idx 1);
  // tok 1 = name-ref to "foo".
  const parsed = parseGrammar('S: T foo ; T: bar ;');
  const g = loadGrammar(parsed);
  const tokenOff = g.view.getUint32(g.header.altTableOffset + 4, true);
  const tok0 = g.view.getUint32(tokenOff + 0, true);
  const tok1 = g.view.getUint32(tokenOff + 4, true);
  const kind0 = (tok0 >>> GRAMMAR_SAB_CONSTANTS.TOKEN_KIND_SHIFT) & 3;
  const kind1 = (tok1 >>> GRAMMAR_SAB_CONSTANTS.TOKEN_KIND_SHIFT) & 3;
  assert.equal(kind0, GRAMMAR_SAB_CONSTANTS.KIND_RULE_REF, 'tok 0 should be rule-ref');
  assert.equal(kind1, GRAMMAR_SAB_CONSTANTS.KIND_NAME_REF, 'tok 1 should be name-ref');
});

test('grammar-sab: punct kind in tokens', () => {
  const g = loadGrammar(parseGrammar('S: a {Cap} b ;'));
  // Find S's only alt and its 3 tokens. Middle one should be punct.
  const tokenOff = g.view.getUint32(g.header.altTableOffset + 4, true);
  const tok1 = g.view.getUint32(tokenOff + 4, true);
  const kind1 = (tok1 >>> GRAMMAR_SAB_CONSTANTS.TOKEN_KIND_SHIFT) & 3;
  assert.equal(kind1, GRAMMAR_SAB_CONSTANTS.KIND_PUNCT);
});

test('grammar-sab: makeModel produces expected structure', () => {
  const g = loadGrammar(parseGrammar('S: A B ; A: foo ; B: {Cap} bar ;'));
  const m = makeModel(g, { random: () => 0 });
  assert.deepEqual(m.map(x => x.kind), ['type', 'punct', 'type']);
  assert.deepEqual(m.map(x => x.kind === 'type' ? x.name : x.value), ['foo', 'Cap', 'bar']);
});

test('grammar-sab: weighted picks respect weights', () => {
  const g = loadGrammar(parseGrammar('S: low @1 | high @99 ;'));
  let m = makeModel(g, { random: () => 0 });
  assert.equal(m[0].name, 'low');
  m = makeModel(g, { random: () => 0.5 });
  assert.equal(m[0].name, 'high');
});

test('grammar-sab: recursive grammar terminates via skip+retry', () => {
  const g = loadGrammar(parseGrammar('S: a S @99 | x @1 ;'));
  const m = makeModel(g, { random: mulberry32(42), maxLength: 50 });
  assert.ok(m.length <= 50);
});

test('grammar-sab: end-to-end round-trip with mit-names.def + the mit card dict', async () => {
  const grammar = loadGrammar(parseGrammar(
    readFileSync(new URL('../../grammars/mit-names.def', import.meta.url), 'utf8')
  ));
  const payload = new Uint8Array(40);
  for (let i = 0; i < 40; i++) payload[i] = (i * 37 + 11) & 0xff;
  const stream = modelStream(grammar, { random: mulberry32(11), dict });
  const cover = await encodeToString(payload, dict, { modelStream: stream, randomSeed: 0xC0FFEE });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, payload);
});

test('grammar-sab: makeModel rejects raw parsed-tree grammar', () => {
  // Make sure callers get a clear error if they forget to loadGrammar
  // the parser output.
  const parsed = parseGrammar('S: a ;');
  assert.throws(() => makeModel(parsed, { random: () => 0 }), /SAB-backed/);
});
