#!/usr/bin/env node
// fetch.js -- re-download the Unicode TR39 confusables.txt and write it
// into raw/. The build (tools/build-confusables-map.js) reads
// raw/confusables.txt, filters it, and writes the committed
// cooked/confusables-data.js; build-all-fixtures.js then copies that
// to fixtures/confusables-data.js.
//
// raw/ is gitignored and ephemeral -- it only exists after you run
// this. Normal builds use the committed cooked/ artifact and never
// touch the network. Run this only to bump the Unicode version: edit
// VERSION below, run fetch.js, then build-confusables-map.js (it
// rebuilds cooked/ because raw/ is now newer), and commit the new
// cooked/confusables-data.js.
//
// Source: Unicode TR39, "Unicode Security Mechanisms" confusables
// data. Distributed under the Unicode License v3
// (https://www.unicode.org/license.txt).

import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = '15.1.0';
const URL = `https://www.unicode.org/Public/security/${VERSION}/confusables.txt`;
const RAW_DIR = join(HERE, 'raw');
const OUT = join(RAW_DIR, 'confusables.txt');

mkdirSync(RAW_DIR, { recursive: true });

process.stderr.write(`fetching ${URL}...\n`);
const r = await fetch(URL);
if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
await pipeline(Readable.fromWeb(r.body), createWriteStream(OUT));
process.stderr.write(`wrote ${OUT}\n`);
