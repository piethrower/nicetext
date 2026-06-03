#!/usr/bin/env node
// build-twlist-wlist.js: derive per-twlist-source wlist natives from
// the shipped twlist (.twlist.tsv.gz) sources. One .wlist.txt.gz per
// twlist source; `sab pack wlist` (final step of build-all-fixtures)
// compiles each into the canonical /fixtures/<name>.wlist.sab.gz
// runtime fixture and deletes the native.
//
// The wordlist projection: parseTwlistLines (TSV, # comments skipped)
// → word column → lowercase → dedupe → sort. The type column is
// dropped (consumers that need types load the .twlist.sab.gz instead;
// see js/src/sab.js / 'twlist' for that path).
//
// Eve uses the per-twlist wlists in runVocabCheck for word-membership
// tests over each twlist source. Pre-shipping these as fixtures means
// Eve does no per-session derivation: the resource loader hands back a
// shared SAB, workers query via wrapPackedStrings.hasSorted, single
// trip across the cache.
//
// Outputs (gzipped at level 9):
//   fixtures/<name>.wlist.txt.gz    one word per line, sorted-unique
//
// Usage:  node tools/build-twlist-wlist.js

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseTwlistLines } from '../js/src/builder/sources.js';
import { wlistNativeFsPath } from './byos-build-helpers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'fixtures');
const GZ_LEVEL = { level: zlibConstants.Z_BEST_COMPRESSION };

// Read the canonical twlist source registry rather than enumerating
// files. Two reasons:
//   1. The registry's `key` is what runtime callers (Eve orchestrator,
//      BYOS) pass to loadResource; the wlist fixture id must match
//      that key exactly so /fixtures/<key>.wlist.sab.gz resolves.
//   2. Some shipped twlist sources have non-canonical filenames
//      (e.g. key='emoji16-curated-keywords' →
//      filename='emoji16.curated-keywords.tsv.gz', no '.twlist.'
//      segment). Filesystem enumeration on '*.twlist.tsv.gz' misses
//      those; the registry covers them all.
function loadTwlistSources() {
  const path = join(FIXTURES, 'twlist-sources.meta.json');
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return json.sources || json; // tolerate either {sources:[...]} or bare array
}

const sources = loadTwlistSources();
process.stderr.write(`twlist wlists: ${sources.length} twlist sources\n`);

let producedCount = 0;
let totalWords = 0;
let totalBytesOut = 0;

for (const { key, filename } of sources) {
  const src = join(FIXTURES, filename);
  const text = gunzipSync(readFileSync(src)).toString('utf8');
  const set = new Set();
  for (const e of parseTwlistLines(text)) set.add(e.word.toLowerCase());
  const sortedWords = [...set].sort();
  const body = sortedWords.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(body, 'utf8'), GZ_LEVEL);
  // Output id MUST be the registry key (what runtime loadResource
  // callers ask for), not the filename stem.
  const dst = wlistNativeFsPath(key);
  writeFileSync(dst, gz);
  producedCount++;
  totalWords += sortedWords.length;
  totalBytesOut += gz.length;
  process.stderr.write(
    `  ${key}.wlist.txt.gz  ${sortedWords.length.toLocaleString()} words, ` +
    `${gz.length.toLocaleString()} bytes\n`,
  );
}

process.stderr.write(
  `\ntwlist wlists: ${producedCount} files, ` +
  `${totalWords.toLocaleString()} total words, ` +
  `${totalBytesOut.toLocaleString()} gz bytes\n`,
);
