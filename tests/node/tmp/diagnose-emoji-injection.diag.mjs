// Diagnostic: does the Emoji Style dial actually inject emoji into
// covers at the engine level? End-to-end test from a controlled
// minimal byos shape through encode, scanning the cover text for
// emoji glyphs.
//
// Setup mirrors what Sprinkle / Flood would produce at the worker
// boundary: a small base TWLIST + applyEmojiAugmentation with the
// preset's flag bundle. No corpus / model in play, pure base-dict
// + weightedTypeStream so any emoji that surfaces came from the augs.
//
// Goal: prove (or disprove) that emoji land in cover text after augs
// fire. If they don't, the breakage is in the build/encode pipeline,
// not the UI.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEmojiAugmentation } from '../_aug-helpers.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../../js/src/dictionary.js';
import { weightedTypeStream } from '../../../js/src/typestream.js';
import { mulberry32 } from '../../../js/src/random.js';
import { encode } from '../../../js/src/encode.js';
import { loadModelTable, modelTableStream } from '../../../js/src/modeltable.js';

const SMILE  = '😀';
const HEART  = '💖';
const SPARK  = '✨';
const ROSE   = '🌹';

// CLDR keyword overlap with our base words is the gate for augs:
// "happy", "love", "shine", "rose" all exist as real Latin words below.
const CLDR = {
  [SMILE]: ['happy', 'face', 'smile'],
  [HEART]: ['heart', 'love', 'pink'],
  [SPARK]: ['shine', 'sparkle', 'glitter'],
  [ROSE]:  ['rose', 'flower', 'red'],
};

// Small, deliberately overlapping base. Emoji sit in their em16
// subgroup types; Latin words sit in adjective / noun types whose
// vocab matches CLDR keywords above so the augs have something to bite.
const BASE_ENTRIES = [
  { type: 'em16_face_smile', word: SMILE },
  { type: 'em16_heart',      word: HEART },
  { type: 'em16_event',      word: SPARK },
  { type: 'em16_plant',      word: ROSE },

  { type: 'adj_emotion', word: 'happy' },
  { type: 'adj_emotion', word: 'sad' },
  { type: 'adj_emotion', word: 'glad' },

  { type: 'noun_object', word: 'heart' },
  { type: 'noun_object', word: 'rose' },
  { type: 'noun_object', word: 'box' },

  { type: 'verb_action', word: 'shine' },
  { type: 'verb_action', word: 'walk' },

  { type: 'noun_feeling', word: 'love' },
  { type: 'noun_feeling', word: 'joy' },
];

// Anything in supplementary plane or the dingbat / misc-symbol
// blocks that CLDR commonly tags.
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;

const PAYLOAD_LEN = 300;          // enough for many type slots
const ENCODE_RUNS = 30;           // many runs to defeat picker bias
const BIT_BUDGET_PER_BYTE = 8;    // 8 bits per random byte

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

async function encodeToCover(payload, dict, randomSeed = 1) {
  const sink = [];
  const writer = new WritableStream({ write(c) { sink.push(c); } });
  const reader = new ReadableStream({
    start(c) { c.enqueue(payload); c.close(); },
  });
  const stream = weightedTypeStream(dict, { random: mulberry32(randomSeed) });
  await encode(reader, writer, dict, { typeStream: stream });
  let total = 0;
  for (const c of sink) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of sink) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

function buildAugmentedDict(augFlags) {
  const augmented = applyEmojiAugmentation([...BASE_ENTRIES], {
    cldr: CLDR,
    ...augFlags,
  });
  const sorted = sortDict(augmented);
  const dictJson = buildDictionary(sorted, { name: 'diag', tieBreak: 'alpha-asc' });
  return { entries: augmented, dictJson, dict: loadDictionary(dictJson) };
}

function summarizeDict(dictJson, label) {
  const types = dictJson.types.map(t => t.name);
  const wordToType = new Map();
  for (const w of dictJson.words) {
    const t = dictJson.types[w.typeIndex - 1];
    if (!wordToType.has(t.name)) wordToType.set(t.name, []);
    wordToType.get(t.name).push(w.word);
  }
  const emojiBearingTypes = [];
  for (const [type, words] of wordToType) {
    if (words.some(w => EMOJI_RE.test(w))) emojiBearingTypes.push(type);
  }
  return {
    label,
    typeCount: types.length,
    wordCount: dictJson.words.length,
    emojiBearingTypeCount: emojiBearingTypes.length,
    emojiBearingTypes,
  };
}

function countEmojiInCover(cover) {
  // Count distinct codepoint runs that match an emoji.
  const matches = cover.match(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu) || [];
  return matches.length;
}

const PRESETS = {
  Off: {
    emojiIntoWords: false, wordsIntoEmoji: false, mixedPhrases: false,
  },
  Sprinkle: {
    emojiIntoWords: true, wordsIntoEmoji: true, mixedPhrases: 'narrow',
  },
  Flood: {
    emojiIntoWords: true, wordsIntoEmoji: true, mixedPhrases: 'wide',
  },
};

