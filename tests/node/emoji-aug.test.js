// Tests for cross-modal emoji augmentation. applyEmojiAugmentation
// runs Aug A and Aug B as a pure data transform on a {type, word}
// entries array, type-blind throughout. Mix is folded into A/B per
// spec §C: integer 0..MIX_MAX controls phrase-variant intensity.
// The reference impl lives in tests/node/_aug-helpers.js; production
// uses the SAB-native paths in js/src/builder/aug-impls-sab.js.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { applyEmojiAugmentation } from './_aug-helpers.js';

const ROSE = '🌹';
const TULIP = '🌷';
const RAIN = '🌧️';

// Realistic-shape input: emoji are in their em16_<subgroup> home
// type with siblings; Latin words are in noun-class types.
const BASE = [
  { type: 'em16_plant_flower', word: ROSE },
  { type: 'em16_plant_flower', word: TULIP },
  { type: 'em16_sky_weather',  word: RAIN },
  { type: 'flower_noun', word: 'rose' },
  { type: 'flower_noun', word: 'tulip' },
  { type: 'flower_noun', word: 'lily' },
  { type: 'weather_noun', word: 'rain' },
  { type: 'weather_noun', word: 'cloud' },
];

const CLDR = {
  [ROSE]: ['rose', 'flower', 'red'],
  [TULIP]: ['tulip', 'flower'],
  [RAIN]: ['rain', 'cloud', 'weather'],
};

function findEntries(arr, predicate) {
  return arr.filter(predicate);
}

test('Aug A: emoji propagates into word types via CLDR keywords', () => {
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true,
  });
  // 🌹 has keyword "rose" which is in flower_noun → expect (flower_noun, 🌹).
  assert.ok(out.find(e => e.type === 'flower_noun' && e.word === ROSE),
    'expected (flower_noun, 🌹) from Aug A');
  // 🌷 has keyword "tulip" → (flower_noun, 🌷).
  assert.ok(out.find(e => e.type === 'flower_noun' && e.word === TULIP));
  // 🌧️ has keyword "rain" → (weather_noun, 🌧️). Also "cloud" → (weather_noun, 🌧️) again (deduped).
  assert.ok(out.find(e => e.type === 'weather_noun' && e.word === RAIN));
});

test('Aug A skips the emoji home type (already there)', () => {
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true,
  });
  const homeRose = findEntries(out, e => e.type === 'em16_plant_flower' && e.word === ROSE);
  assert.equal(homeRose.length, 1, '🌹 should not be re-emitted into its home type');
});

test('Aug B: words propagate into emoji home types via CLDR keywords', () => {
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, wordsIntoEmoji: true,
  });
  // 🌹's CLDR keyword "rose" exists as a word in flower_noun → emit (em16_plant_flower, "rose").
  assert.ok(out.find(e => e.type === 'em16_plant_flower' && e.word === 'rose'));
  // "rain" exists → emit (em16_sky_weather, "rain").
  assert.ok(out.find(e => e.type === 'em16_sky_weather' && e.word === 'rain'));
  // Aug B should NOT emit the inverse (Aug A) entries.
  assert.ok(!out.find(e => e.type === 'flower_noun' && e.word === ROSE),
    'Aug B alone should not produce Aug A emissions');
});

test('Aug A + mix=1: word-phrase variant emits alongside the atomic emoji', () => {
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, mixedPhrases: 1,
  });
  // For (T=flower_noun, k=rose, E=🌹), mix=1 emits (T, "rose 🌹").
  assert.ok(out.find(e => e.type === 'flower_noun' && e.word === `rose ${ROSE}`));
  assert.ok(out.find(e => e.type === 'flower_noun' && e.word === `tulip ${TULIP}`));
  // mix=1 is keyword-grounded only: lily wasn't a CLDR keyword, no "lily 🌹".
  assert.ok(!out.find(e => e.type === 'flower_noun' && e.word === `lily ${ROSE}`),
    'mix never walks type members; lily is not a CLDR keyword for 🌹');
});

