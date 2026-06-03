#!/usr/bin/env node
// fetch.js -- download Google Books English 1-grams (20120701 release)
// into raw/. ~27 files, several GB total compressed; raw/ is
// gitignored. The build pipeline (tools/build-freq-fixtures.js)
// streams raw/*.gz, sums match counts across years, intersects with
// the active vocab pool, and writes fixtures/google-books.freq.tsv.gz.
//
// CC BY 3.0 per
// http://storage.googleapis.com/books/ngrams/books/datasetsv2.html.
//
// We download a-z + 'other' (numerics and other initial chars). We
// skip 'pos' (POS-tagged forms duplicate untagged counts under tags
// like the_DET) and 'punctuation' (no English words).

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
mkdirSync(RAW, { recursive: true });

const BASE = 'http://storage.googleapis.com/books/ngrams/books/';
const SUFFIXES = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m',
  'n','o','p','q','r','s','t','u','v','w','x','y','z',
  'other'
];

let okCount = 0;
let skipCount = 0;
let failCount = 0;

for (const suf of SUFFIXES) {
  const name = `googlebooks-eng-all-1gram-20120701-${suf}.gz`;
  const url = BASE + name;
  const out = join(RAW, name);
  if (existsSync(out) && statSync(out).size > 0) {
    process.stderr.write(`skip (exists) ${name}\n`);
    skipCount++;
    continue;
  }
  process.stderr.write(`fetching ${name}...\n`);
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    process.stderr.write(`  warn: fetch error for ${name}: ${e.message}\n`);
    failCount++;
    continue;
  }
  if (!r.ok) {
    process.stderr.write(`  warn: HTTP ${r.status} for ${name}; skipping\n`);
    failCount++;
    continue;
  }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(out));
  const size = statSync(out).size;
  process.stderr.write(`  ok ${name} (${(size / 1e6).toFixed(1)} MB)\n`);
  okCount++;
}

process.stderr.write(`done; raw at ${RAW} (${okCount} fetched, ${skipCount} cached, ${failCount} failed)\n`);
