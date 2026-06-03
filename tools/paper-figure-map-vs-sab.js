// Renders the §7 paper figure: a small comparison table of two
// dictionary representations on the same master.dict payload, a
// plain JS Map<word, {typeIndex, code, bits}> vs the SAB-backed
// binary-tree encoding that ships in the engine. Reports startup
// time, memory footprint, and lookup throughput for each.
//
// Output is an inline HTML <table> on stdout, suitable for pasting
// into whats-new.html §7 (alongside the §1 SVG figure pattern).
// A short text summary lands on stderr.
//
// Usage:  node --expose-gc tools/paper-figure-map-vs-sab.js
//         > tmp/map-vs-sab.html
//
// Memory measurement requires --expose-gc so heap deltas reflect
// real retained bytes after each build, not transient parse churn.
// The script exits non-zero with a clear message if --expose-gc is
// missing.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadDictionary } from '../js/src/dictionary.js';
import { loadSABfromFile } from '../js/src/sab.js';
import { unpackDictFromSAB } from '../js/src/builder/sab-pack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures');

if (typeof global.gc !== 'function') {
  process.stderr.write(
    'error: run with --expose-gc so heap measurements are deterministic.\n' +
    '       node --expose-gc tools/paper-figure-map-vs-sab.js > tmp/map-vs-sab.html\n'
  );
  process.exit(1);
}

const DICT_NAME = 'master-1.dict.sab.gz';
const LOOKUP_SAMPLE = 50_000;

// Read the shipped dict SAB and unpack to the JSON shape this script
// measures against. The Map vs SAB comparison times Map-build from
// JSON vs SAB-pack from JSON; the upstream materialization of `json`
// is a fixed cost in both branches, so substituting an SAB-unpack
// for the old JSON.parse leaves the comparison's invariants intact.
async function readJson(name) {
  const sab = await loadSABfromFile(resolve(FIXTURE_DIR, name));
  return unpackDictFromSAB(sab);
}

