#!/usr/bin/env node
// Eve, auto-recovery utility. Phase I CLI via the multi-worker
// scheduler + orchestrator. Step 3 of the multi-worker arc.
//
// Same engine surface as the browser Eve tab; this CLI is the
// node-side caller. Spawns a worker_threads pool, builds the job
// DAG via runOrchestrator, streams Eve verdict events to stdout.
//
// Usage:
//   node tools/eve/run-pool.mjs --suspected=PATH [--concurrency=N]
//     [--twlist=name=PATH ...] [--custom-corpus=PATH]
//     [--custom-twlist=PATH]
//
// --suspected PATH          the suspected nicetext suspected (any text file;
//                       .gz files are gunzipped automatically).
// --concurrency N       pool size override. Default:
//                       os.availableParallelism() - 1, clamped to 1.
// --twlist name=PATH    add a developer-supplied source detector
//                       under sources.<name>. May repeat.
// --custom-corpus PATH  add a customCorpus detector built from word
//                       tokens of the supplied file.
// --custom-twlist PATH  add a customTwlist detector built from the
//                       supplied TW-list file.
//
// Node-side runner; mirrors the browser orchestration.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

import twlistSourcesMeta from '../../fixtures/twlist-sources.meta.js';
import cardsRegistry from '../../fixtures/cards.data.js';
import { createPool } from '../../js/src/worker/pool.js';
import { runOrchestrator } from '../../js/src/eve/orchestrator.js';
import { loadResource } from '../../js/src/resource-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const POOL_WORKER_URL = pathToFileURL(
  resolvePath(REPO_ROOT, 'js/src/eve/job-worker-entry.js'),
);

function parseArgs(argv) {
  const out = { twlists: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'twlist') {
      const eq = m[2].indexOf('=');
      if (eq === -1) {
        process.stderr.write(`eve: --twlist must be name=PATH, got "${m[2]}"\n`);
        process.exit(2);
      }
      out.twlists.push({ name: m[2].slice(0, eq), path: m[2].slice(eq + 1) });
    } else {
      out[m[1]] = m[2];
    }
  }
  return out;
}

function buildExtraDetectors(args) {
  const out = [];
  for (const { name, path } of args.twlists) {
    out.push({
      kind: 'source',
      name,
      url: pathToFileURL(resolvePath(REPO_ROOT, path)).toString(),
    });
  }
  if (args['custom-corpus']) {
    out.push({
      kind: 'customCorpus',
      url: pathToFileURL(resolvePath(REPO_ROOT, args['custom-corpus'])).toString(),
    });
  }
  if (args['custom-twlist']) {
    out.push({
      kind: 'customTwlist',
      url: pathToFileURL(resolvePath(REPO_ROOT, args['custom-twlist'])).toString(),
    });
  }
  return out;
}

