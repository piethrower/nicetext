// End-to-end emoji preservation tests (Step 5a-2 of the
// phrase-and-charset arc). The lexer's emoji-cluster pattern lexes
// as WORD (not PUNCT), so emoji entries land in the dictionary as
// bit-bearing slots and round-trip through encode → decode like any
// other WORD.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary, lookupWord } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import { encodeToString, decodeToBytes } from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

// Five emoji cluster shapes covered by EMOJI_CLUSTER_RE.
const ROSE = '🌹';                     // single supplementary-plane
const RAIN = '🌧️';               // BMP + variation selector 16
const WAVE_TONE = '👋🏽';                // base + skin-tone modifier
const FLAG_US = '🇺🇸';                  // regional-indicator pair
const FAMILY = '👨‍👩‍👧‍👦'; // ZWJ family

// Co-locate emoji and Latin entries under shared types so Huffman
// gives each entry ≥1 bit (singletons in a type get 0 bits and aren't
// bit-bearing slots). The actual em16_<subgroup> types in the shipped
// fixture aren't single-entry, every subgroup carries multiple emoji,
// often dozens, so this co-location matches production shape.
const TWLIST = [
  { type: 'noun', word: ROSE },
  { type: 'noun', word: RAIN },
  { type: 'noun', word: WAVE_TONE },
  { type: 'noun', word: FLAG_US },
  { type: 'noun', word: FAMILY },
  { type: 'noun', word: 'rose' },
  { type: 'noun', word: 'rain' },
  { type: 'noun', word: 'wave' },
  { type: 'noun', word: 'flag' },
  { type: 'noun', word: 'family' },
];
const DICT = loadDictionary(buildDictionary(TWLIST, { name: 'emoji-test' }));

test('all five emoji cluster shapes survive buildDictionary + lookupWord', async () => {
  for (const w of [ROSE, RAIN, WAVE_TONE, FLAG_US, FAMILY]) {
    const got = lookupWord(DICT, w);
    assert.ok(got, `expected '${w}' in dict`);
    assert.ok(got.bits >= 1, `'${w}' should have at least 1 bit; got ${got.bits}`);
  }
});

test('encode/decode round-trip with emoji-bearing dictionary', async () => {
  const corpus = `${ROSE} ${RAIN} ${WAVE_TONE} ${FLAG_US} ${FAMILY}. rose rain wave flag family.`;
  const modelJson = await generateModelTable(corpus, DICT, { name: 'emoji-model' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  // Try several seeds; the model may pick a non-emoji shape on some
  // seeds. Round-trip MUST hold on every seed; emoji-in-cover is a
  // softer expectation we just sample for at the end.
  let coverWithEmoji = null;
  for (let seed = 1; seed <= 12; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: DICT });
    const cover = await encodeToString(payload, DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, DICT);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}`);
    if (coverWithEmoji === null) {
      for (const e of [ROSE, RAIN, WAVE_TONE, FLAG_US, FAMILY]) {
        if (cover.includes(e)) { coverWithEmoji = cover; break; }
      }
    }
  }
  assert.ok(coverWithEmoji,
    'cover never contained any of the emoji cluster shapes across 12 seeds');
});

test('emoji cluster mid-Latin-paragraph round-trips without splitting cluster', async () => {
  // Embed each cluster shape between Latin words. A cluster bug would
  // either split the cluster mid-codepoint (decoder sees fragments) or
  // lex it as PUNCT (decoder skips, bit accounting drifts). Both
  // failure modes show up as a recovered-bytes mismatch.
  const corpus = `rose ${ROSE} rain ${RAIN} wave ${WAVE_TONE} flag ${FLAG_US} family ${FAMILY}.`;
  const modelJson = await generateModelTable(corpus, DICT, { name: 'emoji-mixed-model' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0xff, 0x00, 0x55, 0xaa, 0x12, 0x34]);
  for (let seed = 1; seed <= 6; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: DICT });
    const cover = await encodeToString(payload, DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, DICT);
    assert.deepEqual(recovered, payload, `mixed-content round-trip failed at seed ${seed}`);
  }
});
