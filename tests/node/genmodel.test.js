// genmodel preservation tests: EOS values round-trip via the formatter's
// quoted-literal punct path (^...^), WHITESPACE tokens emit literal
// whitespace between WORDs, and partial-flush appends a synthetic
// terminator so every model has a trailing punct. Replaces the legacy
// `'. n'` normalization that lost terminator + paragraph layout.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';

// Minimal dict with a few words so genmodel has something to reference.
// All words are lowercase singletons; we don't care about Huffman shape
// here: the tests assert on the model's punct token shape, not the
// type slots.
const TWLIST = [
  { type: 'noun', word: 'hello' },
  { type: 'noun', word: 'world' },
  { type: 'noun', word: 'wow' },
  { type: 'noun', word: 'cool' },
  { type: 'noun', word: 'one' },
  { type: 'noun', word: 'two' },
];
const DICT = loadDictionary(buildDictionary(TWLIST, { name: 'test' }));

// Pull every punct token out of every model in the table. Easier than
// tracking model boundaries, most assertions just want to know "did
// this exact punct appear somewhere in the output?".
function allPuncts(table) {
  const puncts = [];
  for (const m of table.models) {
    for (const t of m.tokens) {
      if (typeof t === 'string') puncts.push(t);
    }
  }
  return puncts;
}

test('genmodel: period EOS at end-of-corpus carries trailing space', async () => {
  // End-of-corpus `.` has no whitespace to consume, so genmodel appends
  // a single space to the EOS value so cover doesn't fuse `theta.gamma`
  // into one WORD token via WORD_RE's `.`-extender (the EXT pattern).
  const out = await generateModelTable('hello world.', DICT);
  assert.ok(allPuncts(out).includes('^. ^'),
    `expected ^. ^ (period + appended space) in puncts: ${JSON.stringify(allPuncts(out))}`);
});

test('genmodel: ! EOS preserves run length', async () => {
  const out = await generateModelTable('wow!!! cool.', DICT);
  // Wow's EOS run is `!!! ` (terminator + trailing space, since EOS_RE
  // greedily consumes whitespace). Wrapped as ^!!! ^.
  const puncts = allPuncts(out);
  assert.ok(puncts.some(p => p.startsWith('^!!!')),
    `expected ^!!!... in puncts: ${JSON.stringify(puncts)}`);
});

test('genmodel: paragraph break EOS preserves \\n\\n', async () => {
  const out = await generateModelTable('hello.\n\nworld.', DICT);
  const puncts = allPuncts(out);
  assert.ok(puncts.includes('^.\n\n^'),
    `expected ^.\\n\\n^ in puncts: ${JSON.stringify(puncts)}`);
});

test('genmodel: indented continuation EOS preserves trailing whitespace', async () => {
  const out = await generateModelTable('hello.\n            world.', DICT);
  const puncts = allPuncts(out);
  assert.ok(puncts.includes('^.\n            ^'),
    `expected ^.\\n[12 spaces]^: ${JSON.stringify(puncts)}`);
});

test('genmodel: mid-sentence multi-space emits WHITESPACE punct', async () => {
  const out = await generateModelTable('hello   world.', DICT);
  const puncts = allPuncts(out);
  assert.ok(puncts.includes('^   ^'),
    `expected ^   ^ (3 spaces) in puncts: ${JSON.stringify(puncts)}`);
});

test('genmodel: mid-sentence tab emits WHITESPACE punct', async () => {
  const out = await generateModelTable('hello\tworld.', DICT);
  const puncts = allPuncts(out);
  assert.ok(puncts.includes('^\t^'),
    `expected ^\\t^ in puncts: ${JSON.stringify(puncts)}`);
});

test('genmodel: mid-sentence single newline emits WHITESPACE punct', async () => {
  const out = await generateModelTable('hello\nworld.', DICT);
  const puncts = allPuncts(out);
  assert.ok(puncts.includes('^\n^'),
    `expected ^\\n^ in puncts: ${JSON.stringify(puncts)}`);
});

test('genmodel: single space between WORDs is implicit, no WHITESPACE punct', async () => {
  const out = await generateModelTable('hello world.', DICT);
  const puncts = allPuncts(out);
  assert.ok(!puncts.includes('^ ^'),
    `single space should be implicit, not a punct: ${JSON.stringify(puncts)}`);
});

test('genmodel: partial flush appends synthetic terminator', async () => {
  // Corpus ends mid-sentence (no EOS). The trailing model should still
  // carry a terminator so format.js sees a punct after the last WORD.
  const out = await generateModelTable('hello world', DICT);
  // One model expected; its last token must be the synthetic ^.\n^.
  assert.equal(out.models.length, 1);
  const tokens = out.models[0].tokens;
  const last = tokens[tokens.length - 1];
  assert.equal(last, '^.\n^',
    `expected synthetic ^.\\n^ as last token; got ${JSON.stringify(tokens)}`);
});

test('genmodel: corpus ending in EOS does not double-add terminator', async () => {
  // Already terminated by the period, partial-flush guard should NOT
  // fire because `current` is empty after flushSentence.
  const out = await generateModelTable('hello world.', DICT);
  assert.equal(out.models.length, 1);
  const tokens = out.models[0].tokens;
  const last = tokens[tokens.length - 1];
  // Period EOS at end-of-corpus carries the appended space (see the
  // word-fusion guard above), so the last token is `^. ^`, not the
  // synthetic `^.\n^` terminator the partial-flush path would emit.
  assert.equal(last, '^. ^',
    `expected ^. ^ (period EOS + appended space) as last token; got ${JSON.stringify(tokens)}`);
});
