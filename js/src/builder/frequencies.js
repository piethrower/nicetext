// Frequency-source pipeline for the BYOS freq picker (research-notes
// §11). Pure data transforms, no fs. Browser-safe ESM.
//
// Two helpers:
//   parseFreqLines(text), read a freq fixture body (TSV; '#' header
//     comments skipped) into { totalTokens, counts: Map<word,count> }.
//   combineFrequencies(sources), merge several source blobs into a
//     Huffman-weight Map<word,int> via the §11.4 math.
//   wordCountsToFreqSource(wordCounts), adapt a corpus's
//     listWordsWithCounts() output into a freq-source blob so corpus
//     counts can ride the same merge as external fixtures.
//
// totalTokens is the sum of counts over the FIXTURE's curated subset
// (not the original corpus's full token total). The fixture is already
// vocab-pruned to the union of base-dict / TW-list words; using the
// fixture's own sum keeps the pipeline self-contained, at the cost of
// inflating each kept word's per-source p relative to the source's
// true p. For the §11 purpose (relative weights inside a Huffman type),
// uniform inflation across one source cancels out, what matters is
// cross-source comparability, which the per-source / total quotient
// already provides.

// Read a freq-fixture body. Format: tab-delimited `<word>\t<count>`
// lines, '#' comments skipped, blank lines ignored. Counts must be
// positive numbers; lines that don't parse cleanly are dropped on the
// floor (matches the build-side fetcher's tolerance).
export function parseFreqLines(text) {
  const counts = new Map();
  let totalTokens = 0;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const word = line.slice(0, tab);
    const n = Number(line.slice(tab + 1));
    if (!word || !Number.isFinite(n) || n <= 0) continue;
    counts.set(word, n);
    totalTokens += n;
  }
  return { totalTokens, counts };
}

// Adapt listWordsWithCounts(corpus) output into a freq-source blob so
// it can ride the same combineFrequencies merge as the external
// fixtures. The corpus's own counts become one source among several.
export function wordCountsToFreqSource(wordCounts) {
  let totalTokens = 0;
  for (const c of wordCounts.values()) totalTokens += c;
  return { totalTokens, counts: wordCounts };
}

// Combine N freq sources into integer Huffman weights.
//
// Math (§11.4):
//   p_s(w) = count_s(w) / totalTokens_s
//   p(w)   = mean( p_s(w) for s in sources_that_have_w )   [skip-if-absent]
//   weight(w) = max(1, round(p(w) * SCALE))                [SCALE = 1e9]
//
// "Skip-if-absent" means a word missing from a source contributes no
// zero to its own average. Each present source carries equal voice.
// Words missing from EVERY selected source don't appear in the output;
// dct2mstr's per-word lookup falls back to weight=1 (its existing
// uniform default).
//
// Returns Map<word, integer-weight>, suitable as `frequencies` for
// buildDictionary.
const SCALE = 1e9;
export function combineFrequencies(sources) {
  if (!sources || sources.length === 0) return new Map();
  const sumP = new Map();         // word → sum of p_s across present sources
  const presentCount = new Map(); // word → number of sources containing it
  for (const { totalTokens, counts } of sources) {
    if (!totalTokens || !counts || counts.size === 0) continue;
    const inv = 1 / totalTokens;
    for (const [w, c] of counts) {
      sumP.set(w, (sumP.get(w) || 0) + c * inv);
      presentCount.set(w, (presentCount.get(w) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [w, sp] of sumP) {
    const n = presentCount.get(w) || 1;
    const p = sp / n;
    out.set(w, Math.max(1, Math.round(p * SCALE)));
  }
  return out;
}
