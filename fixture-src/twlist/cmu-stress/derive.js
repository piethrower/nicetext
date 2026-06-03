#!/usr/bin/env node
// fixture-src/twlist/cmu-stress/derive.js: emit stress-pattern twlist
// rows from CMU. One type per stress sequence (stress_01 = iamb,
// stress_10 = trochee, stress_001 = anapest, stress_100 = dactyl, ...).
// Words with multiple pronunciations contribute one row per distinct
// stress pattern.
//
// Output: ./stress.twlist.gz

import { writeFileSync } from 'node:fs';
import { gzipSync, constants as Z } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCmuPronunciations, stressPattern } from '../../pron/cmu/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CMU  = join(HERE, '..', '..', 'pron', 'cmu', 'cmudict.dict.gz');
const OUT  = join(HERE, 'stress.twlist.gz');

const cmu = loadCmuPronunciations(CMU);
const rows = [];
const histogram = new Map();
for (const [word, prons] of cmu) {
  const seen = new Set();
  for (const p of prons) {
    const sp = stressPattern(p);
    if (!sp || seen.has(sp)) continue;
    seen.add(sp);
    rows.push(`stress_${sp}\t${word}`);
    histogram.set(sp, (histogram.get(sp) || 0) + 1);
  }
}
rows.sort();
const text = rows.join('\n') + '\n';
writeFileSync(OUT, gzipSync(text, { level: Z.Z_BEST_COMPRESSION }));

process.stderr.write(`wrote ${OUT}\n`);
process.stderr.write(`  ${rows.length} rows, ${cmu.size} CMU base words, ${histogram.size} distinct stress patterns\n`);
const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
process.stderr.write(`  top 15 patterns:\n`);
for (const [sp, c] of top) process.stderr.write(`    stress_${sp}: ${c} words\n`);