function loadSuspected(suspectedPath) {
  const abs = resolvePath(REPO_ROOT, suspectedPath);
  const buf = readFileSync(abs);
  if (suspectedPath.endsWith('.gz')) return gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

function stemForCorpus(corpusPath) {
  const base = corpusPath.split('/').pop();
  return base.replace(/\*/g, '').replace(/\.txt$/i, '');
}

function printEvent(event) {
  switch (event.kind) {
    case 'banner':
      process.stdout.write(`\n=== ${event.text} ===\n`);
      break;
    case 'progress':
      process.stderr.write(`  ${event.test}: ${event.what}\n`);
      break;
    case 'verdict': {
      const knob = event.knob || '(group)';
      const verdict = event.verdict || '';
      const why = event.why || event.detail || '';
      const rule = event.rule ? ` [${event.rule}]` : '';
      const contradiction = event.contradiction ? ' (CONTRADICTION)' : '';
      process.stdout.write(`  ${knob.padEnd(36)}  ${verdict.padEnd(9)}  ${why}${rule}${contradiction}\n`);
      break;
    }
    case 'detail':
      process.stdout.write(`    ${event.text}\n`);
      break;
    case 'stats':
      process.stdout.write(
        `\nCombinations alive: ${event.combinationsAlive} ` +
        `(${event.stylesConsidered} of ${event.stylesIn} styles considered, ` +
        `${event.augCount} augment tuples per non-flat style)\n`,
      );
      break;
    case 'done':
      process.stdout.write(`\n=== analysis complete ===\n`);
      break;
    case 'cancelled':
      process.stdout.write(`\n=== analysis cancelled ===\n`);
      break;
    case 'error':
      process.stderr.write(`\nERROR: ${event.message}\n`);
      process.exitCode = 1;
      break;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.suspected) {
    process.stderr.write(`usage: node tools/eve/run-pool.mjs --suspected=PATH [--concurrency=N]\n`);
    process.exit(2);
  }
  const suspectedText = loadSuspected(args.suspected);
  const concurrency = args.concurrency ? Number.parseInt(args.concurrency, 10) : undefined;

  const pool = await createPool({ workerUrl: POOL_WORKER_URL, size: concurrency });
  process.stderr.write(`eve pool: ${pool.size} workers\n`);

  const extraDetectors = buildExtraDetectors(args);
  if (extraDetectors.length > 0) {
    process.stderr.write(
      `eve: ${extraDetectors.length} developer-supplied detector(s): ` +
      extraDetectors.map(d => d.kind === 'source' ? `sources.${d.name}` : d.kind).join(', ') +
      `\n`,
    );
  }

  const twlistMeta = twlistSourcesMeta.map((e) => ({ key: e.key, filename: e.filename }));
  const cardList = cardsRegistry
    .filter((c) => c.build && c.build.corpus)
    .map((c) => ({ name: c.name, stem: stemForCorpus(c.build.corpus) }));

  const startedAt = Date.now();
  let result = null;
  try {
    result = await runOrchestrator({
      suspectedText,
      twlistMeta,
      cardList,
      dispatchJob: pool.dispatch,
      loadResource,
      extraDetectors,
      concurrency: pool.size,
      onEvent: printEvent,
    });
  } finally {
    await pool.terminate();
  }
  process.stderr.write(`elapsed: ${Date.now() - startedAt} ms\n`);
  if (result && result.results) {
    renderRichSummary(result.results);
  }
}

// Post-run aggregate report: per-TW-list coverage table,
// must-literals sample, candidate-combination enumeration. The
// alive-combinations count is emitted as a 'stats' event by the
// orchestrator (rendered above by printEvent) so node and browser
// share the source of truth.
function renderRichSummary(results) {
  const vocab = results.get('vocab-check');
  if (vocab) renderVocabReport(vocab);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function renderVocabReport(vocab) {
  process.stdout.write(`\n=== Vocab analysis (${vocab.totalUnique} unique suspected words, ${vocab.twlistNames.length} TW-lists) ===\n`);
  // Per-TW-list coverage table.
  const rows = [...vocab.perTwlistCoverage.entries()]
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.rate - a.rate);
  const nameW = Math.max(...rows.map((r) => r.name.length), 16);
  process.stdout.write(`  TW-list coverage (sorted by rate desc):\n`);
  for (const r of rows) {
    const pct = (r.rate * 100).toFixed(1).padStart(5);
    const flag = r.rate === 1 ? '100% (likely)' : r.rate === 0 ? '0% (unlikely)' : '';
    process.stdout.write(`    ${pad(r.name, nameW)}  ${pct}%  (${r.hits}/${r.total})  ${flag}\n`);
  }
  // Must-literals sample.
  process.stdout.write(`\n  Must-literals (suspected words in zero TW-lists): ${vocab.mustLiterals.length}\n`);
  if (vocab.mustLiterals.length > 0 && vocab.mustLiterals.length <= 30) {
    process.stdout.write(`    ${vocab.mustLiterals.join(', ')}\n`);
  } else if (vocab.mustLiterals.length > 30) {
    process.stdout.write(`    ${vocab.mustLiterals.slice(0, 30).join(', ')} ... (${vocab.mustLiterals.length - 30} more)\n`);
  }
  // Candidate combinations.
  process.stdout.write(`\n  Candidate combinations (distinct matchingtwlist groups, size >= 2):\n`);
  const top = vocab.candidateCombinations.slice(0, 10);
  for (const c of top) {
    const flag = c.coversAllNonLiterals ? ' (covers ALL non-literal words)' : '';
    process.stdout.write(`    [${c.twlists.join(', ')}]  ${(c.coverageRate * 100).toFixed(1)}% coverage, ${c.wordCount} words in group${flag}\n`);
  }
  if (vocab.candidateCombinations.length > 10) {
    process.stdout.write(`    ... (${vocab.candidateCombinations.length - 10} more groups)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`eve: ${err.stack || err.message}\n`);
  process.exit(1);
});
