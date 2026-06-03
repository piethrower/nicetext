#!/usr/bin/env node
// fetch.js: re-download the canonical Moby Thesaurus II text from
// Project Gutenberg eBook 3202 and store it as mthesaur.txt.gz
// alongside this script. Run when refreshing the source; the build
// pipeline (tools/build-twlist-fixtures.js) reads mthesaur.txt.gz,
// not this script.
//
// Public domain by grant from the author (Grady Ward, 1996).

import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'https://www.gutenberg.org/files/3202/files/mthesaur.txt';
const OUT = join(HERE, 'mthesaur.txt.gz');

process.stderr.write(`fetching ${URL}...\n`);
const r = await fetch(URL);
if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
await pipeline(Readable.fromWeb(r.body), createGzip(), createWriteStream(OUT));
process.stderr.write(`wrote ${OUT}\n`);
