// Measurement test for docs/research-notes.md §12. Question: is
// alphabetical position correlated with word frequency across the
// three external freq lists (norvig, google-books, gutenberg)?
//
// Why it matters for §12: the current Huffman tie-break is "input order
// = alphabetical ASC", and the heap's `order ASC` semantic puts late-
// inserted (alpha-late) words at SHALLOW Huffman slots. If alpha
// position has zero correlation with frequency, that bias is
// directionless noise, keeping or reversing it changes nothing on
// average across many tied groups. If there's a real correlation, the
// sign tells us whether the current default systematically promotes
// commoner or rarer words.
//
// Two complementary techniques, both reported per list:
//   1. Spearman's rank correlation ρ between (alpha-rank, freq-rank).
//      Tied frequencies use average ranks. ρ ∈ [-1, 1]; sign = direction,
//      magnitude = strength. The canonical "are these two rankings
//      correlated" answer.
//   2. Per-first-letter mean log10(count). Coarser, but the §12-
//      relevant tie-break regime often involves words differing by
//      first letter (small same-weight groups in random.dict), so
//      this surface matches the actual use case more directly than
//      the global ρ.
//
// The test passes by emitting diagnostics. It asserts only that ρ
// stays in [-1, 1] and is finite for each list.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';
import { gunzipSync } from './shims/node-zlib.js';
import { unpackFreqFromSAB } from '../../js/src/builder/freq-pack.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

// Read a .freq.sab.gz fixture (NTFQ format, gzipped at rest) and
// return the {totalTokens, counts: Map<word, count>} shape parseFreqLines
// used to produce. The native .freq.tsv.gz files are gone post sab
// pack freq; the SAB is the canonical runtime form.
function readFreqFixture(url) {
  const data = readFileSync(url);
  const path = url instanceof URL ? url.pathname : url;
  // node returns Buffer (gzipped); the browser shim returns the
  // gunzipped bytes already (see tests/node/shims/node-fs.js).
  let raw;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    raw = String(path).endsWith('.gz') ? gunzipSync(data) : data;
  } else {
    raw = data;
  }
  // Copy bytes into a fresh SharedArrayBuffer so the wrap path
  // works identically across runtimes.
  const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const sab = new SharedArrayBuffer(view.byteLength);
  new Uint8Array(sab).set(view);
  return unpackFreqFromSAB(sab);
}

// Compute average rank vector for an array `arr` sorted ascending by
// the comparison key. Tied entries (cmp returns 0 between adjacent
// elements after sort) share the average of their slot indices, which
// is the standard treatment for Spearman's ρ under ties. Returns a
// Map<element, rank>. Rank uses 1-based indexing for readability;
// Pearson is shift-invariant so the choice doesn't change ρ.
function averageRanks(arr, cmp) {
  const sorted = arr.slice().sort(cmp);
  const ranks = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && cmp(sorted[j + 1], sorted[i]) === 0) j++;
    const avg = (i + j) / 2 + 1; // 1-based average of slots [i..j]
    for (let k = i; k <= j; k++) ranks.set(sorted[k], avg);
    i = j + 1;
  }
  return ranks;
}

// Pearson correlation between two equal-length numeric arrays.
// When applied to rank vectors, this IS Spearman's ρ.
function pearson(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dxx = 0, dyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dxx += dx * dx; dyy += dy * dy;
  }
  const denom = Math.sqrt(dxx * dyy);
  return denom === 0 ? 0 : num / denom;
}

function spearman(words, counts) {
  // alpha rank: ascending lexicographic order; ties (duplicate words)
  // shouldn't occur in a freq list but averageRanks handles them.
  const alphaRank = averageRanks(words.map((w, i) => i),
    (a, b) => (words[a] < words[b] ? -1 : words[a] > words[b] ? 1 : 0));
  // freq rank: most-frequent = rank 1.
  const freqRank = averageRanks(words.map((w, i) => i),
    (a, b) => counts[b] - counts[a]);
  const xs = new Float64Array(words.length);
  const ys = new Float64Array(words.length);
  for (let i = 0; i < words.length; i++) {
    xs[i] = alphaRank.get(i);
    ys[i] = freqRank.get(i);
  }
  return pearson(xs, ys);
}

function perLetterStats(words, counts) {
  // Bucket by lowercase first character. Compute mean log10(count) and
  // member count per bucket. Returns rows sorted by bucket char so the
  // table reads alphabetically.
  const buckets = new Map();
  for (let i = 0; i < words.length; i++) {
    const c = words[i].charAt(0).toLowerCase();
    if (!buckets.has(c)) buckets.set(c, { sum: 0, n: 0 });
    const b = buckets.get(c);
    b.sum += Math.log10(counts[i]);
    b.n++;
  }
  const rows = [];
  for (const [c, { sum, n }] of buckets) rows.push({ c, n, meanLog: sum / n });
  rows.sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  return rows;
}

const LISTS = [
  { fixture: 'norvig.freq.sab.gz',    label: 'norvig'    },
  { fixture: 'google.freq.sab.gz',    label: 'google'    },
  { fixture: 'gutenberg.freq.sab.gz', label: 'gutenberg' },
];

for (const lst of LISTS) {
  test(`alpha-vs-freq correlation: ${lst.label}`, (t) => {
    const { totalTokens, counts } = readFreqFixture(new URL(lst.fixture, FIXTURES));
    const words = [];
    const cnts  = [];
    for (const [w, c] of counts) { words.push(w); cnts.push(c); }
    const n = words.length;
    t.diagnostic(`words: ${n}, total tokens: ${totalTokens}`);

    const rho = spearman(words, cnts);
    t.diagnostic(`Spearman ρ(alpha-rank, freq-rank) = ${rho.toFixed(5)}`);

    // Per-first-letter mean log10(count). Letters only, non-letter
    // first-chars (digits, punctuation) get bucketed under their own
    // first char; we report them too in case a list has many.
    const rows = perLetterStats(words, cnts);
    t.diagnostic(`per-first-char mean log10(count):`);
    for (const r of rows) {
      const bar = '#'.repeat(Math.max(0, Math.round((r.meanLog) * 4)));
      t.diagnostic(`  ${r.c}  n=${String(r.n).padStart(6)}  mean log10 = ${r.meanLog.toFixed(3)}  ${bar}`);
    }

    assert.ok(Number.isFinite(rho) && rho >= -1 && rho <= 1, `ρ out of range: ${rho}`);
  });
}
