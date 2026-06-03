#!/usr/bin/env node
// fetch.js: re-download the canonical Moby Part-of-Speech II text
// from Project Gutenberg eBook 3203 and store it as mobypos.txt.gz
// alongside this script. Run when refreshing the source after a
// Gutenberg-side update; the build pipeline (tools/build-twlist-
// fixtures.js) reads mobypos.txt.gz, not this script.
//
// Public domain by grant from the author (Grady Ward, 1996).

import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'https://www.gutenberg.org/files/3203/files/mobypos.txt';
const OUT = join(HERE, 'mobypos.txt.gz');

process.stderr.write(`fetching ${URL}...\n`);
const r = await fetch(URL);
if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
await pipeline(Readable.fromWeb(r.body), createGzip(), createWriteStream(OUT));
process.stderr.write(`wrote ${OUT}\n`);
