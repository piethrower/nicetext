// js/src/rewriter/_lookup-swap.js: shared runtime for cover-transform
// rewriters whose apply() is pure word lookup + swap.
//
// Used by `typos` and `british` (and any future rewriter whose
// fundamental operation is "see word X in phraseBuf, swap to a
// randomly-picked variant from a Map<X, Set<replacements>>"). The
// xanax rewriter has its own apply() because the article-agreement
// rule consults TWO entries (article + next word), not just the
// most-recent push.
//
// Each calling module invokes `createLookupSwapRewriter()` once at
// module load, captures the returned setters + apply, and re-exports
// them. The factory pattern keeps each module's NTRW data, intensity,
// and RNG isolated, encode.js dispatches setRewriterData on every
// chain entry per-job, so modules share infrastructure but never
// share runtime state.

export function createLookupSwapRewriter() {
  let rewriterData = null;
  let rewriterIntensity = 100;
  let rewriterRandom = null;

  function setRewriterData(map) {
    rewriterData = map;
  }

  function setRewriterIntensity(n) {
    rewriterIntensity = Number.isInteger(n) && n >= 0 && n <= 100 ? n : 100;
  }

  function setRewriterRandom(rng) {
    rewriterRandom = typeof rng === 'function' ? rng : null;
  }

  function _resetRewriterDataForTests() {
    rewriterData = null;
    rewriterIntensity = 100;
    rewriterRandom = null;
  }

  function apply(phraseBuf) {
    if (!Array.isArray(phraseBuf) || phraseBuf.length === 0) return;
    if (!rewriterData) return;
    if (!rewriterRandom) return;
    if (rewriterIntensity <= 0) return;

    const last = phraseBuf[phraseBuf.length - 1];
    if (!last || last.kind === 'state' || typeof last.word !== 'string') return;

    // Replacement-probability coin. Skip when the draw lands at or
    // above the threshold; the cover keeps the encoder's original
    // word.
    if (rewriterIntensity < 100) {
      if (rewriterRandom() * 100 >= rewriterIntensity) return;
    }

    const lower = last.word.toLowerCase();
    const candidates = rewriterData.get(lower);
    if (!candidates || candidates.size === 0) return;

    // Variant-pick coin: uniform draw over the candidate set.
    // Materialize the Set once into an array so the indexed pick is
    // O(1); the set is typically size 1..6.
    const arr = [...candidates];
    const pick = arr[Math.floor(rewriterRandom() * arr.length)];
    if (!pick || pick === lower) return;

    // Preserve the surface case from the original emission so the
    // swap blends in. Three cases: all-caps, leading-cap, lowercase.
    last.word = applyCaseFromOriginal(last.word, pick);

    // Refresh phrase-fusion bookkeeping. The encoder uses entry.parts
    // (lowercased word split on space) for analyzePhraseBuf; rewrite
    // it from the new word so subsequent fuse checks see the truth.
    if (Array.isArray(last.parts)) {
      last.parts = last.word.toLowerCase().split(' ');
    }
  }

  return {
    apply,
    setRewriterData,
    setRewriterIntensity,
    setRewriterRandom,
    _resetRewriterDataForTests,
  };
}

export function applyCaseFromOriginal(original, replacement) {
  if (!original || !replacement) return replacement;
  if (original === original.toUpperCase() && original.toLowerCase() !== original) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()
      && original.slice(1) === original.slice(1).toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
