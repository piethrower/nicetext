#!/usr/bin/env node
// build-corpus-dict.js: byos.json-driven corpus dictionary builder.
// Builds a "distribution dictionary" restricted to the vocabulary of the
// byos's referenced corpus. Reads the input byos's OWN base block to
// determine sources, augmentation, frequencies, and tieBreak; no master
// hardcoding. Mirrors the OG wizwords.twl recipe in
// OG-NiceText-C++/nicetext-1.0/examples/database/Makefile.
//
// Algorithm:
//   1. Tokenize the corpus → set of unique lowercase words (vocab) +
//      per-word counts.
//   2. Load the BYOS's own base TWLIST (sources + augmentation per
//      byos.base).
//   3. Keep only TWLIST entries whose word ∈ vocab.
//   4. For any vocab word NOT covered: emit a self-defined (word, word).
//   5. sortDict + buildDictionary, weighted per byos.base.frequencies
//      (today: 'style' → corpus's own counts; external sources optional)
//      and tiebroken per byos.base.tieBreak.
//
// Usage:  node tools/build-corpus-dict.js <corpus-byos.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync, constants as zlibConstants } from 'node:zlib';
import { basename } from 'node:path';

import { sortDict } from '../js/src/builder/sortdct.js';
import { buildDictionary } from '../js/src/builder/dct2mstr.js';
import { listWordsWithCounts } from '../js/src/builder/listword.js';
import { restrictToVocab } from '../js/src/builder/sources.js';
import {
  parseFreqLines, combineFrequencies, wordCountsToFreqSource,
} from '../js/src/builder/frequencies.js';
import { loadCorpusText } from './load-corpus.js';
import {
  loadByosFile, loadCardsRegistry, loadBaseTwlist, reportDictStats,
  dictNativeFsPath, typehashFsPath, repoPath, ROOT,
} from './byos-build-helpers.js';

// Map byos.base.frequencies source names to their fixture filenames.
// 'style' is special-cased (it uses the corpus's own counts, not a fixture).
const FREQ_FIXTURES = {
  norvig:    'norvig.freq.tsv.gz',
  google:    'google.freq.tsv.gz',
  gutenberg: 'gutenberg.freq.tsv.gz',
};

function loadFreqFixture(name) {
  // Freq fixtures live alongside other shipped fixtures under
  // fixtures/{file}. Read directly.
  const file = FREQ_FIXTURES[name];
  if (!file) throw new Error(`build-corpus-dict: unknown freq source "${name}"`);
  const buf = readFileSync(repoPath(`fixtures/${file}`));
  const text = gunzipSync(buf).toString('utf8');
  return parseFreqLines(text);
}

function buildFreqMap(byos, wordCounts) {
  const freqs = byos.base.frequencies || [];
  if (freqs.length === 0) return null;
  const sources = [];
  for (const name of freqs) {
    if (name === 'style') {
      sources.push(wordCountsToFreqSource(wordCounts));
    } else {
      sources.push(loadFreqFixture(name));
    }
  }
  return combineFrequencies(sources);
}

async function main() {
  const byosPath = process.argv[2];
  if (!byosPath) {
    process.stderr.write('usage: build-corpus-dict.js <corpus-byos.json>\n');
    process.exit(2);
  }
  process.stderr.write(`reading byos: ${byosPath}\n`);
  const byos = loadByosFile(byosPath);

  if (!byos.story || byos.story.style === 'flat') {
    throw new Error(
      `build-corpus-dict: ${basename(byosPath)} has no story or story.style='flat'; ` +
      `use build-base-dict.js for base-only fixtures.`
    );
  }
  if (!byos.base) {
    throw new Error(
      `build-corpus-dict: ${basename(byosPath)} has no base block; ` +
      `corpus dictionaries are built by intersecting the base TWLIST with corpus vocab, ` +
      `so the byos must declare its base recipe explicitly.`
    );
  }
  if (!byos.build || !byos.build.corpus) {
    throw new Error(
      `build-corpus-dict: ${basename(byosPath)} is missing build.corpus path; ` +
      `fixture-build byos files for non-flat stories must specify a corpus source.`
    );
  }

  const corpusPath = repoPath(byos.build.corpus);
  process.stderr.write(`reading corpus: ${corpusPath}\n`);
  const corpus = loadCorpusText(corpusPath);
  const wordCounts = await listWordsWithCounts(corpus);
  const vocab = new Set(wordCounts.keys());
  process.stderr.write(`  vocab: ${vocab.size} unique words\n`);

  process.stderr.write(`loading base TWLIST from byos.base...\n`);
  const { entries: baseTwlist, hashMap } = await loadBaseTwlist(byos);
  const hashed = byos.base.hashedMergedTypes !== false;

  process.stderr.write('restricting to corpus vocabulary...\n');
  const restricted = restrictToVocab(baseTwlist, vocab);
  const covered = restricted.filter(e => e.type !== e.word).length;
  const selfDefined = restricted.length - covered;
  process.stderr.write(`  ${covered} entries from base, ${selfDefined} self-defined\n`);

  process.stderr.write('sortdct...\n');
  const mtwlist = await sortDict(restricted, { hashed, hashMap });
  process.stderr.write(`  mtwlist: ${mtwlist.length} unique words\n`);

  const freqMap = buildFreqMap(byos, wordCounts);
  const freqDescr = (byos.base.frequencies || []).join(',') || '(unweighted)';
  process.stderr.write(`dct2mstr (Huffman, frequencies=${freqDescr}, tieBreak=${byos.base.tieBreak})...\n`);
  const dict = buildDictionary(mtwlist, {
    name: byos.name,
    frequencies: freqMap,
    tieBreak: byos.base.tieBreak,
  });

  const cards = loadCardsRegistry();
  const out = dictNativeFsPath(byos, cards);
  writeFileSync(out, gzipSync(JSON.stringify(dict), { level: zlibConstants.Z_BEST_COMPRESSION }));
  reportDictStats(dict, `built ${out.replace(ROOT + '/', '')}`);

  // Persist the typehash sibling fixture when requested. See
  // build-base-dict.js for the matching block.
  if (hashMap) {
    const tpath = typehashFsPath(byos, cards);
    const obj = Object.fromEntries(hashMap);
    writeFileSync(tpath, gzipSync(JSON.stringify(obj), { level: zlibConstants.Z_BEST_COMPRESSION }));
    process.stderr.write(`built ${tpath.replace(ROOT + '/', '')} (${hashMap.size} entries)\n`);
  }
}

// loadResource (called transitively via sortDict → getRedactedSingles)
// uses a worker_threads pool that keeps the event loop open after work
// completes. Same pattern as js/bin/nicetext.js, explicit exit so the
// CLI returns promptly.
await main();
process.exit(0);
