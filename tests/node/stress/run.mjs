#!/usr/bin/env node
// Node CLI for the NiceText stress engine. Continuous sweeps of
// encode/decode round-trips against one of three corpus shapes:
//
//   --corpus-file=PATH      : load any file as the corpus (real
//                             .deb / ELF / etc., reproduces real
//                             BYOD failures).
//   --corpus-mode=snip      : DEFAULT. Synthesize from random byte
//                             ranges of /fixtures/ files (raw .gz
//                             AND inflated). Self-contained,
//                             deterministic, gives a realistic
//                             mix of binary noise + real English
//                             prose + dict JSON + tsv twlist.
//   --corpus-mode=random    : Pure mulberry32 random bytes. Fast,
//                             but the resulting model has too few
//                             bit-bearing sentence shapes to
//                             encode anything, useful for stressing
//                             the "thin model" failure mode only.
//
// Forensics on any failure dumped to
// tmp/stress-failure-<timestamp>-<size>-<rep>/.
//
// Usage:
//   node tests/node/stress/run.mjs
//   node tests/node/stress/run.mjs --max-size=65536 --reps=3
//   node tests/node/stress/run.mjs --corpus-file=/path/to/file.deb
//   node tests/node/stress/run.mjs --corpus-mode=random --corpus-bytes=4194304
//   node tests/node/stress/run.mjs --sweeps=1            # run one full ladder pass
//   node tests/node/stress/run.mjs --duration=10m        # cap wall-clock to 10 minutes
//   node tests/node/stress/run.mjs --duration=90s
// --sweeps and --duration combine, whichever bound trips first wins.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { mulberry32 } from '../../../js/src/random.js';
import { loadResource } from '../../../js/src/resource-loader.js';
import {
  runStress,
  DEFAULT_SIZES,
  DEFAULT_REPS,
  DEFAULT_SOURCES,
  snipCorpusFromFixtures,
} from './stress-engine.js';
import { loadStressAssets } from './load-assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
const TMP_DIR = join(REPO_ROOT, 'tmp');

const DEFAULT_CORPUS_BYTES = 1 * 1024 * 1024; // 1 MB

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

// `5m`, `90s`, `2h`, or a bare integer (ms). Returns Infinity for
// missing/blank input so the engine's default (run forever) wins.
function parseDuration(spec) {
  if (spec === undefined || spec === null || spec === '') return Infinity;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(spec).trim());
  if (!m) throw new Error(`stress: bad --duration value '${spec}' (expected e.g. 5m, 90s, 2h, 30000ms)`);
  const n = parseFloat(m[1]);
  switch (m[2] || 'ms') {
    case 'ms': return n;
    case 's':  return n * 1000;
    case 'm':  return n * 60 * 1000;
    case 'h':  return n * 60 * 60 * 1000;
  }
  return Infinity;
}

function loadConfig() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = {
    sizes: DEFAULT_SIZES.slice(),
    reps: a.reps ? Math.max(1, parseInt(a.reps, 10)) : DEFAULT_REPS,
    corpusBytes: a['corpus-bytes']
      ? Math.max(1024, parseInt(a['corpus-bytes'], 10))
      : DEFAULT_CORPUS_BYTES,
    corpusSeed: a['corpus-seed']
      ? parseInt(a['corpus-seed'], 10) >>> 0
      : 0xC0FFEE,
    rngSeed: a['rng-seed']
      ? parseInt(a['rng-seed'], 10) >>> 0
      : (Date.now() >>> 0),
    corpusMode: a['corpus-mode'] || 'snip',
    corpusFile: a['corpus-file'] || null,
    emojiFlood: a['emoji-flood'] === 'true' || a['emoji-flood'] === '1',
    restrict: !(a['no-restrict'] === 'true' || a['no-restrict'] === '1'),
    maxSweeps: a.sweeps ? Math.max(1, parseInt(a.sweeps, 10)) : Infinity,
    maxDurationMs: parseDuration(a.duration),
  };
  if (a['max-size']) {
    const cap = parseInt(a['max-size'], 10);
    cfg.sizes = cfg.sizes.filter(s => s <= cap);
  }
  return cfg;
}

function formatSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---- Corpus producers ----

function corpusFromFile(path) {
  const bytes = readFileSync(path);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function corpusFromRandom(seed, totalBytes) {
  const rng = mulberry32(seed);
  const arr = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) arr[i] = (rng() * 256) | 0;
  return new TextDecoder('utf-8', { fatal: false }).decode(arr);
}

// Wrap the engine's snipCorpusFromFixtures with Node-side I/O: walk
// fixtures/, load each .gz as both raw bytes and inflated bytes
// (when gunzip succeeds), hand the fixture list to the engine. Keeps
// the snip math in one place that the browser harness can reuse.
function corpusFromFixtureSnips(seed, totalBytes) {
  const files = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.gz'))
    .sort();
  if (files.length === 0) {
    throw new Error('corpusFromFixtureSnips: no .gz files in fixtures/');
  }
  const fixtures = [];
  for (const fname of files) {
    const raw = readFileSync(join(FIXTURES_DIR, fname));
    let inflated = null;
    try { inflated = gunzipSync(raw); } catch { /* not gzip */ }
    fixtures.push({ name: fname, raw: new Uint8Array(raw), inflated });
  }
  return snipCorpusFromFixtures(fixtures, seed, totalBytes);
}

// ---- Forensics ----

function dumpFailure(ev) {
  const folder = join(TMP_DIR, `stress-failure-${ts()}-${ev.size}-${ev.rep}`);
  mkdirSync(folder, { recursive: true });
  if (ev.source) writeFileSync(join(folder, 'source.bin'), ev.source);
  if (typeof ev.cover === 'string' && ev.cover.length > 0) {
    writeFileSync(join(folder, 'cover.txt'), ev.cover);
  }
  if (ev.recovered) writeFileSync(join(folder, 'decoded.bin'), ev.recovered);
  const meta = {
    sweep: ev.sweep,
    size: ev.size,
    rep: ev.rep,
    phase: ev.phase,
    sourceLen: ev.source ? ev.source.length : null,
    coverLen: typeof ev.cover === 'string' ? ev.cover.length : null,
    recoveredLen: ev.recovered ? ev.recovered.length : null,
    error: ev.error ? {
      name: ev.error.name,
      message: ev.error.message,
      stack: ev.error.stack,
    } : null,
  };
  writeFileSync(join(folder, 'meta.json'), JSON.stringify(meta, null, 2));
  return folder;
}