function settleHeap() {
  // Two passes catch a Mark-Sweep that follows a fresh Scavenge.
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

function buildMap(json) {
  // One entry per word; the runtime engine consumes exactly the same
  // {typeIndex, code, bits} triple via dictionary.js / lookupWord, so
  // the Map alternative gives byte-equivalent semantics with a hash-
  // table lookup path instead of the SAB binary search.
  const m = new Map();
  for (const w of json.words) {
    m.set(w.word, { typeIndex: w.typeIndex, code: w.code, bits: w.bits });
  }
  return m;
}

function pickSampleWords(json, n) {
  // Deterministic LCG so reruns produce identical timings, important
  // for paper numbers. Random index into json.words, fall back to
  // cycling if we run short.
  const out = new Array(n);
  let state = 1664525;
  for (let i = 0; i < n; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out[i] = json.words[state % json.words.length].word;
  }
  return out;
}

function timeMs(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms) {
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  if (ms < 100) return `${ms.toFixed(2)} ms`;
  return `${ms.toFixed(1)} ms`;
}

// ---- measurement ----
process.stderr.write(`Loading ${DICT_NAME}...\n`);
const json = await readJson(DICT_NAME);
const sampleWords = pickSampleWords(json, LOOKUP_SAMPLE);
process.stderr.write(
  `${json.words.length.toLocaleString()} words, ` +
  `${json.types.length.toLocaleString()} types. Sample size: ` +
  `${LOOKUP_SAMPLE.toLocaleString()} lookups.\n`,
);

// SAB: time loadDictionary (pack + wrap), measure sab.byteLength.
let dict;
const beforeSab = settleHeap();
const sabStartup = timeMs(() => { dict = loadDictionary(json); });
const afterSab = settleHeap();
const sabBytes = dict.sab.byteLength;
const sabHeapDelta = afterSab - beforeSab;
process.stderr.write(
  `SAB:  startup ${formatMs(sabStartup)}, ` +
  `sab.byteLength ${formatBytes(sabBytes)}, ` +
  `heap delta ${formatBytes(sabHeapDelta)}.\n`,
);

// Map: time buildMap, measure heap delta.
let map;
const beforeMap = settleHeap();
const mapStartup = timeMs(() => { map = buildMap(json); });
const afterMap = settleHeap();
const mapHeapDelta = afterMap - beforeMap;
process.stderr.write(
  `Map:  startup ${formatMs(mapStartup)}, ` +
  `heap delta ${formatBytes(mapHeapDelta)}.\n`,
);

// Lookup: walk the sample words through each representation. Warm
// the JIT with a small prefix pass before timing.
function warmup(n) {
  for (let i = 0; i < n; i++) {
    map.get(sampleWords[i]);
  }
}
warmup(1000);

// Re-import lookupWord lazily so the SAB walk gets a fresh JIT pass.
const { lookupWord } = await import('../js/src/dictionary.js');

let mapSink = 0;
const mapLookupMs = timeMs(() => {
  for (let i = 0; i < sampleWords.length; i++) {
    const r = map.get(sampleWords[i]);
    if (r) mapSink ^= r.typeIndex;
  }
});

let sabSink = 0;
const sabLookupMs = timeMs(() => {
  for (let i = 0; i < sampleWords.length; i++) {
    const r = lookupWord(dict, sampleWords[i]);
    if (r) sabSink ^= r.typeIndex;
  }
});

// Sink to suppress dead-code elimination concerns.
if (mapSink === -1 && sabSink === -1) process.stderr.write('(unreachable)\n');

const mapPerOp = (mapLookupMs * 1000) / sampleWords.length;
const sabPerOp = (sabLookupMs * 1000) / sampleWords.length;
process.stderr.write(
  `Lookup: Map ${formatMs(mapLookupMs)} (${mapPerOp.toFixed(3)} µs/op), ` +
  `SAB ${formatMs(sabLookupMs)} (${sabPerOp.toFixed(3)} µs/op).\n`,
);

// ---- render: inline HTML table for pasting into whats-new.html ----
function row(metric, mapCol, sabCol, note) {
  return `            <tr><th scope="row">${metric}</th><td>${mapCol}</td><td>${sabCol}</td>${note ? `<td class="paper-table-note">${note}</td>` : '<td></td>'}</tr>`;
}

const html = [
  '        <figure class="paper-figure-wrap">',
  '          <table class="paper-table">',
  '            <caption><strong>Table 1.</strong> Master dict (' +
    `${json.words.length.toLocaleString()} words, ` +
    `${json.types.length.toLocaleString()} types) ` +
    'as a JS <code>Map</code> vs. the SAB-backed binary tree the ' +
    'engine ships. Measured with ' +
    `<code>tools/paper-figure-map-vs-sab.js</code>, ${LOOKUP_SAMPLE.toLocaleString()} ` +
    'lookups, Node ' + process.version + '.</caption>',
  '            <thead>',
  '              <tr><th scope="col">Metric</th><th scope="col">JS Map</th><th scope="col">SAB-BST</th><th scope="col">Notes</th></tr>',
  '            </thead>',
  '            <tbody>',
  row(
    'Startup (parse / build)',
    formatMs(mapStartup),
    formatMs(sabStartup),
    'SAB includes pack + wrap; Map iterates json.words.',
  ),
  row(
    'Memory (retained heap delta)',
    formatBytes(mapHeapDelta),
    formatBytes(sabBytes) + ' SAB',
    'Map: V8 heap. SAB: the buffer itself (shareable across workers).',
  ),
  row(
    'Lookup throughput',
    `${formatMs(mapLookupMs)} (${mapPerOp.toFixed(3)} µs/op)`,
    `${formatMs(sabLookupMs)} (${sabPerOp.toFixed(3)} µs/op)`,
    `${LOOKUP_SAMPLE.toLocaleString()} random words.`,
  ),
  '            </tbody>',
  '          </table>',
  '          <figcaption>',
  '            <strong>Figure 7.</strong> Two ways to hold the same',
  '            data, two different trade-offs: the Map is faster to look',
  '            up but lives on the V8 heap and must be rebuilt in every',
  '            worker; the SAB version is one shareable buffer the parent',
  '            packs once and every worker wraps with zero parse cost.',
  '          </figcaption>',
  '        </figure>',
].join('\n');

process.stdout.write(html + '\n');