// ---------- aug-time inspection ----------

test('aug-time: Sprinkle augs grow the entries set vs Off', () => {
  const off  = applyEmojiAugmentation([...BASE_ENTRIES], { cldr: CLDR, ...PRESETS.Off });
  const spr  = applyEmojiAugmentation([...BASE_ENTRIES], { cldr: CLDR, ...PRESETS.Sprinkle });
  console.log(`  Off entries:      ${off.length}`);
  console.log(`  Sprinkle entries: ${spr.length}`);
  assert.equal(off.length, BASE_ENTRIES.length, 'Off is identity');
  assert.ok(spr.length > BASE_ENTRIES.length, 'Sprinkle should add entries');
});

test('aug-time: Flood adds more entries than Sprinkle', () => {
  const spr = applyEmojiAugmentation([...BASE_ENTRIES], { cldr: CLDR, ...PRESETS.Sprinkle });
  const fld = applyEmojiAugmentation([...BASE_ENTRIES], { cldr: CLDR, ...PRESETS.Flood });
  console.log(`  Sprinkle entries: ${spr.length}`);
  console.log(`  Flood    entries: ${fld.length}`);
  assert.ok(fld.length >= spr.length, 'Flood entries >= Sprinkle');
});

// ---------- dict-time inspection ----------

for (const [label, flags] of Object.entries(PRESETS)) {
  test(`dict-time: ${label} dict shape`, () => {
    const { dictJson } = buildAugmentedDict(flags);
    const sum = summarizeDict(dictJson, label);
    console.log(`  ${label}:`);
    console.log(`    types:       ${sum.typeCount}`);
    console.log(`    words:       ${sum.wordCount}`);
    console.log(`    emoji-bearing types: ${sum.emojiBearingTypeCount}`);
    if (sum.emojiBearingTypeCount > 0) {
      const sample = sum.emojiBearingTypes.slice(0, 8);
      console.log(`      examples:  ${sample.join(', ')}${sum.emojiBearingTypes.length > 8 ? ', ...' : ''}`);
    }
    if (label === 'Off') {
      // Even Off should have the original em16_* types from BASE_ENTRIES.
      assert.ok(sum.emojiBearingTypeCount >= 4, 'Off keeps original em16 types');
    } else {
      assert.ok(sum.emojiBearingTypeCount > 4,
        `${label} should grow emoji-bearing types beyond the 4 base em16 types`);
    }
  });
}

// ---------- encode-time inspection ----------

for (const [label, flags] of Object.entries(PRESETS)) {
  test(`encode-time: ${label} cover-text emoji counts (${ENCODE_RUNS} runs of ${PAYLOAD_LEN}-byte payloads)`, async () => {
    const { dict } = buildAugmentedDict(flags);
    let totalEmoji = 0;
    let runsWithEmoji = 0;
    let firstSampleCover = null;
    for (let i = 0; i < ENCODE_RUNS; i++) {
      const payload = makePayload(101 + i, PAYLOAD_LEN);
      const cover = await encodeToCover(payload, dict, 1000 + i);
      const n = countEmojiInCover(cover);
      totalEmoji += n;
      if (n > 0) runsWithEmoji++;
      if (i === 0) firstSampleCover = cover;
    }
    const avg = (totalEmoji / ENCODE_RUNS).toFixed(2);
    console.log(`  ${label}:`);
    console.log(`    runs with ≥1 emoji: ${runsWithEmoji}/${ENCODE_RUNS}`);
    console.log(`    total emoji glyphs: ${totalEmoji}`);
    console.log(`    average per cover:  ${avg}`);
    console.log(`    first cover sample: "${firstSampleCover.slice(0, 240).replace(/\n/g, ' ')}${firstSampleCover.length > 240 ? '...' : ''}"`);
    if (label === 'Off') {
      // No augs, but BASE_ENTRIES has emoji types; weightedTypeStream
      // can still pick them. Don't assert zero. Just report.
    } else {
      assert.ok(totalEmoji > 0,
        `${label}: expected at least one emoji glyph in ${ENCODE_RUNS} covers`);
    }
  });
}

// ---------- flag-by-flag isolation ----------

test('flag isolation: emojiIntoWords ALONE produces emoji in covers', async () => {
  const { dict, dictJson } = buildAugmentedDict({
    emojiIntoWords: true, wordsIntoEmoji: false, mixedPhrases: false,
  });
  const sum = summarizeDict(dictJson, 'eiw-only');
  console.log(`  emoji-bearing types: ${sum.emojiBearingTypeCount}`);
  let total = 0;
  for (let i = 0; i < ENCODE_RUNS; i++) {
    const cover = await encodeToCover(makePayload(202 + i, PAYLOAD_LEN), dict, 2000 + i);
    total += countEmojiInCover(cover);
  }
  console.log(`  total emoji across ${ENCODE_RUNS} runs: ${total}`);
  assert.ok(total > 0, 'emojiIntoWords should fold emoji into word types');
});

