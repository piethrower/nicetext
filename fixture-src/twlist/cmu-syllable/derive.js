#!/usr/bin/env node
// fixture-src/twlist/cmu-syllable/derive.js: emit syllable-count
// twlist rows from CMU. One type per syllable count (syl_1, syl_2,
// ...). Words with multiple pronunciations contribute one row per
// distinct syllable count (a few entries land in two buckets, e.g.
// "fire" = 1 or 2 syllables across CMU variants, both are valid).
//
// Output: ./syllable.twlist.gz (lowercase, tab-separated, gz'd)

import { writeFileSync } from 'node:fs';
import { gzipSync, constants as Z } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCmuPronunciations, syllableCount } from '../../pron/cmu/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CMU  = join(HERE, '..', '..', 'pron', 'cmu', 'cmudict.dict.gz');
const OUT  = join(HERE, 'syllable.twlist.gz');

const cmu = loadCmuPronunciations(CMU);
const rows = [];
const histogram = new Map();
for (const [word, prons] of cmu) {
  const counts = new Set();
  for (const p of prons) {
    const n = syllableCount(p);
    if (n > 0) counts.add(n);
  }
  for (const n of counts) {
    rows.push(`syl_${n}\t${word}`);
    histogram.set(n, (histogram.get(n) || 0) + 1);
  }
}
rows.sort();
const text = rows.join('\n') + '\n';
writeFileSync(OUT, gzipSync(text, { level: Z.Z_BEST_COMPRESSION }));

process.stderr.write(`wrote ${OUT}\n`);
process.stderr.write(`  ${rows.length} rows, ${cmu.size} CMU base words\n`);
const sortedHist = [...histogram.entries()].sort((a, b) => a[0] - b[0]);
for (const [n, c] of sortedHist) process.stderr.write(`  syl_${n}: ${c} words\n`);