async function main() {
  const cfg = loadConfig();
  const controller = new AbortController();
  const quiet = !!process.env.STRESS_QUIET;

  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount === 1) {
      process.stderr.write('\n[stress] cancellation requested; finishing current round-trip...\n');
      controller.abort();
    } else {
      process.stderr.write('[stress] second Ctrl-C; exiting immediately.\n');
      process.exit(130);
    }
  });

  // Resolve corpus.
  let corpus;
  let corpusLabel;
  if (cfg.corpusFile) {
    corpus = corpusFromFile(cfg.corpusFile);
    corpusLabel = `file=${cfg.corpusFile}`;
  } else if (cfg.corpusMode === 'random') {
    corpus = corpusFromRandom(cfg.corpusSeed, cfg.corpusBytes);
    corpusLabel = `random ${formatSize(cfg.corpusBytes)} seed=0x${cfg.corpusSeed.toString(16)}`;
  } else if (cfg.corpusMode === 'snip') {
    corpus = corpusFromFixtureSnips(cfg.corpusSeed, cfg.corpusBytes);
    corpusLabel = `snip ${formatSize(cfg.corpusBytes)} seed=0x${cfg.corpusSeed.toString(16)}`;
  } else {
    throw new Error(`stress: unknown --corpus-mode '${cfg.corpusMode}'`);
  }

  // Source list: base seven, plus emoji surfaces when --emoji-flood
  // is on (mirrors developer's "voc=b + emoji flood" repro URL).
  const sources = cfg.emojiFlood
    ? [...DEFAULT_SOURCES, 'emoji16', 'emoji-cldr-names-16', 'emoji-curated-phrases-16']
    : DEFAULT_SOURCES;

  // Load fixture assets through the canonical resource loader (SAB
  // fixtures, unpacked with the production builder primitives).
  process.stderr.write(`[stress] loading base twlists (${sources.length} sources)...\n`);
  const { baseTwlists, cldr, curatedKeywords } =
    await loadStressAssets(loadResource, sources, { emoji: cfg.emojiFlood });

  const boundsLabel =
    (cfg.maxSweeps === Infinity && cfg.maxDurationMs === Infinity)
      ? 'forever (Ctrl-C to stop)'
      : [
          cfg.maxSweeps === Infinity ? null : `sweeps≤${cfg.maxSweeps}`,
          cfg.maxDurationMs === Infinity ? null : `duration≤${cfg.maxDurationMs / 1000}s`,
        ].filter(Boolean).join(' ');
  process.stderr.write(
    `[stress] corpus=${corpusLabel} restrict=${cfg.restrict} ` +
    `emoji-flood=${cfg.emojiFlood} ` +
    `sizes=[${cfg.sizes.map(formatSize).join(', ')}] reps=${cfg.reps} bounds=${boundsLabel}\n`
  );

  await runStress({
    signal: controller.signal,
    sizes: cfg.sizes,
    reps: cfg.reps,
    rngSeed: cfg.rngSeed,
    corpus,
    assets: { baseTwlists, cldr, curatedKeywords },
    sources,
    emojiFlood: cfg.emojiFlood,
    restrict: cfg.restrict,
    maxSweeps: cfg.maxSweeps,
    maxDurationMs: cfg.maxDurationMs,
    onProgress: (ev) => {
      if (ev.kind === 'setup') {
        process.stderr.write(`[stress] ${ev.detail}\n`);
      } else if (ev.kind === 'sweep-start') {
        process.stderr.write(`[stress] sweep ${ev.sweep} starting\n`);
      } else if (ev.kind === 'roundtrip' && !quiet) {
        const sym = ev.ok ? '✓' : '✗';
        process.stderr.write(
          `  ${sym} sweep=${ev.sweep} size=${formatSize(ev.size).padStart(6)} ` +
          `rep=${ev.rep + 1}/${cfg.reps} (${ev.ms}ms)\n`
        );
      } else if (ev.kind === 'failure') {
        const folder = dumpFailure(ev);
        process.stderr.write(
          `[stress] FAILURE: phase=${ev.phase} size=${ev.size} rep=${ev.rep + 1} ` +
          `→ ${folder.replace(REPO_ROOT + '/', '')}\n` +
          `         error: ${ev.error?.message || ev.error}\n`
        );
      } else if (ev.kind === 'sweep-end') {
        const t = ev.totals;
        process.stderr.write(
          `[stress] sweep ${ev.sweep} done. ` +
          `total: ${t.pass}p / ${t.fail}f / ${t.runs}r ` +
          `(by-phase: ${JSON.stringify(t.byPhase)})\n`
        );
      } else if (ev.kind === 'cancelled') {
        const t = ev.totals;
        process.stderr.write(
          `[stress] stopped (reason=${ev.reason}). final: ${t.pass}p / ${t.fail}f / ${t.runs}r ` +
          `(by-phase: ${JSON.stringify(t.byPhase)})\n`
        );
      }
    },
  });
}

main().catch((e) => {
  process.stderr.write(`[stress] fatal: ${e.stack || e.message || e}\n`);
  process.exit(1);
});
