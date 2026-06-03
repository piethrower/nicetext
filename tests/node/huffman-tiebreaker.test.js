// Measurement test for docs/research-notes.md §12 (Huffman tie-breaker
// design). Computes the per-type expected character cost
//
//   E[chars per emit | type] = Σ_w wordLen(w) × 2^(-bits(w))
//
// under candidate input orderings, and reports aggregate metrics. The
// metric is exact for any valid Huffman code: each leaf w is selected
// with probability exactly 2^(-bits(w)) per emit because the encoder
// consumes uniform-random ciphertext bits. Lower is better.
//
// The test passes by emitting `t.diagnostic` numbers and asserting
// only the structural invariants (every candidate produces a valid
// Huffman code and reaches every input word). The numbers tell the
// developer whether changing buildDictionary's default input ordering
// is worth the global re-bake of every shipped fixture.
//
// Important asymmetry of the current builder: huffman.js heap
// tie-breaks by `order ASC`, and items popped first end up DEEPER.
// So the LATEST-inserted word gets the SHALLOWEST slot. To push short
// words into shallow slots we must sort `(length DESC, alpha ASC)`,
// not `(length ASC, alpha ASC)` as research-notes §12 currently
// proposes. This test reports BOTH directions so the asymmetry is
// visible, not assumed.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';
import { gunzipSync } from './shims/node-zlib.js';
import { buildHuffman, verifyHuffman } from '../../js/src/builder/huffman.js';
import { combineFrequencies } from '../../js/src/builder/frequencies.js';
import { unpackFreqFromSAB } from '../../js/src/builder/freq-pack.js';
import { loadDictJsonFixture, fixtureURL } from './_helpers.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

// ---------- helpers ----------

function readGzText(url) {
  const data = readFileSync(url);
  if (typeof data === 'string') return data; // browser shim already decompressed
  const path = url instanceof URL ? url.pathname : url;
  return String(path).endsWith('.gz')
    ? gunzipSync(data).toString('utf8')
    : data.toString('utf8');
}

// Read a .freq.sab.gz fixture and return the {totalTokens, counts}
// shape parseFreqLines used to produce. The native .freq.tsv.gz files
// are gone post sab pack freq.
function readFreqFixture(url) {
  const data = readFileSync(url);
  const path = url instanceof URL ? url.pathname : url;
  let raw;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    raw = String(path).endsWith('.gz') ? gunzipSync(data) : data;
  } else {
    raw = data;
  }
  const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const sab = new SharedArrayBuffer(view.byteLength);
  new Uint8Array(sab).set(view);
  return unpackFreqFromSAB(sab);
}

function typesFromDict(dict) {
  const idxToName = new Map(dict.types.map(t => [t.index, t.name]));
  const byType = new Map();
  for (const { word, typeIndex } of dict.words) {
    const name = idxToName.get(typeIndex);
    if (!byType.has(name)) byType.set(name, []);
    byType.get(name).push(word);
  }
  return byType;
}

const cmpAlpha = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Order a word list by a candidate tie-break key. The buildHuffman heap
// breaks weight-ties by insertion order ascending, so the first word in
// the returned array ends up deepest within its weight class.
function orderWords(words, key, freqMap) {
  const w = words.slice();
  switch (key) {
    case 'alpha-asc':
      w.sort(cmpAlpha);
      break;
    case 'len-asc-alpha':
      // §12's proposal as written. Short words first → deepest slot
      // within their weight class. Expected to be WORSE than alpha-asc.
      w.sort((a, b) => a.length - b.length || cmpAlpha(a, b));
      break;
    case 'len-desc-alpha':
      // Long words first → short words last → shallow slots.
      w.sort((a, b) => b.length - a.length || cmpAlpha(a, b));
      break;
    case 'freq-asc-alpha':
      // Low freq first → high freq last → shallow within same weight.
      // Matches §12's "prefer higher external frequency for shallow
      // slot" intent (relative to the current builder's order ASC).
      w.sort((a, b) => {
        const fa = freqMap.get(a) ?? 0, fb = freqMap.get(b) ?? 0;
        return fa - fb || cmpAlpha(a, b);
      });
      break;
    case 'freq-desc-alpha':
      w.sort((a, b) => {
        const fa = freqMap.get(a) ?? 0, fb = freqMap.get(b) ?? 0;
        return fb - fa || cmpAlpha(a, b);
      });
      break;
    default:
      throw new Error(`unknown ordering: ${key}`);
  }
  return w;
}

