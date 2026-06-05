#!/usr/bin/env node
// rewriter-ablation.mjs: stress sweep for the rewriter / aug
// interaction that produced the typos round-trip break (augs must run
// before the rewriter singletons are concatenated). Builds the session artifacts for a
// fixed "user-shape" byos, then encodes a small secret across the
// 13-row ablation matrix from probe-bisect3, asserting each row's
// expected outcome.
//
// Twelve rows are end-to-end round-trip cases that MUST succeed once
// `js/src/worker/build-session-worker.js` runs the augs before the
// transform-singleton injection. One row ("mismatched: build-clean,
// encode-all") deliberately misconfigures the encoder against a dict
// that's missing the rewriter singletons; that row MUST fail
// (otherwise the misconfig-detection has regressed too).
//
// Usage:
//   node tests/node/stress/rewriter-ablation.mjs
//   node tests/node/stress/rewriter-ablation.mjs --seeds=10
//
// Exits non-zero on any unexpected outcome. Forensics on a failed
// case go to stderr (seed + error). Slow: each row builds a dict +
// model from the walden corpus and encodes N seeds; expect minutes
// on a laptop.

import { buildSessionArtifacts } from '../../../js/src/builder/session.js';
import { encodeJob } from '../../../js/src/worker/jobs.js';

const SECRET = 'meet me by the swings';

const ALL_BYOS = {
  story: { style: 'walden', sentence: 'random', vocabulary: 'base' },
  base: {
    sources: [
      'impf2p', 'impkimmo', 'mit', 'num-form-preserved',
      'rhyme', 'claude2026',
      'emoji16', 'emoji16-curated-keywords',
    ],
    frequencies: ['style'],
    tieBreak: 'prefer-shorter',
    augment: {
      emojiIntoWords: { enabled: true, intensity: 3 },
      wordsIntoEmoji: { enabled: true, intensity: 3 },
    },
  },
  rewriter: {
    typos: { enabled: true, intensity: 100, mode: 'forward' },
    voice: { enabled: true, intensity: 100, mode: 'pirate' },
    xanax: { enabled: true, intensity: 100 },
  },
  reformatter: {
    voice: { enabled: true, intensity: 8, mode: 'surfer' },
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

const builtCache = new Map();
async function getBuild(byos) {
  const key = JSON.stringify(byos);
  if (builtCache.has(key)) return builtCache.get(key);
  const b = await buildSessionArtifacts({
    selections: new Set(byos.base.sources),
    selectionLabels: Object.fromEntries(byos.base.sources.map(k => [k, k])),
    storyStyle: byos.story.style,
    sentenceMode: byos.story.sentence,
    useCorpus: byos.story.vocabulary === 'corpus',
    storyLabel: byos.story.style,
    customCorpusText: null, customCorpusName: null,
    customTwlistEntries: null, customTwlistName: null, customTwlistHash: null,
    freqSelections: byos.base.frequencies,
    tieBreak: 'prefer-shorter',
    emojiIntoWords: byos.base.augment?.emojiIntoWords,
    wordsIntoEmoji: byos.base.augment?.wordsIntoEmoji,
    rewriter: byos.rewriter,
    reformatter: byos.reformatter,
  });
  builtCache.set(key, b);
  return b;
}

async function trySeeds(byos, encRewriter, encReformatter, seeds) {
  const built = await getBuild(byos);
  let ok = 0, fail = 0;
  const failures = [];
  for (const s of seeds) {
    const input = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(SECRET)); c.close(); } });
    try {
      const out = await encodeJob({
        input,
        dictPath: built.dictPath,
        modelPath: built.modelPath,
        mode: built.mode || 'random',
        randomSeed: s, streamSeed: s,
        rewriter: encRewriter,
        reformatter: encReformatter,
      });
      const reader = out.getReader();
      while (true) { const { done } = await reader.read(); if (done) break; }
      ok++;
    } catch (e) {
      fail++;
      failures.push({ seed: s, error: e?.message || String(e) });
    }
  }
  return { ok, fail, failures };
}

// Parse flags.
const seedsFlag = process.argv.find(a => a.startsWith('--seeds='));
const SEED_COUNT = seedsFlag ? Math.max(1, parseInt(seedsFlag.split('=')[1], 10)) : 5;
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);

