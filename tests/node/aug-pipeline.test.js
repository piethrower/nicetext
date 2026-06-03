// aug-pipeline.test.js: fixed-point augmentation orchestrator (Phase 3).
//
// Tests the structural layered design from docs/research-notes.md §18:
// per-iter inputs are the prior-iter contributions of OTHER augs (no
// merge, no dedup at orchestrator level). In-process path only here
// (poolSize=1) for fast smoke; worker path is exercised by the browser
// runner / Phase-4 wiring.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { runAugsPacked } from '../../js/src/builder/aug-pipeline.js';
import { applyEmojiAugmentation } from './_aug-helpers.js';
import { sortDict } from '../../js/src/builder/sortdct.js';

const SMILE = '😀';
const HEART = '💖';
const SPARK = '✨';

const CLDR = {
  [SMILE]: ['happy', 'face', 'smile'],
  [HEART]: ['heart', 'love', 'pink'],
  [SPARK]: ['shine', 'sparkle'],
};

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

function keys(arr) {
  return new Set(arr.map(e => `${e.type}\t${e.word}`));
}

// Post-pipeline equivalence: runAugsPacked now sortDict-collapses t0 at
// the top, so its output uses merged-type strings while the legacy
// applyVowelAugmentation / applyEmojiAugmentation reference functions
// emit raw atomic types. Both produce the same final dict after
// downstream sortDict, so the right comparison is sortDict-on-both.
async function mergedKeys(arr) {
  return keys(await sortDict(arr));
}

test('empty selectedAugs returns await sortDict(t0)', async () => {
  const out = await runAugsPacked(BASE, [], { useWorkers: false });
  assert.deepEqual(keys(out), keys(await sortDict(BASE)));
});

test('eiw-only matches the legacy Aug-A contributions', async () => {
  const out = await runAugsPacked(BASE, ['eiw'], {
    cldr: CLDR, emojiIntoWords: true, useWorkers: false,
  });
  const legacy = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: false, mixedPhrases: false,
  });
  assert.deepEqual(mergedKeys(out), mergedKeys(legacy));
});

test('wie-only matches the legacy Aug-B contributions', async () => {
  const out = await runAugsPacked(BASE, ['wie'], {
    cldr: CLDR, wordsIntoEmoji: true, useWorkers: false,
  });
  const legacy = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: false, wordsIntoEmoji: true, mixedPhrases: false,
  });
  assert.deepEqual(mergedKeys(out), mergedKeys(legacy));
});

test('combined fixed-point superset-includes the legacy single-pass union', async () => {
  // The §18.2 fixed-point semantics CAN emit more than the single-pass
  // legacy chain (cross-aug interactions surface across iterations).
  // Floor check: for every word the legacy union produces, the
  // orchestrator's atomic-type-set for that word is a superset.
  // Merged-type-string equality won't work because the orchestrator's
  // pre-collapse step plus iter-2 cross-feed can broaden a word's type
  // set beyond what legacy emits, semantically a superset, but a
  // different merged string. Splitting comma-joined types back to
  // atomic sets is what we actually care about.
  // mix moved from a single legacy axis (`mixedPhrases`) to per-aug
  // depths (`eiwMix` / `wieMix`); compare at the equivalent setting
  // for an apples-to-apples superset check.
  const out = await runAugsPacked(BASE, ['eiw', 'wie'], {
    cldr: CLDR,
    eiwMix: 1,
    wieMix: 1,
    useWorkers: false,
  });
  const legacyEmoji = applyEmojiAugmentation(BASE, {
    cldr: CLDR, emojiIntoWords: true, wordsIntoEmoji: true, mixedPhrases: 1,
  });
  const want = wordToAtomicTypes(await sortDict(legacyEmoji));
  const got = wordToAtomicTypes(await sortDict(out));
  for (const [word, wantTypes] of want) {
    const gotTypes = got.get(word);
    assert.ok(gotTypes, `expected word in output: "${word}"`);
    for (const t of wantTypes) {
      assert.ok(gotTypes.has(t), `expected word "${word}" to carry type "${t}" (got types: ${[...gotTypes].sort().join(',')})`);
    }
  }
});

// Map<word, Set<atomicType>> built by splitting each entry's comma-merged
// type back to atomics. Pure helper for type-set superset assertions.
function wordToAtomicTypes(arr) {
  const out = new Map();
  for (const e of arr) {
    if (!out.has(e.word)) out.set(e.word, new Set());
    const set = out.get(e.word);
    for (const part of (e.type ?? '').split(',')) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  return out;
}

test('progress callback fires per-aug and per-iter; converges within cap', async () => {
  const events = [];
  await runAugsPacked(BASE, ['eiw', 'wie'], {
    cldr: CLDR,
    mix: 1,
    useWorkers: false,
    onProgress: (e) => events.push(e),
  });
  const iters = new Set(events.filter(e => e.phase === 'aug-iter').map(e => e.iter));
  // Cap is selectedAugs.length + 1 = 3. Should NOT need to exceed it.
  assert.ok(iters.size >= 1, 'at least one iter ran');
  assert.ok(iters.size <= 3, `iters exceeded cap: saw ${iters.size}`);
  // Each iter should have one aug-done event per selected aug (2 augs
  // post-vowel-retirement: mix folds into A and B and is no longer a
  // separate aug).
  for (const iter of iters) {
    const augDone = events.filter(e => e.phase === 'aug-done' && e.iter === iter);
    assert.equal(augDone.length, 2, `iter ${iter} missing aug-done events`);
  }
});

test('emoji augs without cldr produce empty contributions and converge in iter 1', async () => {
  // No cldr means eiw/wie return empty.
  const events = [];
  const out = await runAugsPacked(BASE, ['eiw', 'wie'], {
    cldr: undefined,
    mix: 1,
    useWorkers: false,
    onProgress: (e) => events.push(e),
  });
  // Output should equal await sortDict(BASE) (no aug emitted anything; the
  // orchestrator pre-collapses t0).
  assert.deepEqual(keys(out), keys(await sortDict(BASE)));
  // Loop should have run exactly one iteration before convergence.
  const augIterEvents = events.filter(e => e.phase === 'aug-iter');
  assert.equal(augIterEvents.length, 1);
  assert.equal(augIterEvents[0].total, 0);
});

test('iter-1 single-aug eiw converges immediately on simple input', async () => {
  // Sanity check that the orchestrator finishes quickly on
  // single-aug input with no cross-feed amplification. The earlier
  // vowel+eiw layered-fixed-point scenario went away with the vowel
  // aug retirement (see js/src/rewriter/xanax.js).
  const tiny = [
    { type: 'em16_face_smile', word: SMILE },
    { type: 'adj_emotion', word: 'happy' },
  ];
  const events = [];
  await runAugsPacked(tiny, ['eiw'], {
    cldr: CLDR,
    useWorkers: false,
    onProgress: (e) => events.push(e),
  });
  const iters = new Set(events.filter(e => e.phase === 'aug-iter').map(e => e.iter));
  assert.ok(iters.size >= 1 && iters.size <= 3);
});
