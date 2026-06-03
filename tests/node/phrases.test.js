// End-to-end phrase-as-token tests (Step 4 of the phrase-and-charset
// arc). Covers:
//   - parseTwlistLines admits multi-word values and canonicalizes
//     whitespace.
//   - dict.phraseIndex is built at loadDictionary time, sorted
//     longest-first within each first-word bucket.
//   - phraseFuse does greedy longest-match with WHITESPACE, PUNCT,
//     and EOS all hard barriers (whitespace can only legitimately
//     come from a model-emitted punct, never from inside a phrase
//     canonical, so crossing it would mis-align with the encoder).
//   - Encoder peek-and-buffer prevents accidental phrase formation
//     across independently selected slots (defensive case).
//   - Encoder emits multi-word entries atomically (positive case);
//     decoder fuses them back on lex; bit accounting balances.
//   - End-to-end encode → decode round-trips with a phrase-bearing
//     dict.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary, lookupWord } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import {
  tokenizeArray, phraseFuse, TOKEN,
} from '../../js/src/lexer.js';
import { parseTwlistLines } from '../../js/src/builder/sources.js';
import { encodeToString, decodeToBytes } from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

// ---- parseTwlistLines: phrase admission ----

test('parseTwlistLines admits 2-word phrase value', async () => {
  const out = parseTwlistLines('adv\ta capella');
  assert.deepEqual(out, [{ type: 'adv', word: 'a capella' }]);
});

test('parseTwlistLines canonicalizes multi-space + tab whitespace to single space', async () => {
  const out = parseTwlistLines('adv\ta    la\t\tcarte');
  assert.deepEqual(out, [{ type: 'adv', word: 'a la carte' }]);
});

test('parseTwlistLines rejects PUNCT in middle of phrase', async () => {
  const out = parseTwlistLines('adv\ta. capella', { reportRejections: true });
  assert.equal(out.entries.length, 0);
  assert.equal(out.rejections.length, 1);
  assert.equal(out.rejections[0].reason, 'lexer-rejected');
});

// ---- dict.phraseIndex ----

const PHRASE_TWLIST = [
  { type: 'adv', word: 'a capella' },
  { type: 'adv', word: 'a la carte' },
  { type: 'adv', word: 'a la mode' },
  { type: 'adv', word: 'de facto' },
  { type: 'adv', word: 'de jure' },
  { type: 'noun', word: 'standard' },
  { type: 'noun', word: 'mode' },
  { type: 'noun', word: 'wine' },
  { type: 'noun', word: 'cake' },
  { type: 'noun', word: 'apple' },
];
const PHRASE_DICT = loadDictionary(buildDictionary(PHRASE_TWLIST, { name: 'phrase-test' }));

test('loadDictionary builds phraseIndex with longest-first ordering', async () => {
  assert.ok(PHRASE_DICT.phraseIndex);
  const aBucket = PHRASE_DICT.phraseIndex.get('a');
  assert.ok(aBucket, 'expected `a` bucket in phraseIndex');
  // 3 phrases starting with `a`: a capella (2-word), a la carte (3),
  // a la mode (3). Longest-first means [3, 3, 2].
  assert.equal(aBucket.length, 3);
  assert.equal(aBucket[0].parts.length, 3); // a la carte or a la mode
  assert.equal(aBucket[1].parts.length, 3);
  assert.equal(aBucket[2].parts.length, 2); // a capella
});

test('dict.maxPhraseLen reflects longest phrase in dict', async () => {
  assert.equal(PHRASE_DICT.maxPhraseLen, 3);
});

test('lookupWord finds phrase entries by canonical key', async () => {
  const got = lookupWord(PHRASE_DICT, 'a capella');
  assert.ok(got);
  assert.ok(got.bits >= 1);
});

// ---- phraseFuse (lexer side) ----

function fuseString(s) {
  return [...phraseFuse(
    tokenizeArray(s),
    PHRASE_DICT.phraseIndex,
    PHRASE_DICT.maxPhraseLen,
  )];
}

test('phraseFuse fuses 2-word phrase into one WORD token', async () => {
  const toks = fuseString('I love a capella music');
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['I', 'love', 'a capella', 'music']);
});

test('phraseFuse picks longest match (a la carte) over shorter (a capella)', async () => {
  const toks = fuseString('I love a la carte');
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['I', 'love', 'a la carte']);
});

