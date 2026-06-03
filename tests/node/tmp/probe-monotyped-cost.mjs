// probe-monotyped-cost.mjs: break down where
// runMonotypedModelCheckPerCard spends its time. Inlines the loop
// from js/src/eve/monotyped-model-check.js with performance.now()
// timers around each phase so we can see whether the cost is in
// at(p) decode, hasSorted binary search, or collapseVariants
// enumeration. The actual function in the engine is left untouched
// per feedback_eve_separate_from_core.
//
// Two cases by default:
//   1. aesop-suspected vs aesop card  (sequentialAlive stays long;
//                                      heavy at(p) work)
//   2. aesop-suspected vs jfk card    (sequentialAlive dies fast;
//                                      membership-dominated)
//
// Reports per case:
//   - genMonotypedModel(suspected) wall
//   - runner wall
//   - at() call count + cumulative time + per-call avg
//   - hasSorted() call count + cumulative time + per-call avg
//   - collapseVariants() cumulative time + total variants yielded
//   - sequentialAlive end state + matchDepth
//
// Run from repo root:
//   node tests/node/tmp/probe-monotyped-cost.mjs
//
// Rules of engagement:
//   - Eve siblings only; no edit to engine modules.
//   - Path resolution uses import.meta.url, never absolute paths.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { genMonotypedModel } from '../../../js/src/eve/monotyped-model-check.js';
import { wrapMonotypedModel } from '../../../js/src/eve/monotyped-model-sab.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures');

const MONO_TYPE = 'g';
const FORCE_DYNAMIC_SKIP_BUDGET = 256;
const MAX_COLLAPSE_RUNS = 6;

function readGzBuffer(path) {
  return gunzipSync(readFileSync(path));
}
function readSabArrayBuffer(path) {
  const buf = readGzBuffer(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function readGzText(path) {
  return readGzBuffer(path).toString('utf8');
}

// Mirrors collapseVariants in monotyped-model-check.js but as an
// array-returning function so we can time it separately.
function collapseVariantsArr(shape, maxRuns) {
  const parts = shape.split('|');
  const runs = [];
  let runStart = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === MONO_TYPE) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      runs.push({ start: runStart, length: i - runStart });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, length: parts.length - runStart });
  if (runs.length === 0 || runs.length > maxRuns) return [];
  const choiceCounts = runs.map(r => r.length);
  const total = choiceCounts.reduce((a, b) => a * b, 1);
  const out = [];
  for (let n = 0; n < total - 1; n++) {
    const variant = parts.slice();
    let q = n;
    for (let r = runs.length - 1; r >= 0; r--) {
      const choice = (q % choiceCounts[r]) + 1;
      q = Math.floor(q / choiceCounts[r]);
      const run = runs[r];
      const replacement = Array(choice).fill(MONO_TYPE);
      variant.splice(run.start, run.length, ...replacement);
    }
    out.push(variant.join('|'));
  }
  return out;
}

function runOne(label, suspectedSab, cardSab) {
  const suspectedView = wrapMonotypedModel(suspectedSab);
  const cardView = wrapMonotypedModel(cardSab);
  const totalSuspected = suspectedView.orderedCount;
  const orderedCount = cardView.orderedCount;

  let atCalls = 0;
  let atTime = 0;
  let hasSortedCalls = 0;
  let hasSortedTime = 0;
  let variantTime = 0;
  let variantsTotal = 0;

  const stats = {
    name: label,
    j: 0,
    matchDepth: 0,
    sequentialAlive: true,
    exactSeqMatches: 0,
    phraseSeqMatches: 0,
    rawHits: 0,
    anyVariantHits: 0,
    coveredHits: 0,
  };

  const wallStart = performance.now();

  for (let i = 0; i < totalSuspected; i++) {
    let t0 = performance.now();
    atCalls++;
    const cs = suspectedView.at(i);
    atTime += performance.now() - t0;

    t0 = performance.now();
    const variants = collapseVariantsArr(cs, MAX_COLLAPSE_RUNS);
    variantTime += performance.now() - t0;
    variantsTotal += variants.length;

    if (stats.sequentialAlive) {
      let found = -1;
      let foundViaVariant = false;
      const limit = Math.min(stats.j + FORCE_DYNAMIC_SKIP_BUDGET + 1, orderedCount);
      for (let p = stats.j; p < limit; p++) {
        t0 = performance.now();
        atCalls++;
        const op = cardView.at(p);
        atTime += performance.now() - t0;
        if (op === cs) { found = p; break; }
      }
      if (found === -1) {
        for (let p = stats.j; p < limit; p++) {
          t0 = performance.now();
          atCalls++;
          const op = cardView.at(p);
          atTime += performance.now() - t0;
          for (const v of variants) {
            if (op === v) { found = p; foundViaVariant = true; break; }
          }
          if (found !== -1) break;
        }
      }
      if (found !== -1) {
        if (foundViaVariant) stats.phraseSeqMatches++;
        else stats.exactSeqMatches++;
        stats.j = found + 1;
        stats.matchDepth = stats.exactSeqMatches + stats.phraseSeqMatches;
      } else {
        stats.sequentialAlive = false;
      }
    }

    t0 = performance.now();
    hasSortedCalls++;
    const rawHit = cardView.hasSorted(cs);
    hasSortedTime += performance.now() - t0;
    if (rawHit) stats.rawHits++;

    let anyVariantHit = false;
    for (const v of variants) {
      t0 = performance.now();
      hasSortedCalls++;
      const ok = cardView.hasSorted(v);
      hasSortedTime += performance.now() - t0;
      if (ok) { anyVariantHit = true; break; }
    }
    if (anyVariantHit) stats.anyVariantHits++;
    if (rawHit || anyVariantHit) stats.coveredHits++;
  }

  const wall = performance.now() - wallStart;
  return {
    label,
    totalSuspected,
    orderedCount,
    wall,
    atCalls,
    atTime,
    hasSortedCalls,
    hasSortedTime,
    variantTime,
    variantsTotal,
    matchDepth: stats.matchDepth,
    sequentialAliveAtEnd: stats.sequentialAlive,
    rawHits: stats.rawHits,
    anyVariantHits: stats.anyVariantHits,
    coveredHits: stats.coveredHits,
  };
}

