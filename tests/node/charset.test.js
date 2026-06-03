// End-to-end charset preservation tests (Step 3 of the
// phrase-and-charset arc). Verifies that WORD_CHAR's widening to
// `\p{Script=Latin}` lets accented words ride through the encode →
// decode pipeline as bit-bearing dictionary entries, and that the
// catch-all PUNCT for non-Latin-non-emoji UTF-8 preserves CJK,
// Cyrillic, etc. literally in cover (zero bits, full layout).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary, lookupWord } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import { encodeToString, decodeToBytes } from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

// Small Latin-script dict mixing ASCII + accented entries. Step 3's
// WORD_RE widens to \p{Script=Latin}, so each of these lexes as WORD
// and lands in the dict via the TW-list rule-2 round-trip gate. Dict
// convention is lowercase entries (genmodel lowercases corpus WORDs
// before lookupWord, then emits Cap/CAPSLOCKON markers to round-trip
// the case in the cover).
const TWLIST = [
  { type: 'noun', word: 'cafe' },
  { type: 'noun', word: 'café' },
  { type: 'noun', word: 'naïve' },
  { type: 'noun', word: 'dvořák' },
  { type: 'noun', word: 'señor' },
  { type: 'noun', word: 'łukasz' },
  { type: 'noun', word: 'crème' },
  { type: 'noun', word: 'piñata' },
];
const DICT = loadDictionary(buildDictionary(TWLIST, { name: 'charset-test' }));

test('accented Latin entries survive buildDictionary and lookupWord round-trip', async () => {
  for (const w of ['café', 'naïve', 'dvořák', 'señor', 'łukasz', 'crème', 'piñata']) {
    const got = lookupWord(DICT, w);
    assert.ok(got, `expected '${w}' in dict`);
    assert.ok(got.bits >= 1, `'${w}' should have at least 1 bit`);
  }
});

test('encode/decode round-trip with accented-Latin dictionary', async () => {
  // Build a corpus using the accented words so genmodel produces a
  // workable model with bit-bearing slots. Mixed-case (Title-cased
  // proper nouns) exercises the Cap-marker path through format.js.
  const corpus = 'café señor. naïve crème. Dvořák Łukasz. piñata cafe.';
  const modelJson = await generateModelTable(corpus, DICT, { name: 'charset-model' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  const stream = modelTableStream(model, { random: mulberry32(7), dict: DICT });
  const cover = await encodeToString(payload, DICT, { modelStream: stream });
  const recovered = await decodeToBytes(cover, DICT);
  assert.deepEqual(recovered, payload);
  // Sanity: the cover should have at least one accented Latin char in
  // its body, proving the formatter emitted a Latin-extended WORD slot.
  // (Avoiding the v-flag's set-difference syntax to stay Node-18-compatible.)
  assert.ok(/[éèëêíïñöóàâüřčšžŁ]/.test(cover),
    `cover should contain at least one accented-Latin char; got: ${JSON.stringify(cover)}`);
});

test('CJK paragraph preserved verbatim through encode/decode (zero bits)', async () => {
  // Embed a CJK paragraph between Latin sentences. Catch-all PUNCT
  // captures the CJK as one literal token; encoder emits it verbatim;
  // decoder skips at WORD-only filter; bit accounting is fine.
  const cjkParagraph = '你好世界这是一段中文文字用于测试';
  const corpus = `cafe naïve. ${cjkParagraph} señor crème.`;
  const modelJson = await generateModelTable(corpus, DICT, { name: 'charset-cjk-model' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  // Use a seed that's likely to land on a model containing the CJK
  // run. We try several seeds and accept the first cover that contains
  // the CJK run, the model might land on a non-CJK sentence shape.
  let seenCjkInCover = false;
  for (let seed = 1; seed <= 30; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: DICT });
    const cover = await encodeToString(payload, DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, DICT);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}`);
    if (cover.includes(cjkParagraph)) seenCjkInCover = true;
  }
  assert.ok(seenCjkInCover, 'cover never contained the literal CJK paragraph across 30 seeds');
});