test('phraseFuse: WHITESPACE is a barrier (no fusion across newline / tab / multi-space)', async () => {
  // Round-trip safety: the encoder writes a phrase canonical with a
  // single internal space (which the lexer doesn't tokenize), so any
  // WHITESPACE token between WORDs in cover came from a model-emitted
  // punct and is NOT inside a phrase the encoder picked. Fusing across
  // it would silently mis-align bits with the encoder's view.
  for (const sep of ['  ', '\t', '\n', ' \t\n ']) {
    const toks = fuseString(`a${sep}capella`);
    const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
    assert.deepEqual(words, ['a', 'capella'],
      `failed with separator ${JSON.stringify(sep)}: got ${JSON.stringify(words)}`);
  }
});

test('phraseFuse: PUNCT barrier breaks fusion', async () => {
  const toks = fuseString('a, capella');
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['a', 'capella']);
});

test('phraseFuse: EOS barrier breaks fusion', async () => {
  const toks = fuseString('a. capella');
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['a', 'capella']);
});

test('phraseFuse: no fusion when first word has no candidates', async () => {
  const toks = fuseString('hello world');
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['hello', 'world']);
});

// ---- Encoder peek-and-buffer (defensive case) ----

// Build a tiny dict where two single-word entries can accidentally
// form a phrase. Type "art" has just "a"; type "voc" has "capella"
// and one alternative. Phrase "a capella" lives in type "adv". When
// the model puts (art, voc) in sequence and bits-resolve to ("a",
// "capella"), the encoder must rewind both slots to prevent the
// decoder from fusing the cover into one phrase token.
const DEFENSIVE_TWLIST = [
  { type: 'art', word: 'a' },
  { type: 'voc', word: 'capella' },
  { type: 'voc', word: 'cake' },
  { type: 'adv', word: 'a capella' },
  { type: 'noun', word: 'apple' },
  { type: 'noun', word: 'banana' },
];
const DEFENSIVE_DICT = loadDictionary(buildDictionary(DEFENSIVE_TWLIST, { name: 'defensive' }));

test('encoder rewinds when independent slots accidentally form a phrase', async () => {
  // Construct a model that sequences (art, voc, noun, art, voc, noun, ...),
  // with type "art" having only "a", a slot for art always picks "a".
  // Type "voc" has "capella" and "cake"; bits choose between them.
  // When voc resolves to "capella" after an art emit, buffer detects
  // "a capella" and rewinds. The encoder must produce a cover whose
  // decoded bits exactly match the input payload, that's the
  // round-trip invariant.
  const modelJson = {
    version: 2,
    name: 'defensive-model',
    typeNames: ['art', 'voc', 'noun'],
    models: [
      {
        tokens: [0, 1, 2, '^. ^'], // art voc noun + EOS
        weight: 1,
      },
    ],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  // Try multiple seeds; round-trip must hold for all.
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: DEFENSIVE_DICT });
    const cover = await encodeToString(payload, DEFENSIVE_DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, DEFENSIVE_DICT);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}; cover: ${JSON.stringify(cover)}`);
  }
});

// ---- Encoder positive case (multi-word emit) ----

test('encoder emits multi-word entry atomically; decoder fuses on lex', async () => {
  // Type "adv" has "a capella" as one of its entries; if a slot
  // resolves there, encoder emits the canonical "a capella" string.
  // Decoder lexes that with phrase fusion → one WORD token. Bit
  // accounting balances.
  const modelJson = {
    version: 2,
    name: 'positive-model',
    typeNames: ['adv', 'noun'],
    models: [
      { tokens: [0, 1, '^. ^'], weight: 1 }, // adv noun + EOS
    ],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: PHRASE_DICT });
    const cover = await encodeToString(payload, PHRASE_DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, PHRASE_DICT);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}`);
  }
});

test('cover-side fusion observed for multi-word emits across seeds', async () => {
  // Across many seeds, at least one cover should contain a phrase
  // in its rendered form (e.g., "a capella", "a la carte", "de facto").
  const modelJson = {
    version: 2,
    name: 'positive-observe',
    typeNames: ['adv', 'noun'],
    models: [
      { tokens: [0, 1, '^. ^'], weight: 1 },
    ],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x00, 0xff]);
  let phraseSeen = false;
  for (let seed = 1; seed <= 20; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: PHRASE_DICT });
    const cover = await encodeToString(payload, PHRASE_DICT, { modelStream: stream });
    if (/a capella|a la carte|a la mode|de facto|de jure/.test(cover)) {
      phraseSeen = true;
      break;
    }
  }
  assert.ok(phraseSeen, 'expected at least one cover to render a multi-word phrase across 20 seeds');
});