const noXanax = { ...ALL_BYOS.rewriter }; delete noXanax.xanax;
const noTypos = { ...ALL_BYOS.rewriter }; delete noTypos.typos;
const noVoice = { ...ALL_BYOS.rewriter }; delete noVoice.voice;

const CASES = [
  // expectAllOk=true rows: must round-trip on every seed.
  { label: 'all (baseline)',                  rw: ALL_BYOS.rewriter, rf: ALL_BYOS.reformatter, expectAllOk: true },
  { label: 'no xanax',                        rw: noXanax,           rf: ALL_BYOS.reformatter, expectAllOk: true },
  { label: 'no typos',                        rw: noTypos,           rf: ALL_BYOS.reformatter, expectAllOk: true },
  { label: 'no rewriter.voice',               rw: noVoice,           rf: ALL_BYOS.reformatter, expectAllOk: true },
  { label: 'no reformatter.voice',            rw: ALL_BYOS.rewriter, rf: {},                   expectAllOk: true },
  { label: 'only xanax',                      rw: { xanax: ALL_BYOS.rewriter.xanax }, rf: {},  expectAllOk: true },
  { label: 'only typos',                      rw: { typos: ALL_BYOS.rewriter.typos }, rf: {},  expectAllOk: true },
  { label: 'only rewriter.voice',             rw: { voice: ALL_BYOS.rewriter.voice }, rf: {},  expectAllOk: true },
  { label: 'only reformatter.voice',          rw: {},                                 rf: ALL_BYOS.reformatter, expectAllOk: true },
  { label: 'xanax + typos',                   rw: { xanax: ALL_BYOS.rewriter.xanax, typos: ALL_BYOS.rewriter.typos }, rf: {}, expectAllOk: true },
  { label: 'xanax + rewriter.voice',          rw: { xanax: ALL_BYOS.rewriter.xanax, voice: ALL_BYOS.rewriter.voice }, rf: {}, expectAllOk: true },
  { label: 'typos + rewriter.voice',          rw: { typos: ALL_BYOS.rewriter.typos, voice: ALL_BYOS.rewriter.voice }, rf: {}, expectAllOk: true },
  { label: 'all rewriters, no reformatter',   rw: ALL_BYOS.rewriter, rf: {},                   expectAllOk: true },
];

// One intentional misconfig: build with no rewriter so the dict
// doesn't carry the singletons, then encode WITH the rewriter chain.
// The decoder won't find the typo'd variant words in the dict; this
// MUST fail. Promote the dual-purpose row from probe-bisect3.
const MISCONFIG_BYOS = clone(ALL_BYOS); delete MISCONFIG_BYOS.rewriter; delete MISCONFIG_BYOS.reformatter;
CASES.push({
  label: 'misconfig: build-clean / encode-with-transforms (must fail)',
  byos: MISCONFIG_BYOS,
  rw: ALL_BYOS.rewriter,
  rf: ALL_BYOS.reformatter,
  expectAllOk: false,
});

let unexpected = 0;
for (const c of CASES) {
  const byos = c.byos || ALL_BYOS;
  const r = await trySeeds(byos, c.rw, c.rf, SEEDS);
  const got = r.fail === 0 ? 'all-ok' : (r.ok === 0 ? 'all-fail' : 'mixed');
  const wanted = c.expectAllOk ? 'all-ok' : 'all-fail';
  const passed = (c.expectAllOk && r.fail === 0) || (!c.expectAllOk && r.ok === 0);
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${c.label.padEnd(58)} ok=${r.ok}/${r.ok + r.fail}  got=${got}  wanted=${wanted}`);
  if (!passed) {
    unexpected++;
    for (const f of r.failures.slice(0, 3)) {
      console.error(`    seed=${f.seed}: ${f.error.slice(0, 140)}`);
    }
  }
}

if (unexpected > 0) {
  console.error(`\n${unexpected} unexpected case(s); see PASS/FAIL above.`);
  process.exit(1);
} else {
  console.log(`\nall ${CASES.length} cases produced expected outcomes`);
}
