#!/usr/bin/env node
// fetch.js -- re-download Peter Norvig's count_1w.txt unigram counts
// (derived from a 1-trillion-word web corpus) and gzip into raw/.
// The build pipeline (tools/build-freq-fixtures.js) reads
// raw/count_1w.txt.gz and produces fixtures/norvig.freq.tsv.gz +
// fixture-src/freq/norvig/cooked/norvig.freq.tsv.gz cache.
//
// "May be used for any purpose" per https://norvig.com/ngrams/.

import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'https://norvig.com/ngrams/count_1w.txt';
const RAW_DIR = join(HERE, 'raw');
const OUT = join(RAW_DIR, 'count_1w.txt.gz');

mkdirSync(RAW_DIR, { recursive: true });

process.stderr.write(`fetching ${URL}...\n`);
const r = await fetch(URL);
if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
await pipeline(Readable.fromWeb(r.body), createGzip({ level: 9 }), createWriteStream(OUT));
process.stderr.write(`wrote ${OUT}\n`);
