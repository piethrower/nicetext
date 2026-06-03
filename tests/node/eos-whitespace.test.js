// End-to-end EOS + WHITESPACE preservation tests (Step 2 of the
// phrase-and-charset arc). Builds a tiny dict + model from a corpus
// containing every preservation shape (period EOS, !!! run, paragraph
// break, centered-heading indent run, tab between WORDs, mid-sentence
// single newline) and asserts:
//   1. genmodel emits each EOS / WHITESPACE shape as a quoted-literal
//      `^...^` punct that round-trips through format.js verbatim.
//   2. encode → decode round-trips byte-for-byte against the new model.
//   3. cover text actually contains the preservation shapes when the
//      relevant model is selected (across multiple seeds).
//
// Promoted from tests/node/tmp/probe-eos-whitespace.mjs.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import { encodeToString, decodeToBytes } from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

// Tiny dict; enough words for genmodel to fill type slots from the
// corpus. The Huffman shape doesn't matter, we care about the punct
// tokens between WORDs.
const TWLIST = [
  { type: 'noun', word: 'alpha' },
  { type: 'noun', word: 'beta' },
  { type: 'noun', word: 'gamma' },
  { type: 'noun', word: 'delta' },
  { type: 'noun', word: 'epsilon' },
  { type: 'noun', word: 'zeta' },
  { type: 'noun', word: 'eta' },
  { type: 'noun', word: 'theta' },
];
const dict = loadDictionary(buildDictionary(TWLIST, { name: 'eos-whitespace-test' }));

// Each sentence carries at least two dict-words so the resulting model
// has bit-bearing type slots, modelTableStream filters out models with
// zero bit-bearing slots, so a sentence like `wow!!!` (all out-of-dict
// + EOS) would be captured by genmodel but never emitted in cover.
//   - Period EOS:                  `alpha beta.`
//   - !!! run:                     `gamma delta!!!`
//   - Question + paragraph break:  `epsilon zeta?\n\neta theta.`
//   - Centered-heading indent run: `alpha beta.\n            gamma delta.`
//   - Tab between WORDs:           `epsilon\tzeta beta.`
//   - Mid-sentence single newline: `alpha\nbeta delta.`
const CORPUS = [
  'alpha beta.',
  'gamma delta!!!',
  'epsilon zeta?\n\neta theta.',
  'alpha beta.\n            gamma delta.',
  'epsilon\tzeta beta.',
  'alpha\nbeta delta.',
].join(' ');

const modelJson = await generateModelTable(CORPUS, dict, { name: 'eos-whitespace-model' });

function allModelPuncts() {
  const out = [];
  for (const m of modelJson.models) {
    for (const t of m.tokens) if (typeof t === 'string') out.push(t);
  }
  return out;
}

test('genmodel emits ^. ^ for end-of-sentence period followed by space', async () => {
  assert.ok(allModelPuncts().includes('^. ^'));
});

test('genmodel emits ^!!! ^ for triple-bang terminator', async () => {
  assert.ok(allModelPuncts().includes('^!!! ^'));
});

test('genmodel emits ^?\\n\\n^ for paragraph-break EOS', async () => {
  assert.ok(allModelPuncts().includes('^?\n\n^'));
});

test('genmodel emits ^.\\n[12 spaces]^ for centered-heading indent', async () => {
  assert.ok(allModelPuncts().includes('^.\n            ^'));
});

test('genmodel emits ^\\t^ for tab WHITESPACE between WORDs', async () => {
  assert.ok(allModelPuncts().includes('^\t^'));
});

test('genmodel emits ^\\n^ for mid-sentence single newline', async () => {
  assert.ok(allModelPuncts().includes('^\n^'));
});

test('encode/decode round-trip with new EOS + WHITESPACE preservation', async () => {
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x00, 0xff, 0x91, 0x2c]);
  const stream = modelTableStream(model, { random: mulberry32(7), dict });
  const cover = await encodeToString(payload, dict, { modelStream: stream });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, payload);
});

test('cover text exhibits all preservation shapes across seeds 1-20', async () => {
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x00, 0xff, 0x91, 0x2c]);
  const seen = { period: false, bang3: false, paraBreak: false, indent: false, tab: false, midNewline: false };
  for (let seed = 1; seed <= 20; seed++) {
    const s = modelTableStream(model, { random: mulberry32(seed), dict });
    const c = await encodeToString(payload, dict, { modelStream: s });
    if (/[a-z]\.\s/.test(c)) seen.period = true;
    if (c.includes('!!!')) seen.bang3 = true;
    if (c.includes('?\n\n')) seen.paraBreak = true;
    if (/\.\n {12}/.test(c)) seen.indent = true;
    if (c.includes('\t')) seen.tab = true;
    if (/[a-z]\n[a-z]/.test(c)) seen.midNewline = true;
  }
  for (const [k, v] of Object.entries(seen)) {
    assert.ok(v, `cover never exhibited ${k} layout across 20 seeds`);
  }
});
