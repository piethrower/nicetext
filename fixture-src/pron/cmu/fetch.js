#!/usr/bin/env node
// fetch.js -- re-download the CMU Pronouncing Dictionary
// (cmudict.dict, ~135K words, ARPABET phonemes with stress digits)
// and gzip alongside, plus the upstream LICENSE.
//
// Format: one entry per line, lowercase word, single space, then
// space-separated ARPABET phonemes. Vowels carry a stress digit
// (0/1/2). Variant pronunciations use a (N) suffix on the word
// (e.g. "abdomen(2) AE1 B D AH0 M AH0 N"). Lines starting with ;;;
// are comments.
//
// Used as the source for any twlist derived from word pronunciations:
// rhyme groups, alliteration groups, syllable counts, a/an exceptions,
// etc. Downstream builders read cmudict-0.7b.txt.gz and produce the
// per-purpose twlist fixture.
//
// "Use of this dictionary for any research or commercial purpose is
//  completely unrestricted. If you make use of or redistribute this
//  material, we request that you acknowledge its origin in your
//  descriptions." -- upstream LICENSE.
//
// The acknowledgement requirement is met in two places: the LICENSE
// file shipped alongside the dict in this directory, and the
// attributions.html entry.

import { createWriteStream, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT_URL    = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict';
const LICENSE_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/LICENSE';
const DICT_OUT    = join(HERE, 'cmudict.dict.gz');
const LICENSE_OUT = join(HERE, 'LICENSE');

process.stderr.write(`fetching ${DICT_URL}...\n`);
const r1 = await fetch(DICT_URL);
if (!r1.ok) throw new Error(`fetch ${DICT_URL}: HTTP ${r1.status}`);
await pipeline(Readable.fromWeb(r1.body), createGzip({ level: 9 }), createWriteStream(DICT_OUT));
process.stderr.write(`wrote ${DICT_OUT}\n`);

process.stderr.write(`fetching ${LICENSE_URL}...\n`);
const r2 = await fetch(LICENSE_URL);
if (!r2.ok) throw new Error(`fetch ${LICENSE_URL}: HTTP ${r2.status}`);
writeFileSync(LICENSE_OUT, await r2.text());
process.stderr.write(`wrote ${LICENSE_OUT}\n`);
