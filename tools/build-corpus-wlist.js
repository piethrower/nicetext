#!/usr/bin/env node
// build-corpus-wlist.js: derive per-corpus wlist natives from the
// shipped corpus texts. One .wlist.txt.gz per unique corpus the cards
// registry references; `sab pack wlist` (final step of
// build-all-fixtures) compiles each into the canonical
// /fixtures/<stem>.wlist.sab.gz runtime fixture and deletes the native.
//
// The wordlist projection mirrors extractCorpusVocab in
// js/src/eve/vocab-check.js: precleanCorpus → tokenize → lowercase →
// dedupe → sort. Identical tokenization to what Eve consumed from
// fixtures/eve/<stem>.corpus-vocab.sab.gz before this arc; the
// difference is that the wlist is now a first-class /fixtures artifact
// available to any consumer that wants O(log n) word-membership over
// the corpus, not an Eve-private precompute.
//
// Outputs (gzipped at level 9):
//   fixtures/<stem>.wlist.txt.gz    one word per line, sorted-unique
//
// Usage:  node tools/build-corpus-wlist.js

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import cardsRegistry from '../fixtures/cards.data.js';
import { extractCorpusVocab } from '../js/src/eve/vocab-check.js';
import { loadCorpusText } from './load-corpus.js';
import { repoPath, wlistNativeFsPath } from './byos-build-helpers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'fixtures');
const GZ_LEVEL = { level: zlibConstants.Z_BEST_COMPRESSION };

if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

// Same stem derivation as tools/build-eve-fixtures.js / corpusStem.
// Path 'fixture-src/texts/aesop.txt' → 'aesop'; trailing '*' (variant
// glob) and trailing '.txt' are stripped.
function corpusStem(corpusPath) {
  const base = corpusPath.split('/').pop();
  return base.replace(/\*/g, '').replace(/\.txt$/i, '');
}

// One native per unique corpus path. Aesop and any future
// aesop-variant cards sharing fixture-src/texts/aesop.txt share one
// wlist; the projection is keyed by corpus file.
const uniqueCorpora = new Map();
for (const card of cardsRegistry) {
  const path = card.build && card.build.corpus;
  if (!path) continue;
  if (!uniqueCorpora.has(path)) uniqueCorpora.set(path, corpusStem(path));
}

process.stderr.write(`corpus wlists: ${uniqueCorpora.size} unique corpora\n`);

let producedCount = 0;
let totalWords = 0;
let totalBytesOut = 0;

for (const [corpusPath, stem] of uniqueCorpora) {
  const srcPath = repoPath(corpusPath);
  const text = loadCorpusText(srcPath);
  const vocab = extractCorpusVocab(text);
  const sortedWords = [...vocab].sort();
  // Canonical native: one word per line, trailing newline. Pack is
  // defensive (re-normalizes) but this shape lets the gzipped TXT
  // double as a human-inspectable artifact during build.
  const body = sortedWords.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(body, 'utf8'), GZ_LEVEL);
  const dst = wlistNativeFsPath(stem);
  writeFileSync(dst, gz);
  producedCount++;
  totalWords += sortedWords.length;
  totalBytesOut += gz.length;
  process.stderr.write(
    `  ${stem}.wlist.txt.gz  ${sortedWords.length.toLocaleString()} words, ` +
    `${gz.length.toLocaleString()} bytes\n`,
  );
}

process.stderr.write(
  `\ncorpus wlists: ${producedCount} files, ` +
  `${totalWords.toLocaleString()} total words, ` +
  `${totalBytesOut.toLocaleString()} gz bytes\n`,
);
