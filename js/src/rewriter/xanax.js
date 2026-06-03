// js/src/rewriter/xanax.js -- runtime for the xanax cover-transform
// rewriter (per-emission a/an agreement correction).
//
// Architecture: see `docs/cover-transforms.md`.
// Research:     see `fixture-src/rewriters/xanax/research.md`.
//
// Two responsibilities:
//
// 1. The two 0-bit unique-type singletons xanax owns
//    ({ type: 'xanax_a',  word: 'a'  }, { type: 'xanax_an', word: 'an' })
//    are packed at build time into fixtures/rewriter-xanax.twlist.sab.gz
//    by tools/build-rewriter-fixtures.js, using the XANAX_TYPE_A /
//    XANAX_TYPE_AN constants exported from this module. sortdct loads
//    that SAB through the standard twlist resource path when
//    byos.rewriter.xanax > 0. Each is a singleton type (one word
//    per type, 0 bits per slot), so swapping "a" <-> "an" in the cover
//    does not perturb the bitstream the decoder recovers (both surfaces
//    decode to 0 bits via their respective unique-type lookup).
//
// 2. `apply(phraseBuf, ...)` is called by the encoder per-emission.
//    It inspects the just-emitted word and, if the previous slot in
//    phraseBuf is the article "a" or "an", mutates that previous slot
//    to whichever article agrees with the just-emitted next word.
//    The mutation is detected by the engine's natural per-push
//    `analyzePhraseBuf` rewind path if it creates or destroys a
//    phrase-fusion match; xanax itself does no phrase-fusion check.
//
// Two-tier agreement rule (research.md §"Encoder design"):
//
//   1. CMU-phonology exception sets (fixtures/rewriter-xanax.data.js).
//      If the next word is in XANAX_TAKES_A_DESPITE_VOWEL_LETTER (a-onset
//      consonant words like "united", "one", "European"), force "a"
//      even though the leading letter is in [aeiou].
//      If the next word is in XANAX_TAKES_AN_DESPITE_CONSONANT_LETTER
//      (silent-h words like "hour", "honest", "honor"), force "an"
//      even though the leading letter is a consonant.
//
//   2. Strict-orthographic fallback. When the next word is not in
//      either exception set: leading letter in [aeiou] -> "an", else
//      "a". This covers the ~99% case; the exception sets cover the
//      remaining ~0.75% per the corpus-sweep measurement in
//      research.md.

// ---- exports ------------------------------------------------------

// Type-name constants for the two 0-bit unique-type singletons that
// xanax owns ("a" and "an"). Exported so the offline build script in
// tools/build-rewriter-fixtures.js can pack them into the runtime
// twlist SAB at fixtures/rewriter-xanax.twlist.sab.gz, that fixture
// is what sortdct loads when byos.rewriter.xanax intensity > 0.
// There is no getRewriterUniqueTwlist() function on the runtime side:
// every rewriter's unique twlist lives in its rewriter-<name>.twlist
// .sab.gz fixture; the in-memory return path was retired so the
// loader sees one uniform shape across all rewriters.
export const XANAX_TYPE_A  = 'xanax_a';
export const XANAX_TYPE_AN = 'xanax_an';

// CMU-derived apply-time lookup data, loaded from fixtures/xanax
// .rewriter.sab.gz (NTRW) via setRewriterData() at engine startup.
// Map<next-word, Set<correct-article>>: a hit on the next-word
// overrides the strict-orthographic fallback in decideArticle().
//
// Null until setRewriterData() is called. decideArticle() handles
// the null state by falling back to strict-ortho only (no exception
// overrides). This keeps the function usable in test contexts that
// haven't loaded the fixture, with the obvious caveat that
// CMU-driven exceptions won't fire.
let rewriterData = null;

// Apply-time "replacement probability %" intensity, integer 0..100.
// At 100 (default) every trigger fires; at 0 apply() short-circuits
// to no-op; in between the coin flip below skips a proportional
// share of triggers. Set per-encode by the engine from
// opts.rewriterFlags.xanax.
let rewriterIntensity = 100;

// Non-secret RNG (returns [0, 1)) used for the apply-time coin flip.
// Wired per-encode by the engine from the same randomSeed-derived
// chain used for sentence-model sampling, so cover output stays
// deterministic across runs with the same seed. Null until set; at
// intensity < 100 the apply() short-circuits when null (defensive).
let rewriterRandom = null;

// Wire the loaded NTRW Map into this module. Called by the engine
// path (worker / jobs / encode opts) after `loadResource('xanax',
// 'rewriter', { fixture: true })` has produced the SAB and
// unpackRewriterMap has materialized it. Idempotent; a second call
// with the same Map is a no-op-equivalent overwrite.
export function setRewriterData(map) {
  rewriterData = map;
}

// Wire the per-encode intensity (0..100). Integer; the validator
// upstream guarantees range. 0 collapses to no-op even before the
// encoder filters this rewriter out, so callers don't need to gate
// the set when intensity is 0.
export function setRewriterIntensity(n) {
  rewriterIntensity = Number.isInteger(n) && n >= 0 && n <= 100 ? n : 100;
}

// Wire the per-encode non-secret RNG (zero-argument fn returning a
// float in [0, 1)). The engine seeds this from randomSeed so the
// coin flip is reproducible across runs. Encoder calls this before
// any apply() is dispatched for the chain.
export function setRewriterRandom(rng) {
  rewriterRandom = typeof rng === 'function' ? rng : null;
}

// Test helper: reset module-scoped state so unit tests can exercise
// the null-data fallback path without leaking state between cases.
// Production engine code never calls this.
export function _resetRewriterDataForTests() {
  rewriterData = null;
  rewriterIntensity = 100;
  rewriterRandom = null;
}

