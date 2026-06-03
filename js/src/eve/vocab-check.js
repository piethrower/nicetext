// Eve vocabulary check. Tests which TW-list sources could have
// generated the suspected's word set.
//
// Two-stage analysis on the word x TW-list boolean table:
//   Stage 1 (per-TW-list):
//     - 100% of suspected words present -> likely candidate.
//     - 0% of suspected words present  -> unlikely candidate.
//     - in-between                  -> exposed via per-twlist coverage
//       for stage 2 enumeration.
//   Stage 2 (distinct matchingtwlist groups):
//     - For each unique matchingtwlists value (the set of TW-lists
//       containing a particular suspected word), test whether using
//       just those TW-lists as a candidate combination covers all
//       suspected words. 100% coverage -> a plausible combination.
//
// Also identifies must-literals: suspected words whose matchingtwlists
// is EMPTY (no TW-list contains them). These must have come from
// model literals (^word^ quoted-literal entries in a sentence
// model), not from any TW-list source.
//
// Browser-safe ESM. Caller supplies the TW-list sets (Node CLI
// reads them from fixtures; browser would fetch + parse).

import { tokenize, TOKEN } from '../lexer.js';
import { precleanCorpus } from '../builder/precleanCorpus.js';

export function runVocabCheck(suspectedText, wlistsByKey, opts = {}) {
  // wlistsByKey: Map<twlistName, { has(word): bool }>. The values are
  // wlist projections of each twlist source, duck-typed so callers
  // can pass either a JS Set or a wrapPackedStrings view. The map
  // KEY is the twlist source name (the identity of the source);
  // the VALUE is the source's wordlist (the wlist). Two distinct
  // concepts kept distinct by name. See js/src/sab.js / SAB_RESOURCE_CATEGORIES.
  // opts.onProgress(label) is invoked synchronously as work
  // progresses. Caller throttles; this routine just fires hot.
  const onProgress = opts.onProgress ?? null;

  // Step 1: unique lowercase suspected WORD tokens.
  const uniqueWordsSet = new Set();
  for (const tok of tokenize(suspectedText)) {
    if (tok.type === TOKEN.WORD) uniqueWordsSet.add(tok.value.toLowerCase());
  }
  const uniqueWords = [...uniqueWordsSet].sort();
  const totalUnique = uniqueWords.length;

  const twlistNames = [...wlistsByKey.keys()].sort();

  // Step 2: per-word matchingtwlists set.
  // table: Map<word, Set<twlistName>>.
  const table = new Map();
  let processed = 0;
  for (const word of uniqueWords) {
    const matching = new Set();
    for (const name of twlistNames) {
      if (wlistsByKey.get(name).has(word)) matching.add(name);
    }
    table.set(word, matching);
    processed++;
    if (onProgress) onProgress(`vocab-check: matched ${processed.toLocaleString()}/${totalUnique.toLocaleString()} unique suspected words across ${twlistNames.length} TW-lists`);
  }

  // Step 3 + 4: per-TW-list coverage. Counts how many unique suspected
  // words appear in each TW-list.
  const perTwlistCoverage = new Map();
  for (const name of twlistNames) {
    let hits = 0;
    for (const matching of table.values()) {
      if (matching.has(name)) hits++;
    }
    perTwlistCoverage.set(name, {
      hits,
      total: totalUnique,
      rate: totalUnique > 0 ? hits / totalUnique : 0,
    });
  }

  // Step 6: must-literals (matchingtwlists empty).
  const mustLiterals = [];
  for (const [word, matching] of table) {
    if (matching.size === 0) mustLiterals.push(word);
  }
  mustLiterals.sort();

  // Step 5: distinct matchingtwlists groups, treating each as a
  // candidate combination. Skip empty (literals) and single-element
  // (already handled by per-TW-list step). For each candidate, test
  // whether the candidate TW-lists collectively suspected every suspected
  // word (every suspected word's matchingtwlists must intersect the
  // candidate).
  const groups = new Map();
  for (const [word, matching] of table) {
    if (matching.size === 0) continue; // must-literal
    if (matching.size === 1) continue; // single-twlist (step 3/4)
    const sorted = [...matching].sort();
    const key = sorted.join(',');
    if (!groups.has(key)) {
      groups.set(key, { twlists: sorted, key, wordCount: 0 });
    }
    groups.get(key).wordCount++;
  }

  const candidateCombinations = [];
  let comboIdx = 0;
  const totalCombos = groups.size;
  for (const g of groups.values()) {
    const candidateSet = new Set(g.twlists);
    let covered = 0;
    let coveredExcludingLiterals = 0;
    const totalNonLiteral = totalUnique - mustLiterals.length;
    for (const matching of table.values()) {
      if (matching.size === 0) continue;
      let hit = false;
      for (const t of matching) {
        if (candidateSet.has(t)) { hit = true; break; }
      }
      if (hit) { coveredExcludingLiterals++; covered++; }
    }
    comboIdx++;
    if (onProgress) onProgress(`vocab-check: evaluated ${comboIdx.toLocaleString()}/${totalCombos.toLocaleString()} candidate combinations`);
    candidateCombinations.push({
      twlists: g.twlists,
      key: g.key,
      wordCount: g.wordCount,
      coveredExcludingLiterals,
      totalNonLiteral,
      coverageRate: totalNonLiteral > 0 ? coveredExcludingLiterals / totalNonLiteral : 0,
      // 100% coverage of non-literal words = this combination explains
      // the entire non-literal suspected vocabulary.
      coversAllNonLiterals: coveredExcludingLiterals === totalNonLiteral && totalNonLiteral > 0,
    });
  }
  // Sort: 100%-covering first (smaller combos preferred), then by
  // coverage rate desc, then size asc.
  candidateCombinations.sort((a, b) => {
    if (a.coversAllNonLiterals !== b.coversAllNonLiterals) {
      return a.coversAllNonLiterals ? -1 : 1;
    }
    if (b.coverageRate !== a.coverageRate) return b.coverageRate - a.coverageRate;
    return a.twlists.length - b.twlists.length;
  });

  return {
    totalUnique,
    uniqueWords,
    twlistNames,
    table,
    perTwlistCoverage,
    mustLiterals,
    candidateCombinations,
  };
}

// Extract the unique lowercase WORD vocabulary from a corpus.
// Drives the corpus pseudo-TW-list check (story.vocabulary='corpus')
// and the corpus-wlist fixture build (tools/build-corpus-wlist.js).
//
// Runs precleanCorpus first, mirroring the engine's genmodel
// pipeline (genmodel.js applies precleanCorpus before tokenize).
// Without this, curly apostrophes (U+2019) in the raw corpus
// would tokenize as separate punct tokens, but the engine's
// internal vocab has them normalized to U+0027 contractions like
// `clapp'd`. Eve's vocab must match the engine's tokenization
// to compare suspected words correctly.
export function extractCorpusVocab(corpusText) {
  const precleaned = precleanCorpus(corpusText);
  const vocab = new Set();
  for (const tok of tokenize(precleaned)) {
    if (tok.type === TOKEN.WORD) vocab.add(tok.value.toLowerCase());
  }
  return vocab;
}
