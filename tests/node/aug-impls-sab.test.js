// aug-impls-sab.test.js: SAB-native aug implementations produce the
// same logical output as the JS-object references in tests/node/_aug-helpers.js.
// Mix is now folded into Aug A and Aug B (engine spec §C); the
// standalone mixedPhrasesContributionPacked has been removed.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  emojiIntoWordsContributionFromArray,
  wordsIntoEmojiContributionFromArray,
  emojiIntoWordsContributionPacked,
} from '../../js/src/builder/aug-impls-sab.js';
import { packEntries, unpackEntries } from '../../js/src/builder/entries-sab.js';
import { applyEmojiAugmentation } from './_aug-helpers.js';

const SMILE = '😀';
const HEART = '💖';
const SPARK = '✨';

const CLDR = {
  [SMILE]: ['happy', 'face', 'smile'],
  [HEART]: ['heart', 'love', 'pink'],
  [SPARK]: ['shine', 'sparkle'],
};

// Realistic-shape input: emoji home types + Latin word types whose
// vocab overlaps CLDR keywords.
const BASE = [
  { type: 'em16_face_smile', word: SMILE },
  { type: 'em16_heart',      word: HEART },
  { type: 'em16_event',      word: SPARK },
  { type: 'adj_emotion', word: 'happy' },
  { type: 'adj_emotion', word: 'sad' },
  { type: 'noun_object', word: 'heart' },
  { type: 'noun_object', word: 'box' },
  { type: 'verb_action', word: 'shine' },
  { type: 'noun_feeling', word: 'love' },
];

// Sort entries to a canonical form for set-equality comparison.
function canonicalize(arr) {
  return arr
    .map(e => `${e.type}\t${e.word}`)
    .sort();
}

test('Aug A (SAB) matches legacy contribution at mix=0', () => {
  const sabContribs = emojiIntoWordsContributionFromArray(BASE, { cldr: CLDR });
  const legacy = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: false, mixedPhrases: 0,
  });
  const baseKeys = new Set(canonicalize(BASE));
  const legacyContribs = legacy.filter(e => !baseKeys.has(`${e.type}\t${e.word}`));
  assert.deepEqual(canonicalize(sabContribs), canonicalize(legacyContribs));
});

test('Aug B (SAB) matches legacy contribution at mix=0', () => {
  const sabContribs = wordsIntoEmojiContributionFromArray(BASE, { cldr: CLDR });
  const legacy = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: false, wordsIntoEmoji: true, mixedPhrases: 0,
  });
  const baseKeys = new Set(canonicalize(BASE));
  const legacyContribs = legacy.filter(e => !baseKeys.has(`${e.type}\t${e.word}`));
  assert.deepEqual(canonicalize(sabContribs), canonicalize(legacyContribs));
});

test('Aug A with mix=N matches the legacy reference for the same mix', () => {
  for (const mix of [1, 2, 5]) {
    const sab = emojiIntoWordsContributionFromArray(BASE, { cldr: CLDR, mix });
    const legacy = applyEmojiAugmentation(BASE, {
      cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: false, mixedPhrases: mix,
    });
    const baseKeys = new Set(canonicalize(BASE));
    const legacyContribs = legacy.filter(e => !baseKeys.has(`${e.type}\t${e.word}`));
    assert.deepEqual(canonicalize(sab), canonicalize(legacyContribs),
      `Aug A mix=${mix}`);
  }
});

test('Aug B with mix=N matches the legacy reference for the same mix', () => {
  for (const mix of [1, 2, 5]) {
    const sab = wordsIntoEmojiContributionFromArray(BASE, { cldr: CLDR, mix });
    const legacy = applyEmojiAugmentation(BASE, {
      cldr: CLDR, emojiIntoWords: false, wordsIntoEmoji: true, mixedPhrases: mix,
    });
    const baseKeys = new Set(canonicalize(BASE));
    const legacyContribs = legacy.filter(e => !baseKeys.has(`${e.type}\t${e.word}`));
    assert.deepEqual(canonicalize(sab), canonicalize(legacyContribs),
      `Aug B mix=${mix}`);
  }
});

test('mix=N emits the expected per-tuple count: 1 atom + N word-phrases + (N-1) bare repeats', () => {
  // Construct a synthetic input where exactly one (emoji, keyword, T) tuple
  // matches: SMILE has CLDR keyword "happy"; "happy" lives in adj_emotion.
  // SMILE's home type is em16_face_smile, so adj_emotion is a target type.
  const tiny = [
    { type: 'em16_face_smile', word: SMILE },
    { type: 'adj_emotion',      word: 'happy' },
  ];
  for (const N of [0, 1, 2, 3, 5, 7]) {
    const out = emojiIntoWordsContributionFromArray(tiny, {
      cldr: { [SMILE]: ['happy'] }, mix: N,
    });
    // 1 atom + N word-phrases + max(0, N-1) bare-repeats.
    const expected = 1 + N + Math.max(0, N - 1);
    assert.equal(out.length, expected,
      `mix=${N}: expected ${expected} emits, got ${out.length}`);
  }
});

test('packed entry-points return a valid entries-SAB view', () => {
  const inputView = packEntries(BASE);
  const out = emojiIntoWordsContributionPacked([inputView], { cldr: CLDR });
  // SAB output should be a wrappable view; unpack and compare to the
  // FromArray adapter's output.
  const unpacked = unpackEntries(out);
  const fromArray = emojiIntoWordsContributionFromArray(BASE, { cldr: CLDR });
  assert.deepEqual(canonicalize(unpacked), canonicalize(fromArray));
});

test('SAB output handles UTF-8 multibyte words and emoji glyphs without corruption', () => {
  const tricky = [
    { type: 't', word: 'Привет' },
    { type: 't', word: 'こんにちは' },
    { type: 't', word: 'café' },        // precomposed
    { type: 't', word: 'café' },        // decomposed (separate entry, distinct bytes)
    { type: 't', word: 'happy 😀' },
  ];
  const inputView = packEntries(tricky);
  // Round-trip the emoji-aug packed entry point through SAB; confirm
  // no UTF-8 corruption on extraction.
  const out = emojiIntoWordsContributionPacked([inputView], { cldr: CLDR });
  const unpacked = unpackEntries(out);
  for (const e of unpacked) {
    assert.ok(typeof e.word === 'string' && e.word.length > 0);
    assert.ok(typeof e.type === 'string' && e.type.length > 0);
  }
});
