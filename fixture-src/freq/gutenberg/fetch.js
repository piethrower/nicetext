#!/usr/bin/env node
// fetch.js -- rsync the English-only, single-language, bare-`.txt`
// subset of Project Gutenberg into raw/. The list of paths to fetch
// is built by list-english.js (run that first) into english-paths.txt.
// Many GB; raw/ is gitignored. The build pipeline
// (tools/build-freq-fixtures.js) walks raw/ and produces
// fixtures/gutenberg.freq.tsv.gz by tokenizing each book with the
// engine's lexer and intersecting with the active vocab pool.
//
// PG plain texts are public domain. The fixture drops PG header /
// footer boilerplate before counting.
//
// rsync output streams to fixture-src/freq/gutenberg/raw/rsync.log so a
// caller (or a periodic tail) can surface progress without blocking.
//
// English-only & single-version rationale:
//   - Multi-language books (e.g. English + Latin quotations) are excluded;
//     foreign-language tokens that happen to also be English words would
//     bias collision-word counts (`die`, `main`, `or`, ...).
//   - Encoding-variant alternatives (12345-0.txt UTF-8, 12345-8.txt
//     explicit Latin-1) are skipped: our lexer is ASCII-only so every
//     variant produces identical word counts after tokenization. Bare
//     `12345.txt` is the baseline.
//
// To regenerate english-paths.txt before refetch:
//     node fixture-src/freq/gutenberg/list-english.js
// To prune raw/ of files that no longer match the policy after a
// list refresh:
//     node fixture-src/freq/gutenberg/prune-raw.js

import { existsSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
// All workflow artifacts (logs, intermediate path lists) live inside
// raw/ so the gitignore on raw/ is the only exclusion rule needed.
const LOG = join(RAW, 'rsync.log');
const LIST = join(RAW, 'english-paths.txt');
mkdirSync(RAW, { recursive: true });

if (!existsSync(LIST)) {
  process.stderr.write(`missing ${LIST} -- run list-english.js first\n`);
  process.exit(1);
}

// PG primary mirror is aleph.gutenberg.org but it rate-limits / refuses
// long sessions and rapid reconnects. ibiblio is an official PG mirror
// (https://www.gutenberg.org/MIRRORS.ALL) that's been more reliable
// for bulk transfers in our experience. Either works; switch back if
// ibiblio falls behind PG's release cadence.
const SOURCE = 'ftp.ibiblio.org::gutenberg/';
// `-z` enables on-the-wire compression. Plain-text books gzip to
// 30-40% of their original size, so this nearly halves transfer time
// at the cost of marginal CPU on both ends. PG's rsync daemon
// supports it; on-disk files remain uncompressed.
const args = [
  '-avz',
  '--partial',
  '--info=progress2',
  '--no-motd',
  `--files-from=${LIST}`,
  SOURCE,
  RAW + '/'
];

process.stderr.write(`rsync ${SOURCE} -> ${RAW} (filter: ${LIST})\n`);
process.stderr.write(`log: ${LOG}\n`);

const fd = openSync(LOG, 'w');
const r = spawnSync('rsync', args, { stdio: ['ignore', fd, fd] });
if (r.status !== 0) {
  process.stderr.write(`rsync exited with status ${r.status}\n`);
  process.exit(r.status || 1);
}
process.stderr.write(`done; raw at ${RAW}\n`);
