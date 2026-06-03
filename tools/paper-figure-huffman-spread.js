// Renders the §1 paper figure: per-type Huffman code-length spread,
// master.dict (uniform-weight) vs an aesop-style corpus-weighted dict.
//
// Walks the byWord index of each dict, groups (bits) by typeIndex,
// computes (max-min) within each type, then prints a small text
// summary plus an inline SVG suitable for pasting into
// whats-new.html. Static analysis, no encode/decode round-trips.
//
// Usage:  node tools/paper-figure-huffman-spread.js
//         > tmp/huffman-spread.svg
//
// Browser-safe deps would be nice but this is a Node-only build tool.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { wrapDictionaryFromSAB } from '../js/src/dictionary.js';
import { loadSABfromFile } from '../js/src/sab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures');

const BYWORD_ENTRY_SIZE = 16; // mirrors js/src/builder/sab-pack.js

async function loadDict(name) {
  // The shipped dict form is the SAB binary (post sab-fixtures arc).
  // Load via the SAB helper + wrap; no JSON.parse on this path.
  const sab = await loadSABfromFile(resolve(FIXTURE_DIR, name));
  return wrapDictionaryFromSAB(sab);
}

// For each typeIndex, the min and max bit-length across its words.
// spread = max - min. Returns { spreadCounts: Map<int,int>,
// totalTypes, multiWordTypes }.
function analyzeSpread(dict) {
  const { wordCount, typeCount, byWordOffset } = dict.header;
  const view = dict.view;
  const minBits = new Int32Array(typeCount + 1);
  const maxBits = new Int32Array(typeCount + 1);
  const wordsPerType = new Int32Array(typeCount + 1);
  for (let i = 1; i <= typeCount; i++) { minBits[i] = Infinity; maxBits[i] = -1; }
  for (let i = 0; i < wordCount; i++) {
    const off = byWordOffset + i * BYWORD_ENTRY_SIZE;
    const bits = view.getUint16(off + 6, true);
    const typeIdx = view.getUint32(off + 8, true);
    if (bits < minBits[typeIdx]) minBits[typeIdx] = bits;
    if (bits > maxBits[typeIdx]) maxBits[typeIdx] = bits;
    wordsPerType[typeIdx]++;
  }
  const spreadCounts = new Map();
  let multiWordTypes = 0;
  for (let t = 1; t <= typeCount; t++) {
    if (wordsPerType[t] < 2) continue; // single-word types have spread 0 by construction; skip from the histogram
    multiWordTypes++;
    const spread = maxBits[t] - minBits[t];
    spreadCounts.set(spread, (spreadCounts.get(spread) || 0) + 1);
  }
  return { spreadCounts, totalTypes: typeCount, multiWordTypes, wordCount };
}

const MASTER = await loadDict('master-1.dict.sab.gz');
const AESOP  = await loadDict('aesop-1.dict.sab.gz');

const m = analyzeSpread(MASTER);
const a = analyzeSpread(AESOP);

function printSummary(label, x) {
  process.stderr.write(`\n${label}\n`);
  process.stderr.write(`  total types:       ${x.totalTypes.toLocaleString('en-US')}\n`);
  process.stderr.write(`  multi-word types:  ${x.multiWordTypes.toLocaleString('en-US')}\n`);
  process.stderr.write(`  word count:        ${x.wordCount.toLocaleString('en-US')}\n`);
  const sorted = [...x.spreadCounts.entries()].sort((a, b) => a[0] - b[0]);
  process.stderr.write(`  spread → count\n`);
  for (const [s, c] of sorted) {
    process.stderr.write(`    ${String(s).padStart(2)}: ${c.toLocaleString('en-US').padStart(8)}\n`);
  }
}
printSummary('master-1.dict.sab.gz (uniform-weight Huffman):', m);
printSummary('aesop-1.dict.sab.gz (corpus-weighted Huffman):', a);

// Render SVG: two side-by-side histograms sharing an x-axis.
// Spread bins 0..maxSpread (inclusive). Y axis is log10(count + 1)
// because the master histogram is massively dominated by spread<=1.
const allSpreads = new Set();
for (const s of m.spreadCounts.keys()) allSpreads.add(s);
for (const s of a.spreadCounts.keys()) allSpreads.add(s);
const maxSpread = Math.max(...allSpreads);
const bins = [];
for (let s = 0; s <= maxSpread; s++) bins.push(s);