function expectedChars(coded) {
  let s = 0;
  for (const { item, bits } of coded) s += item.length * Math.pow(2, -bits);
  return s;
}

// `weightMap` carries the integer weight passed to buildHuffman (the
// §11.4-floored value, or all-ones for uniform). `freqMap` carries
// the ORIGINAL external frequency used only for tie-break ordering;
// keeping it separate matters because §12's freq-tiebreak idea is
// "among words at the same integer weight, prefer higher external
// frequency", which requires the pre-floor count, not the floored
// weight (the latter is by definition equal across the tied group).
function metricForType(words, key, weightMap, freqMap) {
  const ordered = orderWords(words, key, freqMap || weightMap || new Map());
  const items = ordered.map(w => ({
    item: w,
    weight: weightMap ? (weightMap.get(w) ?? 1) : 1,
  }));
  const coded = buildHuffman(items);
  verifyHuffman(coded);
  // sanity: every input word is reachable
  assert.equal(coded.length, words.length);
  return expectedChars(coded);
}

function fmtPct(baseline, candidate) {
  const d = (baseline - candidate) / baseline * 100;
  const sign = d >= 0 ? '-' : '+';
  return `${sign}${Math.abs(d).toFixed(3)}%`;
}

// ---------- uniform weight=1 regime ----------
//
// random.dict and mit.dict were built without an external frequency
// source, so every word carries weight=1. This is the regime where the
// tie-breaker is the ONLY thing determining bit assignment.

const UNIFORM_RUNS = [
  { card: 'random', label: 'random' },
  { card: 'mit',    label: 'mit'    },
];

for (const run of UNIFORM_RUNS) {
  test(`huffman tiebreak: ${run.label} (uniform weight=1)`, (t) => {
    const dict = loadDictJsonFixture(fixtureURL(run.card, import.meta.url));
    const byType = typesFromDict(dict);

    const KEYS = ['alpha-asc', 'len-asc-alpha', 'len-desc-alpha'];
    const totals = Object.fromEntries(KEYS.map(k => [k, 0]));
    let typesCounted = 0, wordsCounted = 0;

    for (const [, words] of byType) {
      if (words.length < 2) continue; // single-word types unaffected
      typesCounted++;
      wordsCounted += words.length;
      for (const k of KEYS) totals[k] += metricForType(words, k, null, null);
    }

    t.diagnostic(`types(>=2 words): ${typesCounted}, words: ${wordsCounted}`);
    for (const k of KEYS) {
      const delta = k === 'alpha-asc' ? '(baseline)' : `Δ vs alpha ${fmtPct(totals['alpha-asc'], totals[k])}`;
      t.diagnostic(`  ${k.padEnd(16)} Σ E[chars/emit] = ${totals[k].toFixed(4)}  ${delta}`);
    }

    // The metric must be finite and positive.
    for (const k of KEYS) assert.ok(totals[k] > 0 && Number.isFinite(totals[k]));
  });
}

// ---------- §11.4 long-tail floor regime ----------
//
// Apply norvig.freq.tsv.gz through combineFrequencies (the same path
// the BYOS freq picker uses) to get integer weights. After §11.4's
// `max(1, round(p × 1e9))`, words absent from norvig (and rare ones
// just above absent) all collapse to weight=1, which is exactly the
// regime §12 worries about: many same-weight ties whose resolution is
// up to the input ordering.

