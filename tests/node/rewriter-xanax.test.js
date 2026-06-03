// rewriter-xanax.test.js: node smoke for the xanax cover-transform
// rewriter runtime (js/src/rewriter/xanax.js).
//
// Covers:
//   - XANAX_TYPE_A / XANAX_TYPE_AN constants are exported with their
//     canonical "xanax_a" / "xanax_an" values (these are the type-
//     name strings packed into fixtures/rewriter-xanax.twlist.sab.gz
//     at build time; the SAB itself is verified by the
//     build-rewriter-fixtures + sab-pack round-trip).
//   - isStrictVowelLetter() applies the [aeiou] rule case-insensitively
//     and returns false on empty / non-string / non-letter input.
//   - apply(phraseBuf) mutates the article when needed and leaves
//     it alone otherwise; respects word-vs-state entries; preserves
//     leading-cap on the mutated article.
//
// Encoder integration (apply() invoked from inside the encoder) is
// out of scope for this smoke and lands in step 4 of the
// cover-transforms arc.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';
import { gunzipSync } from './shims/node-zlib.js';

import {
  XANAX_TYPE_A,
  XANAX_TYPE_AN,
  isStrictVowelLetter,
  isAllCapsWord,
  decideArticle,
  apply,
  setRewriterData,
} from '../../js/src/rewriter/xanax.js';
import { unpackRewriterMap } from '../../js/src/builder/rewriter-sab.js';

// Bootstrap xanax's apply-time NTRW lookup so decideArticle's CMU-
// exception path is exercised. Cross-runtime fixture load: node:fs
// shim returns a Buffer in Node (needs gunzip) and a pre-decompressed
// Uint8Array in the browser (already gunzipped by the preload shim).
const FIXTURES = new URL('../../fixtures/', import.meta.url);
const _xanaxRaw = readFileSync(new URL('xanax.rewriter.sab.gz', FIXTURES));
const _xanaxBytes = (typeof Buffer !== 'undefined' && Buffer.isBuffer(_xanaxRaw))
  ? gunzipSync(_xanaxRaw)
  : _xanaxRaw;
const _xanaxView = new Uint8Array(_xanaxBytes.buffer, _xanaxBytes.byteOffset, _xanaxBytes.byteLength);
const _xanaxSab = new SharedArrayBuffer(_xanaxView.byteLength);
new Uint8Array(_xanaxSab).set(_xanaxView);
setRewriterData(unpackRewriterMap(_xanaxSab));

// ---- type-name constants ------------------------------------------

test('xanax: XANAX_TYPE_A / XANAX_TYPE_AN export the canonical singletons', () => {
  // These strings are what tools/build-rewriter-fixtures.js packs into
  // fixtures/rewriter-xanax.twlist.sab.gz. If either name shifts the
  // packed SAB drifts and any session that loads the rewriter twlist
  // at the wrong key will silently fail to inject xanax's singletons.
  assert.equal(XANAX_TYPE_A,  'xanax_a');
  assert.equal(XANAX_TYPE_AN, 'xanax_an');
});

// ---- isStrictVowelLetter ------------------------------------------

test('xanax: isStrictVowelLetter applies [aeiou] case-insensitively', () => {
  // Strict-orthographic rule: letter ∈ [aeiou]. Words like "united"
  // and "one" return true here (their leading letters are u/o);
  // the CMU-phonology refinement that knows they're consonant-onset
  // is a future arc layered on top of the strict baseline.
  for (const w of ['apple', 'Apple', 'EAGLE', 'iceberg', 'orange',
                   'umbrella', 'united', 'one']) {
    assert.equal(isStrictVowelLetter(w), true, `expected vowel: ${w}`);
  }
  for (const w of ['banana', 'cat', 'hour', 'happy', 'thing', 'banana']) {
    assert.equal(isStrictVowelLetter(w), false, `expected non-vowel: ${w}`);
  }
});

test('xanax: isStrictVowelLetter returns false on empty / non-letter / non-string', () => {
  assert.equal(isStrictVowelLetter(''), false);
  assert.equal(isStrictVowelLetter(undefined), false);
  assert.equal(isStrictVowelLetter(null), false);
  assert.equal(isStrictVowelLetter(42), false);
  assert.equal(isStrictVowelLetter('123'), false);
  assert.equal(isStrictVowelLetter('!'), false);
});

// ---- apply --------------------------------------------------------

function wordEntry(w) { return { word: w, slotBits: [], parts: null }; }
function stateEntry(v) { return { kind: 'state', value: v, slotBits: [] }; }