function logScale(n) { return Math.log10(n + 1); }
let maxLog = 0;
for (const c of m.spreadCounts.values()) maxLog = Math.max(maxLog, logScale(c));
for (const c of a.spreadCounts.values()) maxLog = Math.max(maxLog, logScale(c));

// Layout
const PANEL_W = 320;
const PANEL_H = 200;
const PAD_L = 44;
const PAD_R = 14;
const PAD_T = 24;
const PAD_B = 38;
const GAP = 28;
const PLOT_W = PANEL_W - PAD_L - PAD_R;
const PLOT_H = PANEL_H - PAD_T - PAD_B;
const BAR_W = PLOT_W / bins.length;
const SVG_W = PANEL_W * 2 + GAP;
const SVG_H = PANEL_H;

function bar(panelOffsetX, count, binIdx, color) {
  const v = logScale(count);
  const h = (v / maxLog) * PLOT_H;
  const x = panelOffsetX + PAD_L + binIdx * BAR_W + 1;
  const y = PAD_T + (PLOT_H - h);
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(BAR_W - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`;
}

function panel(panelOffsetX, label, counts, color) {
  const out = [];
  // Frame
  out.push(`<rect x="${panelOffsetX + PAD_L}" y="${PAD_T}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="currentColor" stroke-opacity="0.25"/>`);
  // Bars
  for (const s of bins) {
    const c = counts.get(s) || 0;
    if (c > 0) out.push(bar(panelOffsetX, c, s, color));
  }
  // X axis ticks (every bin)
  for (let s = 0; s <= maxSpread; s++) {
    const x = panelOffsetX + PAD_L + s * BAR_W + BAR_W / 2;
    const y = PAD_T + PLOT_H;
    out.push(`<text x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.7">${s}</text>`);
  }
  out.push(`<text x="${(panelOffsetX + PAD_L + PLOT_W / 2).toFixed(1)}" y="${(PAD_T + PLOT_H + 30).toFixed(1)}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.7">code-length spread within type (bits)</text>`);
  // Y axis log-decade ticks
  const decades = Math.ceil(maxLog);
  for (let d = 0; d <= decades; d++) {
    const v = d;
    const y = PAD_T + PLOT_H - (v / maxLog) * PLOT_H;
    out.push(`<line x1="${panelOffsetX + PAD_L - 3}" y1="${y.toFixed(1)}" x2="${panelOffsetX + PAD_L}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.4"/>`);
    out.push(`<text x="${(panelOffsetX + PAD_L - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="currentColor" opacity="0.7">10${d === 0 ? '⁰' : (d === 1 ? '¹' : (d === 2 ? '²' : (d === 3 ? '³' : (d === 4 ? '⁴' : (d === 5 ? '⁵' : '^' + d)))))}</text>`);
  }
  // Panel title
  out.push(`<text x="${(panelOffsetX + PAD_L + PLOT_W / 2).toFixed(1)}" y="${(PAD_T - 8).toFixed(1)}" font-size="11" font-weight="600" text-anchor="middle" fill="currentColor">${label}</text>`);
  return out.join('\n');
}

const ACCENT_M = '#888888'; // muted for the uniform-master histogram
const ACCENT_A = 'var(--accent, #2b6cb0)'; // accent for the corpus-weighted aesop

const svg = `<svg class="paper-figure" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="Per-type Huffman code-length spread: master (uniform) vs aesop (corpus-weighted). Log y-axis.">
${panel(0, 'master (uniform Huffman)', m.spreadCounts, ACCENT_M)}
${panel(PANEL_W + GAP, 'aesop (corpus-weighted Huffman)', a.spreadCounts, ACCENT_A)}
<text x="${(PAD_L - 36).toFixed(1)}" y="${(PAD_T + PLOT_H / 2).toFixed(1)}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.7" transform="rotate(-90 ${(PAD_L - 36).toFixed(1)} ${(PAD_T + PLOT_H / 2).toFixed(1)})">multi-word types</text>
</svg>`;

process.stdout.write(svg + '\n');
