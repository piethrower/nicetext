#!/usr/bin/env node
// fixture-src/twlist/cmu-alliteration/derive.js, emit alliteration
// twlist rows from CMU. One type per starting phoneme (allit_K,
// allit_S, allit_TH, ...). Stress digits stripped. Words with multiple
// pronunciations contribute one row per distinct first-phoneme.
//
// Output: ./alliteration.twlist.gz

import { writeFileSync } from 'node:fs';
import { gzipSync, constants as Z } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCmuPronunciations, firstPhoneme } from '../../pron/cmu/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CMU  = join(HERE, '..', '..', 'pron', 'cmu', 'cmudict.dict.gz');
const OUT  = join(HERE, 'alliteration.twlist.gz');

const cmu = loadCmuPronunciations(CMU);
const rows = [];
const histogram = new Map();
for (const [word, prons] of cmu) {
  const seen = new Set();
  for (const p of prons) {
    const ph = firstPhoneme(p);
    if (!ph || seen.has(ph)) continue;
    seen.add(ph);
    rows.push(`allit_${ph}\t${word}`);
    histogram.set(ph, (histogram.get(ph) || 0) + 1);
  }
}
rows.sort();
const text = rows.join('\n') + '\n';
writeFileSync(OUT, gzipSync(text, { level: Z.Z_BEST_COMPRESSION }));

process.stderr.write(`wrote ${OUT}\n`);
process.stderr.write(`  ${rows.length} rows, ${cmu.size} CMU base words, ${histogram.size} distinct first-phonemes\n`);
const sorted = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
for (const [ph, c] of sorted) process.stderr.write(`  allit_${ph}: ${c} words\n`);