// ---------- model-driven path (the actual user scenario) ----------
//
// Hypothesis: the user's flow uses a model built from a corpus that
// references specific original type names (e.g., "noun_object",
// "adj_emotion"). After emoji augs are applied to the base dict and
// sortDict runs, the affected types get MERGED into compound names
// like "em16_face_smile,adj_emotion". The model's references no
// longer resolve in the augmented dict, so the encoder skips those
// slots: and the emoji that the augs folded in never get emitted.
//
// We construct a hand-built model that references the original type
// names, then encode against the Sprinkle-augmented dict via that
// model and check whether emoji surface.

function makeTinyModel() {
  // typeNames as the model would have captured them at build time
  // (BEFORE augs would have merged anything).
  const typeNames = [
    'adj_emotion',
    'noun_object',
    'verb_action',
    'noun_feeling',
  ];
  // Each model entry alternates type slots with literal puncts.
  // Simulates a sentence pattern like "<adj> <noun> <verb> <feeling>."
  return {
    version: 2,
    name: 'diag-model',
    ordered: false,
    typeNames,
    models: [
      { tokens: [0, ' ', 1, ' ', 2, ' ', 3, '. '], weight: 1 },
    ],
  };
}

async function encodeViaModel(payload, dict, modelTable, randomSeed = 1) {
  const sink = [];
  const writer = new WritableStream({ write(c) { sink.push(c); } });
  const reader = new ReadableStream({
    start(c) { c.enqueue(payload); c.close(); },
  });
  const stream = modelTableStream(modelTable, { dict, mode: 'random', random: mulberry32(randomSeed) });
  await encode(reader, writer, dict, { modelStream: stream });
  let total = 0;
  for (const c of sink) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of sink) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

test('model-driven Sprinkle: do emoji surface when the model references ORIGINAL type names?', async () => {
  const { dict, dictJson } = buildAugmentedDict(PRESETS.Sprinkle);
  const modelJson = makeTinyModel();
  const modelTable = loadModelTable(modelJson);

  // Show what types exist in the augmented dict + which the model wants.
  const dictTypeNames = dictJson.types.map(t => t.name);
  const modelTypeNames = modelJson.typeNames;
  const overlap = modelTypeNames.filter(n => dictTypeNames.includes(n));
  const missing = modelTypeNames.filter(n => !dictTypeNames.includes(n));
  console.log(`  dict type names (${dictTypeNames.length}):`);
  for (const n of dictTypeNames) console.log(`    "${n}"`);
  console.log(`  model wants: ${modelTypeNames.join(', ')}`);
  console.log(`  resolved in dict: ${overlap.join(', ') || '<none>'}`);
  console.log(`  unresolved (skipped at encode time): ${missing.join(', ') || '<none>'}`);

  let total = 0;
  let runs = 0;
  for (let i = 0; i < ENCODE_RUNS; i++) {
    try {
      const cover = await encodeViaModel(
        makePayload(404 + i, 60),  // smaller payload, model is short
        dict,
        modelTable,
        4000 + i,
      );
      total += countEmojiInCover(cover);
      runs++;
      if (i === 0) {
        console.log(`  first cover sample: "${cover.slice(0, 200).replace(/\n/g, ' ')}${cover.length > 200 ? '...' : ''}"`);
      }
    } catch (err) {
      if (i === 0) console.log(`  encodeViaModel threw: ${err.message}`);
      break;
    }
  }
  console.log(`  total emoji across ${runs} model-driven runs: ${total}`);
  console.log(`  >>> If 0 here while weightedTypeStream produced 933, the bug is`);
  console.log(`  >>> the model-name-vs-merged-type mismatch: the augs merge target`);
  console.log(`  >>> types into compound names that the corpus-built model can't`);
  console.log(`  >>> resolve. Emoji are in the dict but unreachable through the model.`);
});

test('flag isolation: wordsIntoEmoji ALONE produces emoji in covers', async () => {
  const { dict, dictJson } = buildAugmentedDict({
    emojiIntoWords: false, wordsIntoEmoji: true, mixedPhrases: false,
  });
  const sum = summarizeDict(dictJson, 'wie-only');
  console.log(`  emoji-bearing types: ${sum.emojiBearingTypeCount}`);
  let total = 0;
  for (let i = 0; i < ENCODE_RUNS; i++) {
    const cover = await encodeToCover(makePayload(303 + i, PAYLOAD_LEN), dict, 3000 + i);
    total += countEmojiInCover(cover);
  }
  console.log(`  total emoji across ${ENCODE_RUNS} runs: ${total}`);
  // wordsIntoEmoji puts WORDS into emoji types, so emoji types now
  // contain words too. The emoji glyphs in those types stay; weighted
  // pick of an em16_* type still emits an emoji a fraction of the time.
  assert.ok(total > 0, 'wordsIntoEmoji should not strip emoji from em16 types');
});