test('huffman tiebreak: random.dict with norvig §11.4 floor', (t) => {
  const dict = loadDictJsonFixture(fixtureURL('random', import.meta.url));
  const byType = typesFromDict(dict);
  const norvigSource = readFreqFixture(new URL('norvig.freq.sab.gz', FIXTURES));
  const weights = combineFrequencies([norvigSource]);
  // norvigSource.counts carries the ORIGINAL pre-floor counts. Use
  // this for freq-tiebreak ordering so weight=1 floor groups can still
  // be ordered by their (pre-floor) external frequency.
  const rawFreq = norvigSource.counts;

  const KEYS = ['alpha-asc', 'len-asc-alpha', 'len-desc-alpha', 'freq-asc-alpha', 'freq-desc-alpha'];
  const totals = Object.fromEntries(KEYS.map(k => [k, 0]));
  let typesCounted = 0, wordsCounted = 0, typesWithFloorTies = 0, floorWords = 0;

  for (const [, words] of byType) {
    if (words.length < 2) continue;
    typesCounted++;
    wordsCounted += words.length;

    // Per-type weight map limited to this type's vocabulary; absent
    // words fall through to weight=1 in metricForType.
    const wMap = new Map();
    let f1 = 0;
    for (const w of words) {
      const ww = weights.get(w) ?? 1;
      wMap.set(w, ww);
      if (ww === 1) f1++;
    }
    if (f1 >= 2) typesWithFloorTies++;
    floorWords += f1;

    for (const k of KEYS) totals[k] += metricForType(words, k, wMap, rawFreq);
  }

  t.diagnostic(`types(>=2 words): ${typesCounted}, words: ${wordsCounted}`);
  t.diagnostic(`words at floor weight=1: ${floorWords} (${(floorWords/wordsCounted*100).toFixed(1)}%)`);
  t.diagnostic(`types with >=2 floor-weight words (tie-break matters): ${typesWithFloorTies}`);
  for (const k of KEYS) {
    const delta = k === 'alpha-asc' ? '(baseline)' : `Δ vs alpha ${fmtPct(totals['alpha-asc'], totals[k])}`;
    t.diagnostic(`  ${k.padEnd(16)} Σ E[chars/emit] = ${totals[k].toFixed(4)}  ${delta}`);
  }

  for (const k of KEYS) assert.ok(totals[k] > 0 && Number.isFinite(totals[k]));
});

// ---------- per-type breakdown for the most pathological types ----------
//
// Surfaces the largest single-type wins / losses so the developer can
// eyeball whether the aggregate is dominated by a few outliers or
// spread evenly.

test('huffman tiebreak: random per-type top-10 deltas (uniform)', (t) => {
  const dict = loadDictJsonFixture(fixtureURL('random', import.meta.url));
  const byType = typesFromDict(dict);

  const rows = [];
  for (const [name, words] of byType) {
    if (words.length < 2) continue;
    const a = metricForType(words, 'alpha-asc', null, null);
    const dWorst = metricForType(words, 'len-asc-alpha', null, null) - a;
    const dBest  = metricForType(words, 'len-desc-alpha', null, null) - a;
    rows.push({ name, n: words.length, alpha: a, dWorst, dBest });
  }

  rows.sort((x, y) => x.dBest - y.dBest); // most-negative dBest first
  t.diagnostic(`top 10 types where len-desc-alpha helps most:`);
  for (const r of rows.slice(0, 10)) {
    t.diagnostic(`  ${r.name.padEnd(28)} n=${String(r.n).padStart(5)}  alpha=${r.alpha.toFixed(3)}  Δlen-desc=${r.dBest.toFixed(3)}  Δlen-asc=${r.dWorst.toFixed(3)}`);
  }

  rows.sort((x, y) => y.dWorst - x.dWorst); // most-positive dWorst first
  t.diagnostic(`top 10 types where len-asc-alpha hurts most:`);
  for (const r of rows.slice(0, 10)) {
    t.diagnostic(`  ${r.name.padEnd(28)} n=${String(r.n).padStart(5)}  alpha=${r.alpha.toFixed(3)}  Δlen-asc=${r.dWorst.toFixed(3)}  Δlen-desc=${r.dBest.toFixed(3)}`);
  }
});