test('xanax: apply rewrites "a apple" → "an apple"', () => {
  const buf = [wordEntry('a'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'an');
  assert.equal(buf[1].word, 'apple');
});

test('xanax: apply rewrites "an cat" → "a cat"', () => {
  const buf = [wordEntry('an'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'a');
  assert.equal(buf[1].word, 'cat');
});

test('xanax: apply leaves "a cat" alone (already correct)', () => {
  const buf = [wordEntry('a'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'a');
});

test('xanax: apply leaves "an apple" alone (already correct)', () => {
  const buf = [wordEntry('an'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'an');
});

test('xanax: apply preserves leading-cap on the article (sentence-start)', () => {
  const buf = [wordEntry('A'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'An');
});

test('xanax: apply preserves leading-cap when "An" → "A"', () => {
  const buf = [wordEntry('An'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'A');
});

test('xanax: apply is no-op when previous slot is a state marker', () => {
  const buf = [stateEntry('foo'), wordEntry('apple')];
  apply(buf);
  // No mutation expected; state has no `.word` to swap.
  assert.equal(buf[0].kind, 'state');
  assert.equal(buf[1].word, 'apple');
});

test('xanax: apply is no-op when just-pushed entry is a state marker', () => {
  const buf = [wordEntry('a'), stateEntry('end-of-sentence')];
  apply(buf);
  assert.equal(buf[0].word, 'a');
});

test('xanax: apply is no-op when previous slot is not an article', () => {
  const buf = [wordEntry('the'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'the');
});

test('xanax: apply is no-op on under-length phraseBuf', () => {
  const buf0 = [];
  apply(buf0);
  assert.equal(buf0.length, 0);
  const buf1 = [wordEntry('a')];
  apply(buf1);
  assert.equal(buf1[0].word, 'a');
});

test('xanax: apply only inspects the last two entries', () => {
  // Mid-buffer history must not be perturbed.
  const buf = [
    wordEntry('the'),
    wordEntry('quick'),
    wordEntry('a'),       // <- penultimate
    wordEntry('apple'),   // <- last (vowel-led)
  ];
  apply(buf);
  assert.equal(buf[0].word, 'the');
  assert.equal(buf[1].word, 'quick');
  assert.equal(buf[2].word, 'an');
  assert.equal(buf[3].word, 'apple');
});

test('xanax: apply does not swap when next-word is non-letter', () => {
  // Non-letter leading char → isStrictVowelLetter returns false →
  // article stays "a" or becomes "a". Either way, never "an".
  const buf1 = [wordEntry('a'), wordEntry('42')];
  apply(buf1);
  assert.equal(buf1[0].word, 'a');

  const buf2 = [wordEntry('an'), wordEntry('42')];
  apply(buf2);
  assert.equal(buf2[0].word, 'a');
});

// ---- CMU-phonology exception sets --------------------------------

test('xanax: decideArticle uses XANAX_TAKES_AN_DESPITE_CONSONANT_LETTER for silent-h words', () => {
  // Words starting with silent 'h' take "an" despite the consonant
  // letter: this is the CMU-driven override of strict-ortho.
  for (const w of ['hour', 'honest', 'honor', 'heir']) {
    assert.equal(decideArticle(w), 'an', `expected "an ${w}"`);
  }
});

test('xanax: decideArticle uses XANAX_TAKES_A_DESPITE_VOWEL_LETTER for consonant-onset vowel-letter words', () => {
  // Vowel letter, but the phoneme onset is a consonant (Y/W). The
  // natural article is "a": "a united", "a one", "a European".
  for (const w of ['united', 'university', 'one', 'european']) {
    assert.equal(decideArticle(w), 'a', `expected "a ${w}"`);
  }
});

test('xanax: decideArticle falls back to strict-ortho for non-exception words', () => {
  // Standard cases the strict rule handles correctly, the
  // exception sets should NOT intercept these.
  assert.equal(decideArticle('apple'), 'an');
  assert.equal(decideArticle('cat'),   'a');
  assert.equal(decideArticle('happy'), 'a');   // h-letter, h-onset (CONS)
  assert.equal(decideArticle('eagle'), 'an');  // e-letter, vowel onset
});

test('xanax: decideArticle is case-insensitive on the input', () => {
  assert.equal(decideArticle('Hour'),    'an');
  assert.equal(decideArticle('UNITED'),  'a');
  assert.equal(decideArticle('Apple'),   'an');
});

test('xanax: decideArticle returns null for empty / non-string / non-letter input', () => {
  assert.equal(decideArticle(''), null);
  assert.equal(decideArticle(undefined), null);
  assert.equal(decideArticle(null), null);
  assert.equal(decideArticle(42), null);
  // Non-letter leading char falls back to strict-ortho ('a').
  assert.equal(decideArticle('42'), 'a');
  assert.equal(decideArticle('!'),  'a');
});

test('xanax: apply rewrites "a hour" → "an hour" via CMU silent-h override', () => {
  const buf = [wordEntry('a'), wordEntry('hour')];
  apply(buf);
  assert.equal(buf[0].word, 'an');
  assert.equal(buf[1].word, 'hour');
});

test('xanax: apply rewrites "an united" → "a united" via CMU consonant-onset override', () => {
  const buf = [wordEntry('an'), wordEntry('united')];
  apply(buf);
  assert.equal(buf[0].word, 'a');
  assert.equal(buf[1].word, 'united');
});

test('xanax: apply preserves leading-cap when overriding via CMU exceptions', () => {
  const buf = [wordEntry('A'), wordEntry('hour')];
  apply(buf);
  assert.equal(buf[0].word, 'An', 'leading-cap preserved on CMU-driven swap');
});

// ---- isAllCapsWord ------------------------------------------------

test('xanax: isAllCapsWord recognizes all-caps letter-words', () => {
  for (const w of ['APPLE', 'CAT', 'I', 'U.S.A.', 'I.B.M.', 'A']) {
    assert.equal(isAllCapsWord(w), true, `expected all-caps: ${w}`);
  }
});

test('xanax: isAllCapsWord rejects mixed / lower / non-letter', () => {
  for (const w of ['Apple', 'aPPLE', 'apple', 'iPad', 'aN', '', '42', '!?']) {
    assert.equal(isAllCapsWord(w), false, `expected NOT all-caps: ${w}`);
  }
});

test('xanax: isAllCapsWord returns false on non-string input', () => {
  assert.equal(isAllCapsWord(undefined), false);
  assert.equal(isAllCapsWord(null), false);
  assert.equal(isAllCapsWord(42), false);
});

// ---- full case-mapping table -------------------------------------

// The seven-cell case map from the cover-transforms arc spec:
//   shrink (an -> a):  an->a, An->A, AN->A, aN->a
//   grow   (a  -> an): a->an, A->An, A->AN (next-word peek)
// Each case below pins one cell.

test('xanax: case map: an apple -> an apple (no change, lower)', () => {
  const buf = [wordEntry('an'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'an');
});

test('xanax: case map: An -> A (shrink, init-cap)', () => {
  const buf = [wordEntry('An'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'A');
});

test('xanax: case map: AN -> A (shrink, all-caps collapses to single-char A)', () => {
  const buf = [wordEntry('AN'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'A');
});

test('xanax: case map: aN -> a (shrink, first-lower mixed)', () => {
  // First letter lowercase wins: emit lowercase article regardless of
  // the trailing N. The N is dropped by the article-identity swap.
  const buf = [wordEntry('aN'), wordEntry('cat')];
  apply(buf);
  assert.equal(buf[0].word, 'a');
});

test('xanax: case map: a -> an (grow, lower)', () => {
  const buf = [wordEntry('a'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'an');
});

test('xanax: case map: A -> An when next word is NOT all-caps', () => {
  const buf = [wordEntry('A'), wordEntry('apple')];
  apply(buf);
  assert.equal(buf[0].word, 'An');
});

test('xanax: case map: A -> AN when next word IS all-caps', () => {
  // Disambiguation rule: a 1-char uppercase prev "A" could be either
  // init-cap or all-caps. Peek the next word; if it is itself all-
  // caps, the surrounding context is all-caps, so emit "AN APPLE".
  const buf = [wordEntry('A'), wordEntry('APPLE')];
  apply(buf);
  assert.equal(buf[0].word, 'AN');
  assert.equal(buf[1].word, 'APPLE');
});

test('xanax: case map: A -> AN when next word is single-letter all-caps', () => {
  // Edge case: a single-letter all-caps word like "I" or "X" still
  // counts as all-caps under isAllCapsWord.
  const buf = [wordEntry('A'), wordEntry('I')];
  apply(buf);
  assert.equal(buf[0].word, 'AN');
});

test('xanax: case map: A -> An when next word has any lowercase letter', () => {
  // "iPad" is mixed-case (not all-caps), so default init-cap "An".
  const buf = [wordEntry('A'), wordEntry('iPad')];
  apply(buf);
  // iPad starts with 'i' (vowel) -> strict-ortho gives "an"; mixed
  // case on the next word -> init-cap article -> "An".
  assert.equal(buf[0].word, 'An');
});

test('xanax: case map: AN preserved as all-caps via CMU silent-h override', () => {
  // "a HOUR" should become "AN HOUR" -- prev "a" is lowercase though,
  // so this is the lowercase grow case. Use prev="A" to exercise the
  // peek-driven all-caps emission with a CMU override.
  const buf = [wordEntry('A'), wordEntry('HOUR')];
  apply(buf);
  // decideArticle is case-insensitive on the input and consults the
  // CMU silent-h set for "hour" -> "an"; next word all-caps -> "AN".
  assert.equal(buf[0].word, 'AN');
  assert.equal(buf[1].word, 'HOUR');
});

test('xanax: case map: AN -> A preserved as single-char A via CMU consonant-onset override', () => {
  // "AN UNITED" should become "A UNITED" -- prev all-caps "AN",
  // CMU override says "united" takes "a"; shrink to single-char "A".
  const buf = [wordEntry('AN'), wordEntry('UNITED')];
  apply(buf);
  assert.equal(buf[0].word, 'A');
  assert.equal(buf[1].word, 'UNITED');
});
