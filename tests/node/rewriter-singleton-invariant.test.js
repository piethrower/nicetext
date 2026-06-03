// rewriter-singleton-invariant.test.js
//
// The cover-transforms rewriters (typos, british, voice rewriter, xanax)
// and the voice reformatter rely on a 0-bit-per-slot guarantee:
// each transform-owned word carries a unique `<prefix>_w_<word>`
// atomic type that makes the merged-type bucket a singleton.
//
// The aug-pipeline (emojiIntoWords in particular) fans emoji + emoji-
// phrase entries across every atomic type each CLDR-keyword word
// carries. If the transform singletons are in the augs' input, the
// fan-out injects entries into the singleton types and breaks the
// 0-bit invariant. The session-build pipeline guards against this by
// running the augs BEFORE concatenating the transform singletons (see
// docs/cover-transforms.md and js/src/worker/build-session-worker.js
// "Transform-singleton injection" block).
//
// This test pins that ordering by simulating it with synthetic inputs
// chosen so the failure mode would be obvious: a CLDR keyword that's
// also a typos canonical, hit at mix > 0 so the eiw aug emits phrase
// fanout. If the ordering ever regresses (or future code paths bypass
// it), the invariant assertion fires.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { runAugsPacked } from '../../js/src/builder/aug-pipeline.js';
import { sortDict } from '../../js/src/builder/sortdct.js';

// CLDR keyword "happy" is the bait: it's also a (synthetic) typos
// canonical here, mirroring the 600 real-world CLDR/typos canonical
// overlaps in the shipped fixtures.
const SMILE = '😀';
const CLDR = { [SMILE]: ['happy', 'face'] };

// Base entries, what would come from kimmo / mit / etc. before the
// rewriter singletons get added.
const BASE_ENTRIES = [
  { type: 'kimmo_adj', word: 'happy' },
  { type: 'kimmo_adj', word: 'sad' },
  { type: 'kimmo_noun', word: 'face' },
  { type: 'em16_face_smile', word: SMILE },
];

// Transform singletons, what gets concatenated AFTER the augs run, in
// the fixed session-build ordering. Two pseudo-words per canonical
// (the canonical itself plus a typo variant) mirror the real typos
// twlist's coverage.
const TRANSFORM_SINGLETONS = [
  { type: 'typos_w_happy', word: 'happy' },
  { type: 'typos_w_hapy',  word: 'hapy' },
  { type: 'typos_w_face',  word: 'face' },
  { type: 'typos_w_fce',   word: 'fce' },
];

// Stand-in for any future transform whose tags follow the same
// `<family>_w_<word>` shape. Matches typos / british / voice rewriter
// / xanax in the shipped code.
const SINGLETON_PREFIXES = [
  'typos_w_', 'british_w_', 'voice_w_', 'xanax_',
];

function looksLikeSingletonType(typeString) {
  for (const part of typeString.split(',')) {
    for (const p of SINGLETON_PREFIXES) {
      if (part.startsWith(p)) return part;
    }
  }
  return null;
}

test('aug-pipeline does not pollute rewriter singleton types when ordering is correct', async () => {
  // CORRECT ordering: augs see only base + emoji; transform singletons
  // get concatenated AFTER the augs finish, then sortDict.
  const augOut = await runAugsPacked(BASE_ENTRIES, ['eiw'], {
    cldr: CLDR,
    eiwMix: 3,
    useWorkers: false,
  });
  const final = await sortDict(augOut.concat(TRANSFORM_SINGLETONS));

  // Group merged words by atomic singleton type. For every word whose
  // merged type contains a singleton atom, count how many distinct
  // words share that atom.
  const wordsByAtom = new Map();
  for (const e of final) {
    for (const atom of e.type.split(',')) {
      for (const p of SINGLETON_PREFIXES) {
        if (atom.startsWith(p)) {
          if (!wordsByAtom.has(atom)) wordsByAtom.set(atom, new Set());
          wordsByAtom.get(atom).add(e.word);
        }
      }
    }
  }
  for (const [atom, words] of wordsByAtom) {
    assert.equal(words.size, 1,
      `singleton atomic type "${atom}" must carry exactly one word; ` +
      `got ${words.size}: [${[...words].slice(0, 5).join(', ')}]`);
  }
});

test('aug-pipeline DOES pollute singletons when ordering is WRONG (regression catcher)', async () => {
  // Inverted ordering: transform singletons are in the augs' INPUT.
  // This is the bug the ordering was designed to prevent. We assert it
  // would in fact pollute, so the positive test above isn't passing by
  // happenstance (e.g., if the synthetic fixture happened to dodge the
  // CLDR-keyword/typos overlap).
  const polluted = await runAugsPacked(
    BASE_ENTRIES.concat(TRANSFORM_SINGLETONS),
    ['eiw'],
    { cldr: CLDR, eiwMix: 3, useWorkers: false },
  );
  const final = await sortDict(polluted);

  // Expect at least one singleton atom to have ended up with > 1 word.
  let sawPollution = false;
  const wordsByAtom = new Map();
  for (const e of final) {
    for (const atom of e.type.split(',')) {
      for (const p of SINGLETON_PREFIXES) {
        if (atom.startsWith(p)) {
          if (!wordsByAtom.has(atom)) wordsByAtom.set(atom, new Set());
          wordsByAtom.get(atom).add(e.word);
        }
      }
    }
  }
  for (const words of wordsByAtom.values()) {
    if (words.size > 1) { sawPollution = true; break; }
  }
  assert.ok(sawPollution,
    'wrong ordering must produce at least one polluted singleton; ' +
    'if this assertion stops firing the test fixture has drifted and ' +
    'the positive test loses its meaning');
});