function fmt(n, p = 2) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(p);
}
function ms(n) { return `${fmt(n)} ms`; }
function pct(part, whole) {
  if (whole <= 0) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function report(r) {
  console.log(`\n=== ${r.label} ===`);
  console.log(`  suspected sentences:        ${r.totalSuspected}`);
  console.log(`  card ordered sentences:     ${r.orderedCount}`);
  console.log(`  wall:                       ${ms(r.wall)}`);
  console.log(`  at() calls:                 ${r.atCalls}`);
  console.log(`    cumulative time:          ${ms(r.atTime)}  (${pct(r.atTime, r.wall)} of wall)`);
  console.log(`    per call avg:             ${fmt(r.atTime / Math.max(1, r.atCalls), 4)} ms`);
  console.log(`  hasSorted() calls:          ${r.hasSortedCalls}`);
  console.log(`    cumulative time:          ${ms(r.hasSortedTime)}  (${pct(r.hasSortedTime, r.wall)} of wall)`);
  console.log(`    per call avg:             ${fmt(r.hasSortedTime / Math.max(1, r.hasSortedCalls), 4)} ms`);
  console.log(`  collapseVariants():`);
  console.log(`    cumulative time:          ${ms(r.variantTime)}  (${pct(r.variantTime, r.wall)} of wall)`);
  console.log(`    variants yielded total:   ${r.variantsTotal}`);
  console.log(`    variants per sentence:    ${fmt(r.variantsTotal / Math.max(1, r.totalSuspected), 2)}`);
  console.log(`  matchDepth:                 ${r.matchDepth}`);
  console.log(`  sequentialAlive at end:     ${r.sequentialAliveAtEnd}`);
  console.log(`  rawHits / anyVariantHits / coveredHits: ${r.rawHits} / ${r.anyVariantHits} / ${r.coveredHits}`);
}

async function main() {
  // Build suspected NTMM SAB from aesop corpus (a real natural-language
  // text). For the dev's actual scenario the suspected was a 10MB
  // encoder output from verycryp random; a real corpus is a close
  // enough stand-in for the cost-breakdown question. Scale to a true
  // 87K-sentence suspected by multiplying N proportionally.
  const aesopText = readGzText(join(FIXTURES, 'aesop.txt.gz'));
  const tGen0 = performance.now();
  const suspected = genMonotypedModel(aesopText);
  const tGen = performance.now() - tGen0;
  console.log(`genMonotypedModel(aesop) wall: ${ms(tGen)}`);
  console.log(`  suspected NTMM: ordered=${suspected.count}, unique=${suspected.uniqueCount}`);

  const cardCases = [
    ['aesop-vs-aesop  (matched)', 'aesop.monotyped-model.sab.gz'],
    ['aesop-vs-jfk    (mismatched)', 'jfk.monotyped-model.sab.gz'],
  ];
  for (const [label, fixtureName] of cardCases) {
    const cardSab = readSabArrayBuffer(join(FIXTURES, fixtureName));
    const r = runOne(label, suspected.sab, cardSab);
    report(r);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
