// probe-merged-typelen.mjs: measure the length distribution of
// sortDict-merged type-name strings across all fourteen TW-list sources
// folded together (no augs, no emoji). Just the union → sortDict, look
// at how many unique words end up with merged-type strings that exceed
// the sab-pack u16 ceiling (65,535 bytes).

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTwlistLines } from '../../../js/src/builder/sources.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = (n) => join(ROOT, 'fixtures', n);

const SOURCES = [
  'impf2p.twlist.tsv.gz',
  'impkimmo.twlist.tsv.gz',
  'mit.twlist.tsv.gz',
  'numeric.twlist.tsv.gz',
  'rhyme.twlist.tsv.gz',
  'claude2026.twlist.tsv.gz',
  'connectors.twlist.tsv.gz',
  'moby-pos.twlist.tsv.gz',
  'moby-thesaurus.twlist.tsv.gz',
  'wordnet.twlist.tsv.gz',
  'wordnet-synonyms.twlist.tsv.gz',
  'emoji16.twlist.tsv.gz',
  'emoji-curated-phrases-16.twlist.tsv.gz',
  'emoji-cldr-names-16.twlist.tsv.gz',
];

let entries = [];
for (const f of SOURCES) {
  const text = gunzipSync(readFileSync(FIX(f))).toString('utf8');
  const arr = parseTwlistLines(text);
  process.stderr.write(`  ${f.padEnd(28)} ${arr.length.toLocaleString()}\n`);
  entries = entries.concat(arr);
}
process.stderr.write(`combined: ${entries.length.toLocaleString()}\n`);

const t0 = Date.now();
const d0 = sortDict(entries);
process.stderr.write(`sortDict: ${d0.length.toLocaleString()} unique words in ${((Date.now() - t0)/1000).toFixed(1)}s\n`);

// Length distribution + top-20 worst.
const lens = d0.map(e => ({ word: e.word, len: e.type.length }));
lens.sort((a, b) => b.len - a.len);

let sum = 0, max = 0, over32k = 0, over64k = 0;
for (const e of lens) {
  sum += e.len; if (e.len > max) max = e.len;
  if (e.len > 32 * 1024) over32k++;
  if (e.len > 64 * 1024) over64k++;
}
process.stderr.write(`type-name lengths: max=${max.toLocaleString()} mean=${(sum/lens.length).toFixed(1)}\n`);
process.stderr.write(`>32KB: ${over32k.toLocaleString()}, >64KB: ${over64k.toLocaleString()}\n`);

process.stderr.write(`\ntop 20 worst (word: type-string-bytes):\n`);
for (const e of lens.slice(0, 20)) {
  process.stderr.write(`  ${e.word.padEnd(20)} ${e.len.toLocaleString()}\n`);
}
