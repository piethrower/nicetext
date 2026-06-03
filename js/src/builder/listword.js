// listword: tokenize a corpus and count distinct word occurrences.
// Phrase-aware: when the caller supplies a phraseIndex (typically
// dict.phraseIndex), runs the lexer's phraseFuse pass so multi-word
// dict entries are counted under their canonical key.
//
// Redaction: every call merges getRedactedMatcher() (singles +
// phrases, canonical = REDACTION_MARKER) with the caller's
// phraseIndex into one combined index before phraseFuse. Slurs and
// slur phrases collapse to the marker token at the lexer-aligned
// phraseFuse pass, no raw-text regex anywhere. See redaction.js for
// the matcher build and js/src/lexer.js for phraseFuse semantics.
// Always async because the redacted set loads via loadResource.
//
// Browser-safe ESM.

import { tokenize, phraseFuse, TOKEN } from '../lexer.js';
import { precleanCorpus } from './precleanCorpus.js';
import { getRedactedMatcher } from './redaction.js';

// opts.onProgress (optional): callback invoked roughly every
// PROGRESS_SAMPLE tokens with `{pos, total}` so long corpora can
// drive a real progress bar from character-offset.
// opts.phraseIndex / opts.maxPhraseLen (optional, paired): when the
// caller has a base dict with multi-word entries, pass these so a
// corpus phrase like `a la carte` counts under its canonical key
// instead of as 3 separate single-word entries. The redacted matcher
// is always merged in regardless; this opt just adds the dict's
// phrase entries.
const PROGRESS_SAMPLE = 4096;

export async function listWordsWithCounts(text, opts = {}) {
  text = precleanCorpus(text);
  const redacted = await getRedactedMatcher();
  const { phraseIndex, maxPhraseLen } = mergePhraseIndex(
    opts.phraseIndex, opts.maxPhraseLen || 0,
    redacted.phraseIndex, redacted.maxPhraseLen,
  );
  const counts = new Map();
  let n = 0;
  const total = text.length;
  const rawTokens = tokenize(text, { skipBoilerplate: true });
  const tokens = phraseIndex.size > 0
    ? phraseFuse(rawTokens, phraseIndex, maxPhraseLen)
    : rawTokens;
  for (const tok of tokens) {
    if (opts.onProgress && (++n & (PROGRESS_SAMPLE - 1)) === 0) {
      opts.onProgress({ pos: tok.position, total });
    }
    if (tok.type !== TOKEN.WORD) continue;
    const w = tok.value.toLowerCase();
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  if (opts.onProgress) opts.onProgress({ pos: total, total });
  return counts;
}

export async function listWords(text) {
  return [...(await listWordsWithCounts(text)).keys()].sort();
}

// Merge two phraseIndex/maxPhraseLen pairs into one combined pair.
// Each index is Map<headWord, Array<{parts, canonical}>>. Concat
// candidate arrays per head and re-sort by parts.length desc so
// phraseFuse's greedy-longest-first behavior is preserved.
function mergePhraseIndex(idxA, maxA, idxB, maxB) {
  const out = new Map();
  if (idxA) for (const [k, v] of idxA) out.set(k, [...v]);
  if (idxB) for (const [k, v] of idxB) {
    const cur = out.get(k);
    if (cur) cur.push(...v);
    else out.set(k, [...v]);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => b.parts.length - a.parts.length);
  }
  return { phraseIndex: out, maxPhraseLen: Math.max(maxA, maxB) };
}
