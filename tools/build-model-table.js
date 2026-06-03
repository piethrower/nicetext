#!/usr/bin/env node
// build-model-table.js: byos.json-driven sentence-model-table builder.
// Reads a corpus byos.json, loads the byos's already-built corpus dict
// from the native intermediate fixtures/{byos.name}.dict.json.gz (the
// transient form the dict builder just wrote; `sab pack dict` compiles
// it to .dict.sab.gz and deletes the native at the end of the build
// pipeline), tokenizes the corpus, and emits a model table. The dedupe
// flag is driven by byos.story.sentence:
//   'random'     → dedupe=true  (weighted-random replay)
//   'sequential' → dedupe=false (preserves source sentence order)
//
// Usage:  node tools/build-model-table.js <corpus-byos.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync, constants as zlibConstants } from 'node:zlib';
import { basename } from 'node:path';

import { generateModelTable } from '../js/src/builder/genmodel.js';
import { loadDictionary } from '../js/src/dictionary.js';
import { loadModelTable, modelTableStats } from '../js/src/modeltable.js';
import { loadCorpusText } from './load-corpus.js';
import {
  loadByosFile, loadCardsRegistry,
  dictNativeFsPath, modelNativeFsPath, repoPath, ROOT,
} from './byos-build-helpers.js';

function readJsonMaybeGz(path) {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}

async function main() {
  const byosPath = process.argv[2];
  if (!byosPath) {
    process.stderr.write('usage: build-model-table.js <corpus-byos.json>\n');
    process.exit(2);
  }
  process.stderr.write(`reading byos: ${byosPath}\n`);
  const byos = loadByosFile(byosPath);

  if (!byos.story || byos.story.style === 'flat') {
    throw new Error(
      `build-model-table: ${basename(byosPath)} has no story or story.style='flat'; ` +
      `model tables only apply to non-flat stories.`
    );
  }
  if (!byos.build || !byos.build.corpus) {
    throw new Error(
      `build-model-table: ${basename(byosPath)} is missing build.corpus path.`
    );
  }
  if (byos.story.sentence !== 'random' && byos.story.sentence !== 'sequential') {
    throw new Error(
      `build-model-table: ${basename(byosPath)} story.sentence must be 'random' or 'sequential'.`
    );
  }

  const cards = loadCardsRegistry();
  const corpusPath = repoPath(byos.build.corpus);
  // Read the native dict intermediate (the .dict.json.gz the dict
  // builder just wrote in the previous build-all-fixtures step).
  // `sab pack dict` runs later in the pipeline and deletes natives;
  // model-table generation must complete before that step.
  const dictPath = dictNativeFsPath(byos, cards);
  // Write the native model-table intermediate (.model.json.gz). The
  // `sab pack model` step (final phase of build-all-fixtures) compiles
  // this into the canonical .model.sab.gz runtime fixture and deletes
  // the native.
  const outPath = modelNativeFsPath(byos, cards);

  process.stderr.write(`tokenizing corpus: ${corpusPath}\n`);
  const text = loadCorpusText(corpusPath);
  process.stderr.write(`loading dict: ${dictPath}\n`);
  const dict = loadDictionary(readJsonMaybeGz(dictPath));

  const dedupe = byos.story.sentence === 'random';
  process.stderr.write(`building model table (sentence=${byos.story.sentence}, dedupe=${dedupe})...\n`);
  const table = await generateModelTable(text, dict, { name: byos.name, dedupe });

  writeFileSync(outPath, gzipSync(JSON.stringify(table), { level: zlibConstants.Z_BEST_COMPRESSION }));
  const totalWeight = table.models.reduce((s, m) => s + m.weight, 0);
  const avgLen = table.models.reduce((s, m) => s + m.tokens.length * m.weight, 0) / Math.max(1, totalWeight);
  // Dynamic-vs-static classification against the paired dict.
  // Static models consume zero bits at encode time (every TYPE slot
  // resolves to a singleton, or every slot is a literal punct), but
  // are still emittable for natural cover variety. The encoder
  // force-switches to a dynamic pick when a no-progress streak fires.
  const runtimeTable = loadModelTable(table);
  const stats = modelTableStats(runtimeTable, dict);
  process.stderr.write(
    `\nbuilt ${outPath.replace(ROOT + '/', '')}\n` +
    `  ${table.models.length} ${dedupe ? 'unique' : 'ordered'} models, ${totalWeight} sentences\n` +
    `  ${avgLen.toFixed(1)} avg model length\n` +
    `  ${stats.dynamicModels} dynamic / ${stats.staticModels} static (vs paired dict)\n`
  );
}

// loadResource (called transitively via generateModelTable → getRedactedMatcher)
// uses a worker_threads pool that keeps the event loop open after work
// completes. Same pattern as js/bin/nicetext.js, explicit exit so the
// CLI returns promptly.
main().then(
  () => process.exit(0),
  (err) => { process.stderr.write(`${err.stack || err.message || err}\n`); process.exit(1); },
);