test('Aug A + mix=N: emoji-repeat variants up to N copies', () => {
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, mixedPhrases: 3,
  });
  // mix=3 emits per (E,k,T) tuple: atom, "k E", "k EE", "k EEE", "EE", "EEE".
  for (const word of [`rose ${ROSE}`, `rose ${ROSE}${ROSE}`, `rose ${ROSE}${ROSE}${ROSE}`,
                       `${ROSE}${ROSE}`, `${ROSE}${ROSE}${ROSE}`]) {
    assert.ok(out.find(e => e.type === 'flower_noun' && e.word === word),
      `expected (flower_noun, "${word}") at mix=3`);
  }
  // Bare-1 (just "🌹") is the atomic A emit, never re-emitted by mix.
  // Bare-4+ should not appear.
  assert.ok(!out.find(e => e.type === 'flower_noun' && e.word === `${ROSE}${ROSE}${ROSE}${ROSE}`),
    'mix=3 must not emit the 4× bare-repeat');
});

test('mix is type-blind: never walks type members for unrelated words', () => {
  // Adversarial check that the "wide" type-membership-walk is gone:
  // lily lives in flower_noun but isn't a CLDR keyword for any emoji,
  // so no phrase containing "lily" should ever appear.
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: true, mixedPhrases: 7,
  });
  for (const e of out) {
    assert.ok(!/^lily /.test(e.word), `unexpected type-walked phrase: ${e.word}`);
  }
});

test('curatedKeywords filter restricts the CLDR keyword input set', () => {
  const curated = new Set(['rose']); // only "rose" survives the filter
  const out = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, curatedKeywords: curated,
  });
  // (flower_noun, 🌹) should still appear (rose is curated).
  assert.ok(out.find(e => e.type === 'flower_noun' && e.word === ROSE));
  // (flower_noun, 🌷) should NOT appear (tulip not in curated set).
  assert.ok(!out.find(e => e.type === 'flower_noun' && e.word === TULIP));
  // (weather_noun, 🌧️) should NOT appear (rain/cloud/weather not curated).
  assert.ok(!out.find(e => e.type === 'weather_noun' && e.word === RAIN));
});

test('augmentation is type-blind (no aug parses type-name substrings)', () => {
  // Use opaque type ids that say nothing about emoji/word/etc.
  const opaque = [
    { type: 't1', word: ROSE },
    { type: 't1', word: TULIP },
    { type: 't2', word: 'rose' },
    { type: 't2', word: 'tulip' },
  ];
  const out = applyEmojiAugmentation(opaque, {
    cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: true,
  });
  // Aug A: 🌹 propagates to t2 because t2 contains "rose".
  assert.ok(out.find(e => e.type === 't2' && e.word === ROSE));
  // Aug B: "rose" propagates to t1 because 🌹 lives in t1.
  assert.ok(out.find(e => e.type === 't1' && e.word === 'rose'));
});

test('augmentation is idempotent (no duplicate emit on same input)', () => {
  const opts = { cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: true, mixedPhrases: 1 };
  const once = applyEmojiAugmentation(BASE, opts);
  // Pre-existing entries kept at head; re-applying on the augmented
  // output should produce the same set (Set-deduped emissions).
  const twice = applyEmojiAugmentation(once, opts);
  const onceKey = new Set(once.map(e => `${e.type}\t${e.word}`));
  const twiceKey = new Set(twice.map(e => `${e.type}\t${e.word}`));
  assert.equal(twiceKey.size, onceKey.size, 're-applying aug should not grow the set');
});

test('returns input unchanged when cldr missing or A/B both off', () => {
  assert.equal(applyEmojiAugmentation(BASE, { cldr: null, emojiIntoWords: true }), BASE);
  assert.equal(applyEmojiAugmentation(BASE, { cldr: CLDR }), BASE); // no aug flags
});
