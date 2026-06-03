#!/usr/bin/env node
// build-redacted-wlist.js: concatenate the wlist sources under
// fixture-src/wlist/redacted/ into a single native intermediate at
// fixtures/redacted.wlist.txt.gz. `sab pack wlist` (called later in
// build-all-fixtures.js) compiles the native into the runtime SAB
// fixture at fixtures/redacted.wlist.sab.gz.
//
// Concat rules:
//   - Read every *.wlist file in fixture-src/wlist/redacted/.
//   - Drop blank lines and any line starting with '#' (comments).
//   - Lowercase, whitespace-trim each entry.
//   - Dedupe globally across all source files.
//   - Sort alphabetically.
//
// Single-word and multi-word entries share the file; consumers
// (precleanCorpus rule, twlist gate, runtime custom-corpus filter)
// handle phrases via greedy longest-first matching.
//
// Headers / license attribution / framing prose in the source files
// live for human readers; they do not ride into the runtime fixture.
//
// Browser-safe core does not run this; CLI-only.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, constants as Z } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const SRC  = join(REPO, 'fixture-src', 'wlist', 'redacted');
const OUT  = join(REPO, 'fixtures', 'redacted.wlist.txt.gz');

const sources = readdirSync(SRC).filter(f => f.endsWith('.wlist')).sort();
if (sources.length === 0) {
  process.stderr.write(`build-redacted-wlist: no *.wlist sources in ${SRC}\n`);
  process.exit(1);
}

const seen = new Set();
const perSourceCount = [];
for (const f of sources) {
  const text = readFileSync(join(SRC, f), 'utf8');
  let kept = 0;
  for (const raw of text.split('\n')) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (w.startsWith('#')) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    kept++;
  }
  perSourceCount.push({ name: f, kept });
}

const entries = [...seen].sort();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, gzipSync(entries.join('\n') + '\n', { level: Z.Z_BEST_COMPRESSION }));

for (const { name, kept } of perSourceCount) {
  process.stderr.write(`  ${name}: ${kept} entries\n`);
}
process.stderr.write(`wrote ${OUT.replace(REPO + '/', '')} (${entries.length} unique entries from ${sources.length} sources)\n`);