// ---- 3-word phrase rewind ----

test('encoder rewinds 3 slots when 3-word phrase forms accidentally', async () => {
  // Build a dict where independent type slots can form "a la carte".
  // 3-slot defensive case is the most rewind-heavy path. Round-trip
  // must hold.
  const TWLIST = [
    { type: 'art', word: 'a' },
    { type: 'art', word: 'an' },
    { type: 'prep', word: 'la' },
    { type: 'prep', word: 'in' },
    { type: 'noun', word: 'carte' },
    { type: 'noun', word: 'cake' },
    { type: 'noun', word: 'mode' },
    { type: 'adv', word: 'a la carte' },
    { type: 'adv', word: 'a la mode' },
    { type: 'verb', word: 'eat' },
    { type: 'verb', word: 'cook' },
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: '3word' }));
  const modelJson = {
    version: 2,
    name: '3word-model',
    typeNames: ['art', 'prep', 'noun', 'verb'],
    models: [
      { tokens: [0, 1, 2, 3, '^. ^'], weight: 1 }, // art prep noun verb + EOS
    ],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    const cover = await encodeToString(payload, dict, { modelStream: stream });
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}; cover: ${JSON.stringify(cover)}`);
  }
});

// ---- Nested-prefix safety: abort rather than emit broken cover ----

test('encoder aborts on nested-prefix dict that cannot encode any payload', async () => {
  // Pathological dict: every entry is a strict prefix of every longer
  // entry, all in one type. With a multi-word-slot grammar, any
  // single-word-then-multi-word combination forms a longer phrase the
  // decoder would greedy-fuse, breaking bit accounting.
  //
  // The encoder must rewind every such combination. With this dict
  // every combination rewinds, so the MAX_NO_PROGRESS_MODELS guard
  // fires and the encoder throws, per the project invariant that if
  // the dict + style cannot encode the payload, NO cover is emitted.
  // (Round-trip correctness is the only critical function; any
  // condition that would produce un-recoverable cover must abort.)
  const TWLIST = [
    { type: 't', word: 'x' },
    { type: 't', word: 'x x' },
    { type: 't', word: 'x x x' },
    { type: 't', word: 'x x x x' },
    { type: 't', word: 'x x x x x' },
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'nested-prefix' }));
  const modelJson = {
    version: 2,
    name: 'nested-prefix-2slot',
    typeNames: ['t'],
    models: [{ tokens: [0, 0, '^. ^'], weight: 1 }],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x91, 0x2c, 0xff, 0x00]);
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    await assert.rejects(
      () => encodeToString(payload, dict, { modelStream: stream }),
      /models picked without consuming any bits/,
      `expected MAX_NO_PROGRESS abort at seed ${seed}`,
    );
  }
});

test('nested-prefix dict round-trips when grammar permits a clean encoding', async () => {
  // Same nested-prefix dict, but a 1-word-slot grammar gives the
  // encoder room to pick exactly one entry per sentence and emit it
  // as the canonical phrase string. The decoder fuses each sentence's
  // cover back to the same entry. Bit accounting balances. This is
  // the cover "X x! x x x? x." case from the developer's worked
  // example: recoverable when the encoder takes the clean
  // 1-slot-per-sentence path.
  const TWLIST = [
    { type: 't', word: 'x' },
    { type: 't', word: 'x x' },
    { type: 't', word: 'x x x' },
    { type: 't', word: 'x x x x' },
    { type: 't', word: 'x x x x x' },
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'nested-prefix-1slot' }));
  const modelJson = {
    version: 2,
    name: 'nested-prefix-1slot',
    typeNames: ['t'],
    models: [{ tokens: [0, '^. ^'], weight: 1 }],
  };
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    const cover = await encodeToString(payload, dict, { modelStream: stream });
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}; cover: ${JSON.stringify(cover)}`);
  }
});

// ---- Existing-cover round-trip with phrases ----

