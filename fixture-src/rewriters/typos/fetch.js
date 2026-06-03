#!/usr/bin/env node
// fetch.js -- extract typo->correction pairs from client9/misspell's
// `DictMain` block into pairs.tsv.gz, and copy the upstream MIT
// LICENSE verbatim alongside so the notice travels with the
// derived data.
//
// Sibling fetcher: fixture-src/rewriters/british/fetch.js handles
// the DictAmerican + DictBritish locale-conversion blocks. Both
// fetchers share the Go-literal parser at
// fixture-src/rewriters/_lib/client9-misspell-parser.js.
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
// AND the sibling british/fetch.js. Upstream was archived 2025-03-26,
// so the data is frozen and an upgrade pull is currently a no-op;
// the path is documented to keep open the option if a fork resumes
// maintenance.
//
// License (MIT): the upstream LICENSE is copied verbatim to
// fixture-src/rewriters/typos/LICENSE alongside pairs.tsv.gz so the
// MIT permission notice physically travels with the derivative data
// (MIT clause: "The above copyright notice and this permission
// notice shall be included in all copies or substantial portions of
// the Software"). The sibling british/fetch.js vendors its own copy
// for the same reason. A user-facing entry is maintained in
// attributions.html.
//
// Pipeline:
//
//   ../misspell/words.go      Go source, DictMain block only
//        |
//        v
//   parser (_lib)             brace-matched extraction of DictMain;
//        |                    consecutive (wrong, correct) string
//        |                    pairs in declaration order
//        v
//   sort + dedupe             stable sort by (wrong, correct);
//        |                    drop byte-identical duplicates
//        v
//   pairs.tsv.gz              one pair per line, tab-separated:
//                               <wrong>\t<correct>
//                             No source-tag column: all rows here
//                             are DictMain.
//
//   ../misspell/LICENSE  -->  fixture-src/rewriters/typos/LICENSE
//                             copied verbatim, byte-for-byte.
//
// Anyone re-running this script should see deterministic output: the
// sort order is total and the upstream is archived. A diff against
// the committed pairs.tsv.gz / LICENSE that shows any change implies
// upstream moved (post-archive fork) or this script's parser changed.

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
  const pairs  = extractBlockPairs(source, 'DictMain');
  process.stderr.write(`fetch.js: DictMain -> ${pairs.length} pairs\n`);

  pairs.sort((a, b) =>
       a[0] < b[0] ? -1 : a[0] > b[0] ? 1
     : a[1] < b[1] ? -1 : a[1] > b[1] ? 1
     : 0);

  const lines = [];
  let prev = null;
  for (const [wrong, correct] of pairs) {
    const line = `${wrong}\t${correct}`;
    if (line === prev) continue;
    lines.push(line);
    prev = line;
  }
  const deduped = pairs.length - lines.length;
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
