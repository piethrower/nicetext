#!/usr/bin/env node
// fetch.js -- extract locale-flavor conversion pairs from
// client9/misspell's `DictAmerican` and `DictBritish` blocks into
// pairs.tsv.gz, and copy the upstream MIT LICENSE verbatim alongside
// so the notice travels with the derived data.
//
// Sibling fetcher: fixture-src/rewriters/typos/fetch.js handles the
// DictMain general-typo block. Both fetchers share the Go-literal
// parser at fixture-src/rewriters/_lib/client9-misspell-parser.js.
//
// External source is NOT redistributed in this repo. It must be
// installed by the developer at ../misspell/ (sibling to the nicetext
// repo). Concretely:
//
//   /home/<you>/software/nicetext/      <- this repo
//   /home/<you>/software/misspell/      <- sibling, populated by the
//                                          one-time setup below
//
// One-time setup (do once on the build machine):
//
//   mkdir -p ../misspell && cd ../misspell
//   git clone --depth 1 https://github.com/client9/misspell.git .
//
// To upgrade later: `git -C ../misspell pull` and re-run this script
// AND the sibling typos/fetch.js. Upstream was archived 2025-03-26,
// so the data is frozen and an upgrade pull is currently a no-op;
// the path is documented to keep open the option if a fork resumes
// maintenance.
//
// License (MIT): the upstream LICENSE is copied verbatim to
// fixture-src/rewriters/british/LICENSE alongside pairs.tsv.gz so the
// MIT permission notice physically travels with the derivative data.
// The sibling typos/fetch.js vendors its own copy for the same
// reason. A user-facing entry is maintained in attributions.html.
//
// Pipeline:
//
//   ../misspell/words.go      Go source, DictAmerican + DictBritish
//        |                    blocks
//        v
//   parser (_lib)             brace-matched extraction of each block;
//        |                    consecutive (wrong, correct) string
//        |                    pairs in declaration order
//        v
//   sort + dedupe             stable sort by (wrong, correct, source);
//        |                    drop byte-identical duplicates
//        v
//   pairs.tsv.gz              one pair per line, tab-separated:
//                               <wrong>\t<correct>\t<source>
//                             where <source> is american or british.
//                             DictAmerican rows convert UK->US
//                             spellings; DictBritish rows convert
//                             US->UK spellings.
//
//   ../misspell/LICENSE  -->  fixture-src/rewriters/british/LICENSE
//                             copied verbatim, byte-for-byte.

import {
  existsSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractBlockPairs } from '../_lib/client9-misspell-parser.js';

const HERE          = dirname(fileURLToPath(import.meta.url));
const REPO          = resolve(HERE, '..', '..', '..');     // .../nicetext
const MISSPELL_ROOT = resolve(REPO, '..', 'misspell');     // sibling
const WORDS_GO      = join(MISSPELL_ROOT, 'words.go');
const LICENSE_IN    = join(MISSPELL_ROOT, 'LICENSE');
const PAIRS_OUT     = join(HERE, 'pairs.tsv.gz');
const LICENSE_OUT   = join(HERE, 'LICENSE');

const BLOCKS = [
  { name: 'DictAmerican', tag: 'american' },
  { name: 'DictBritish',  tag: 'british'  },
];

function failMissingSibling(missingPath) {
  process.stderr.write(
    `fetch.js: required sibling file not found: ${missingPath}\n` +
    'Install client9/misspell sibling-style, then re-run this script.\n' +
    'See the header comment in this file for the one-time setup block.\n');
  process.exit(1);
}

function writeAtomic(targetPath, bytes) {
  const tmp = targetPath + '.tmp';
  writeFileSync(tmp, bytes);
  renameSync(tmp, targetPath);
}

function main() {
  if (!existsSync(WORDS_GO))   failMissingSibling(WORDS_GO);
  if (!existsSync(LICENSE_IN)) failMissingSibling(LICENSE_IN);

  const source = readFileSync(WORDS_GO, 'utf8');

  const all = [];
  for (const { name, tag } of BLOCKS) {
    const pairs = extractBlockPairs(source, name);
    process.stderr.write(`fetch.js: ${name} -> ${pairs.length} pairs (tag=${tag})\n`);
    for (const [wrong, correct] of pairs) all.push([wrong, correct, tag]);
  }
  process.stderr.write(`fetch.js: total ${all.length} pairs across ${BLOCKS.length} blocks\n`);

  all.sort((a, b) =>
       a[0] < b[0] ? -1 : a[0] > b[0] ? 1
     : a[1] < b[1] ? -1 : a[1] > b[1] ? 1
     : a[2] < b[2] ? -1 : a[2] > b[2] ? 1
     : 0);

  const lines = [];
  let prev = null;
  for (const [wrong, correct, tag] of all) {
    const line = `${wrong}\t${correct}\t${tag}`;
    if (line === prev) continue;
    lines.push(line);
    prev = line;
  }
  const deduped = all.length - lines.length;
  if (deduped > 0) {
    process.stderr.write(`fetch.js: deduped ${deduped} byte-identical lines\n`);
  }

  const tsv = lines.join('\n') + '\n';
  const gz  = gzipSync(Buffer.from(tsv, 'utf8'), { level: 9 });
  writeAtomic(PAIRS_OUT, gz);
  process.stderr.write(`fetch.js: wrote ${PAIRS_OUT} (${lines.length} lines, ${gz.length} bytes gz)\n`);

  const licBytes = readFileSync(LICENSE_IN);
  writeAtomic(LICENSE_OUT, licBytes);
  process.stderr.write(`fetch.js: wrote ${LICENSE_OUT} (${licBytes.length} bytes verbatim)\n`);
}

main();