test('end-to-end round-trip on a phrase-bearing dict + corpus', async () => {
  const corpus = 'I order a la carte. The de facto standard. A capella music. Apple cake mode.';
  const modelJson = await generateModelTable(corpus, PHRASE_DICT, { name: 'phrase-corpus' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x00, 0xff, 0x91, 0x2c]);
  for (let seed = 1; seed <= 10; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict: PHRASE_DICT });
    const cover = await encodeToString(payload, PHRASE_DICT, { modelStream: stream });
    const recovered = await decodeToBytes(cover, PHRASE_DICT);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}`);
  }
});

// ---- Step 6: emoji-phrases (multi-emoji + mixed Latin+emoji) ----

const ROSE = '🌹';
const BOUQUET = '💐';
const GRIN = '😀';

test('parseTwlistLines admits 2-emoji phrase value', async () => {
  const out = parseTwlistLines('em16_plant_flower\t🌹 💐');
  assert.deepEqual(out, [{ type: 'em16_plant_flower', word: '🌹 💐' }]);
});

test('parseTwlistLines admits mixed Latin+emoji phrase value', async () => {
  const out = parseTwlistLines('em16_face_smiling\thappy 😀');
  assert.deepEqual(out, [{ type: 'em16_face_smiling', word: 'happy 😀' }]);
});

test('parseTwlistLines admits adjacent emoji as one word (no separator)', async () => {
  // Consecutive emoji clusters with no separator fuse into one WORD
  // token in the lexer; the canonical form preserves the no-space form
  // so encoder-emitted "🌹💐" round-trips through the decoder.
  const out = parseTwlistLines('em16_plant_flower\t🌹💐');
  assert.deepEqual(out, [{ type: 'em16_plant_flower', word: '🌹💐' }]);
});

test('phraseFuse fuses 2-emoji phrase into one WORD token', async () => {
  const phraseIndex = new Map([
    [ROSE, [{ parts: [ROSE, BOUQUET], canonical: '🌹 💐' }]],
  ]);
  const tokens = tokenizeArray(`prefix ${ROSE} ${BOUQUET} suffix`);
  const fused = [...phraseFuse(tokens, phraseIndex, 2)];
  const phraseToken = fused.find(t => t.type === TOKEN.WORD && t.value === '🌹 💐');
  assert.ok(phraseToken, 'expected fused 🌹 💐 token');
  assert.equal(phraseToken.fused, true);
});

test('phraseFuse fuses mixed Latin+emoji phrase', async () => {
  const phraseIndex = new Map([
    ['happy', [{ parts: ['happy', GRIN], canonical: 'happy 😀' }]],
  ]);
  const tokens = tokenizeArray(`I am happy ${GRIN} today`);
  const fused = [...phraseFuse(tokens, phraseIndex, 2)];
  const phraseToken = fused.find(t => t.type === TOKEN.WORD && t.value === 'happy 😀');
  assert.ok(phraseToken, 'expected fused "happy 😀" token');
});

// Pinned regressions for the three bug fixes that closed the
// Aesop+flood validation-failure arc:
//   1. phraseFuse must NOT cross WHITESPACE tokens, the encoder
//      drains its phrase buffer on every cover-emitting punct (newline,
//      tab, multi-space), so any cover-side WHITESPACE token marks a
//      barrier that the decoder must respect too.
//   2. byWord / byTypeName SAB indices must be sorted in UTF-8 byte
//      order, NOT JS string order, so the byte-wise binary search
//      in lookupWord/lookupTypeByName actually finds emoji-bearing
//      words. UTF-16 ordering disagrees with UTF-8 across the
//      BMP (≥U+E000) / supplementary-plane boundary.
//   3. State-only puncts (Cap, CAPSLOCKON, capslockoff) must be
//      DEFERRED into the encoder's phrase buffer rather than triggering
//      flushBuffer: they emit no cover bytes, so the decoder never
//      sees a barrier between the two adjacent WORDs they sit between.
test('regression: phrase fusion must not cross whitespace tokens', async () => {
  // Dict has "the ax" as a phrase and "ax 🪓🪓🪓" as a phrase. If the
  // cover has "the\nax 🪓🪓🪓" (with a literal \n from a model-emitted
  // punct), the decoder must NOT fuse "the ax" across the newline,
  // the encoder picked them as independent slots separated by the
  // newline punct, so fusing across would mis-align bits.
  const TWLIST = [
    { type: 't', word: 'the' },
    { type: 't', word: 'the ax' },
    { type: 't', word: 'ax' },
    { type: 't', word: 'ax 🪓🪓🪓' },
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'ws-barrier' }));
  const cover = 'the\nax 🪓🪓🪓';
  const fused = [...phraseFuse(tokenizeArray(cover), dict.phraseIndex, dict.maxPhraseLen)];
  const words = fused.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ['the', 'ax 🪓🪓🪓'],
    'whitespace token between WORDs must block phrase fusion');
});

test('regression: dict lookup must work for supplementary-plane words', async () => {
  // Pre-fix bug: byWord was sorted in JS-string (UTF-16) order while
  // lookupWord searched in UTF-8 byte order. Words containing emoji
  // (supplementary-plane codepoints, 4-byte UTF-8 leading 0xF0) sorted
  // AFTER 3-byte UTF-8 (0xE0–0xEF, BMP ≥ U+0800) in UTF-8 but BEFORE
  // them in UTF-16, so the binary search missed.
  // Reproduce by including a 3-byte UTF-8 BMP word and a 4-byte UTF-8
  // emoji-bearing word in the same dict, then verifying both look up.
  const TWLIST = [
    { type: 't', word: 'foo  bar' },          // 3-byte UTF-8 (BMP private use)
    { type: 't', word: 'foo \u{1F384} bar' },       // 4-byte UTF-8 (supplementary)
    { type: 't', word: '\u{1F600} smile' },         // 4-byte UTF-8 first byte
    { type: 't', word: ' punct' },            // 3-byte UTF-8 first byte
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'utf-sort' }));
  for (const { word } of TWLIST) {
    const e = lookupWord(dict, word);
    assert.ok(e, `lookupWord must find ${JSON.stringify(word)} regardless of UTF-8/UTF-16 sort divergence`);
  }
});

test('regression: state-only puncts (Cap) defer through phrase buffer', async () => {
  // Pre-fix bug: a 'Cap' punct between two type picks would flush the
  // phrase buffer (emit the buffered word to cover), so when the next
  // type picked a phrase whose first part fused with the just-flushed
  // word, analyzePhraseBuf never saw the combination → no rewind →
  // decoder mis-fused → bit drift. Round-trip the smallest config that
  // exhibits the pattern: corpus "the Ax" (title case forces 'Cap' in
  // the model between T_the and T_ax_phrases) with a dict where
  // "the ax" is a phrase entry alongside "ax 🪓🪓🪓".
  const TWLIST = [
    { type: 'art', word: 'the' },
    { type: 'phr', word: 'the ax' },        // would fuse if encoder drops "the" too soon
    { type: 'noun', word: 'ax' },
    { type: 'noun', word: 'ax 🪓🪓🪓' },
    { type: 'noun', word: 'ax 🪓🪓' },
    { type: 'verb', word: 'pursued' },
    { type: 'verb', word: 'chased' },
    { type: 'noun', word: 'man' },
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'cap-defer' }));
  // Corpus has "The Ax pursued", title-case "The" and "Ax" both
  // emit 'Cap' puncts in the model.
  const corpus = 'The Ax pursued. A man chased the ax. The Ax pursued.';
  const modelJson = await generateModelTable(corpus, dict, { name: 'cap-defer-corpus' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x91, 0x2c, 0xff, 0x00]);
  for (let seed = 1; seed <= 12; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    const cover = await encodeToString(payload, dict, { modelStream: stream });
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `seed ${seed} cover: ${JSON.stringify(cover.slice(0, 200))}`);
  }
});

test('end-to-end round-trip on emoji-phrase + mixed-phrase dict', async () => {
  // Build a small dict mixing single-emoji entries, Latin entries,
  // multi-emoji phrases, and mixed Latin+emoji phrases, all in
  // shared types so Huffman gives bits.
  const TWLIST = [
    { type: 'noun', word: ROSE },
    { type: 'noun', word: BOUQUET },
    { type: 'noun', word: GRIN },
    { type: 'noun', word: 'rose' },
    { type: 'noun', word: 'flower' },
    { type: 'noun', word: 'happy' },
    { type: 'noun', word: '🌹 💐' },         // multi-emoji phrase
    { type: 'noun', word: 'happy 😀' },      // mixed phrase
  ];
  const dict = loadDictionary(buildDictionary(TWLIST, { name: 'emoji-phrase-test' }));
  const corpus = `${ROSE} ${BOUQUET} rose flower happy ${GRIN}. ${ROSE} ${BOUQUET} happy ${GRIN}.`;
  const modelJson = await generateModelTable(corpus, dict, { name: 'emoji-phrase-corpus' });
  const model = loadModelTable(modelJson);
  const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55]);
  for (let seed = 1; seed <= 8; seed++) {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    const cover = await encodeToString(payload, dict, { modelStream: stream });
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `round-trip failed at seed ${seed}; cover: ${JSON.stringify(cover)}`);
  }
});
