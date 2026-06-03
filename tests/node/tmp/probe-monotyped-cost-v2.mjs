// probe-monotyped-cost-v2.mjs: v2 cost breakdown for
// runMonotypedModelCheckPerCard. Mirrors the v1 probe layout so the
// developer can compare line-by-line. Two cases:
//   1. aesop-vs-aesop  (sequentialAlive stays long; exercises at())
//   2. aesop-vs-jfk    (sequentialAlive dies fast; membership-dominated)
//
// Inlines the v2 loop with performance.now() timers around each
// phase so we can see whether the cost is now in at(p), hasSorted,
// cmmAtOrdered, cmmHasSorted, or somewhere else.

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

const FORCE_DYNAMIC_SKIP_BUDGET = 256;

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

function runOne(label, suspectedSab, cardSab) {
  const suspectedView = wrapMonotypedModel(suspectedSab);
  const cardView = wrapMonotypedModel(cardSab);
  const totalSuspected = suspectedView.orderedCount;
  const orderedCount = cardView.orderedCount;

  let atCalls = 0, atTime = 0;
  let cmmAtCalls = 0, cmmAtTime = 0;
  let hasSortedCalls = 0, hasSortedTime = 0;
  let cmmHasSortedCalls = 0, cmmHasSortedTime = 0;

  const stats = {
    j: 0, matchDepth: 0, sequentialAlive: true,
    exactSeqMatches: 0, phraseSeqMatches: 0,
    rawHits: 0, anyVariantHits: 0, coveredHits: 0,
  };

  const wallStart = performance.now();

  for (let i = 0; i < totalSuspected; i++) {
    let t0 = performance.now();
    atCalls++;
    const cs = suspectedView.at(i);
    atTime += performance.now() - t0;

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
        t0 = performance.now();
        cmmAtCalls++;
        const csCmm = suspectedView.cmmAtOrdered(i);
        cmmAtTime += performance.now() - t0;
        for (let p = stats.j; p < limit; p++) {
          t0 = performance.now();
          cmmAtCalls++;
          const op = cardView.cmmAtOrdered(p);
          cmmAtTime += performance.now() - t0;
          if (op === csCmm) { found = p; foundViaVariant = true; break; }
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

    t0 = performance.now();
    cmmAtCalls++;
    const csCmm2 = suspectedView.cmmAtOrdered(i);
    cmmAtTime += performance.now() - t0;

    t0 = performance.now();
    cmmHasSortedCalls++;
    const cmmHit = cardView.cmmHasSorted(csCmm2);
    cmmHasSortedTime += performance.now() - t0;

    const coveredHit = rawHit || cmmHit;
    if (coveredHit) stats.coveredHits++;
    if (coveredHit && !rawHit) stats.anyVariantHits++;
  }

  const wall = performance.now() - wallStart;
  return {
    label, totalSuspected, orderedCount, wall,
    atCalls, atTime, cmmAtCalls, cmmAtTime,
    hasSortedCalls, hasSortedTime, cmmHasSortedCalls, cmmHasSortedTime,
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
  console.log(`  at() calls / time:          ${r.atCalls}  /  ${ms(r.atTime)}  (${pct(r.atTime, r.wall)} of wall)`);
  console.log(`  cmmAtOrdered() calls / time:${r.cmmAtCalls}  /  ${ms(r.cmmAtTime)}  (${pct(r.cmmAtTime, r.wall)} of wall)`);
  console.log(`  hasSorted() calls / time:   ${r.hasSortedCalls}  /  ${ms(r.hasSortedTime)}  (${pct(r.hasSortedTime, r.wall)} of wall)`);
  console.log(`  cmmHasSorted() calls / time:${r.cmmHasSortedCalls}  /  ${ms(r.cmmHasSortedTime)}  (${pct(r.cmmHasSortedTime, r.wall)} of wall)`);
  console.log(`  matchDepth:                 ${r.matchDepth}`);
  console.log(`  sequentialAlive at end:     ${r.sequentialAliveAtEnd}`);
  console.log(`  rawHits / anyVariantHits / coveredHits: ${r.rawHits} / ${r.anyVariantHits} / ${r.coveredHits}`);
}

async function main() {
  const aesopText = readGzText(join(FIXTURES, 'aesop.txt.gz'));
  const tGen0 = performance.now();
  const suspected = genMonotypedModel(aesopText);
  const tGen = performance.now() - tGen0;
  console.log(`genMonotypedModel(aesop) wall: ${ms(tGen)}`);
  console.log(`  suspected NTMM: ordered=${suspected.count}, MM unique=${suspected.uniqueCount}, CMM unique=${suspected.cmmUniqueCount}`);

  const cases = [
    ['aesop-vs-aesop  (matched)', 'aesop.monotyped-model.sab.gz'],
    ['aesop-vs-jfk    (mismatched)', 'jfk.monotyped-model.sab.gz'],
  ];
  for (const [label, fixtureName] of cases) {
    const cardSab = readSabArrayBuffer(join(FIXTURES, fixtureName));
    report(runOne(label, suspected.sab, cardSab));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