// Strict-orthographic vowel test on the first letter of a word.
// Returns true iff the word's leading character is one of [aeiou]
// (case-insensitive). Words starting with non-letter characters
// (digits, emoji, punctuation) are treated as non-vowel so the
// article defaults to "a"; encoder callers should avoid invoking
// xanax when the next emission is non-letter.
export function isStrictVowelLetter(word) {
  if (!word || typeof word !== 'string') return false;
  const ch = word[0].toLowerCase();
  return ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u';
}

// "All-caps word" test used by apply() to disambiguate emission case
// when the previous article slot is a single-char uppercase "A" and
// the new article needs to grow to two characters. A word is all-caps
// iff it contains at least one letter and every letter in it is
// uppercase; non-letter characters (digits, punctuation, emoji) are
// ignored so things like "I.B.M." or "U.S.A." still register as
// all-caps.
export function isAllCapsWord(word) {
  if (!word || typeof word !== 'string') return false;
  let hasLetter = false;
  for (const ch of word) {
    const upper = ch.toUpperCase();
    const lower = ch.toLowerCase();
    if (upper === lower) continue; // non-letter
    if (ch === lower) return false; // lowercase letter present
    hasLetter = true;
  }
  return hasLetter;
}

// Two-tier decision used by apply(). Returns 'a' or 'an' for the
// correct article preceding `nextWord`, or null when `nextWord` is
// not a string we can classify (empty / non-letter leading char /
// not a string). The two-tier rule consults the CMU-derived
// exception sets first, then falls back to strict-orthography.
//
// Exposed so callers (Eve detectors, validation harness, tests)
// can use the same decision function as the runtime.
export function decideArticle(nextWord) {
  if (typeof nextWord !== 'string' || nextWord.length === 0) return null;
  const lower = nextWord.toLowerCase();
  if (rewriterData) {
    const articles = rewriterData.get(lower);
    if (articles && articles.size > 0) {
      // Universal NTRW shape Map<key, Set<value>>: for xanax every
      // exception has a single article in its set ("a" or "an"),
      // so first-iterate is the value. Defensive against future
      // multi-value layouts (e.g., a key with both "a" and "an"
      // could be authored by a generalized variant pack), return
      // the first observed.
      for (const a of articles) return a;
    }
  }
  // Strict-ortho fallback. Non-letter leading char -> false -> "a".
  return isStrictVowelLetter(nextWord) ? 'an' : 'a';
}

// Per-emission entry point. phraseBuf is the encoder's per-emission
// word/state buffer; entries are either:
//   { word, slotBits, parts? }     -- a WORD emission
//   { kind: 'state', value, ... }  -- a state marker
//
// Contract: called after a new entry has been pushed. If the
// entry immediately before the just-pushed one is the article
// "a" or "an", and the just-pushed entry is a WORD, mutate the
// previous entry's `word` to match strict-orthographic agreement
// with the just-pushed word. Otherwise no-op.
//
// Returns void; mutation is in-place on phraseBuf.
export function apply(phraseBuf) {
  if (!Array.isArray(phraseBuf) || phraseBuf.length < 2) return;
  const justPushed = phraseBuf[phraseBuf.length - 1];
  const prev       = phraseBuf[phraseBuf.length - 2];

  // The just-pushed entry must be a word (state markers carry no
  // letter signal for the agreement rule).
  if (!justPushed || justPushed.kind === 'state' || typeof justPushed.word !== 'string') return;

  // The previous slot must be a word emission of either article.
  if (!prev || prev.kind === 'state' || typeof prev.word !== 'string') return;
  const prevLower = prev.word.toLowerCase();
  if (prevLower !== 'a' && prevLower !== 'an') return;

  // "Replacement probability %" coin flip. At intensity 100 always
  // proceed (no draw consumed); at < 100 draw a non-secret coin
  // [0, 100) and skip if it lands at or above the threshold. Skipping
  // bypasses the orthographic fallback too, that's the agreed
  // semantic, so the cover keeps the encoder's original article when
  // xanax declines to correct it.
  if (rewriterIntensity < 100) {
    if (!rewriterRandom) return;
    if (rewriterRandom() * 100 >= rewriterIntensity) return;
  }

  const correctArticle = decideArticle(justPushed.word);
  if (!correctArticle || prevLower === correctArticle) return;

  // Three-way case preservation: lower / init-cap / all-caps. The
  // shrink direction (an->a) collapses any uppercase form to "A"
  // because the single-char article is indistinguishable between
  // init-cap and all-caps. The grow direction (a->an) carries the
  // ambiguity: a 1-char "A" could be either, so we peek at the just-
  // pushed word -- if it is itself all-caps, emit "AN"; otherwise
  // "An". Multi-char prev with mixed case (e.g., "aN") is treated as
  // lowercase since the first letter is lower. Decoder normalizes
  // case at lookup so none of this affects round-trip; it affects
  // cover naturalness in all-caps contexts.
  const firstCh   = prev.word[0];
  const firstUp   = firstCh === firstCh.toUpperCase() && firstCh !== firstCh.toLowerCase();
  let outputArticle;
  if (!firstUp) {
    outputArticle = correctArticle;
  } else {
    const prevAllCaps = prev.word.length >= 2
                     && prev.word === prev.word.toUpperCase()
                     && prev.word !== prev.word.toLowerCase();
    const peekAllCaps = prev.word.length === 1
                     && correctArticle.length === 2
                     && isAllCapsWord(justPushed.word);
    if (prevAllCaps || peekAllCaps) {
      outputArticle = correctArticle.toUpperCase();
    } else {
      outputArticle = correctArticle[0].toUpperCase() + correctArticle.slice(1);
    }
  }
  prev.word = outputArticle;
}
