// probe-eiw-flood.mjs: pre-emit fanout walk for the eiw + wie augs at
// mix=7 ("Flood" preset) with every available TW-list source folded in.
//
// Mirrors what build-session-worker.js would do for a UI build that has
// every chip checked + Common Phrases + Emoji Style: Flood. Loads the
// fixtures off disk, runs runAugsPacked with diagnose=true so the
// per-aug fanout report (target-types/(E,k), tuple count, planned
// emits) lands on stderr before the SAB grow loop allocates anything.
// Then lets the actual emit phase run so we can see whether/where it
// OOMs at this scale.
//
// Run: node tests/node/tmp/probe-eiw-flood.mjs

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTwlistLines } from '../../../js/src/builder/sources.js';
import { runAugsPacked } from '../../../js/src/builder/aug-pipeline.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { packDictToSAB } from '../../../js/src/builder/sab-pack.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = (n) => join(ROOT, 'fixtures', n);

// All TW-list sources the session-base UI exposes, plus the two phrase
// fixtures bundled under "Common Phrases" and the emoji16 set.
const TWLIST_SOURCES = [
  'impf2p',
  'impkimmo',
  'mit',
  'numeric',
  'rhyme',
  'claude2026',
  'connectors',
  'moby-pos',
  'moby-thesaurus',
  'wordnet',
  'wordnet-synonyms',
  'emoji16',
  'emoji-curated-phrases-16',
  'emoji-cldr-names-16',
];

const FIXTURE_FILES = {
  impf2p:                 'impf2p.twlist.tsv.gz',
  impkimmo:               'impkimmo.twlist.tsv.gz',
  mit:                    'mit.twlist.tsv.gz',
  numeric:                'numeric.twlist.tsv.gz',
  rhyme:                  'rhyme.twlist.tsv.gz',
  claude2026:             'claude2026.twlist.tsv.gz',
  connectors:             'connectors.twlist.tsv.gz',
  'moby-pos':                'moby-pos.twlist.tsv.gz',
  'moby-thesaurus':               'moby-thesaurus.twlist.tsv.gz',
  wordnet:                'wordnet.twlist.tsv.gz',
  'wordnet-synonyms':             'wordnet-synonyms.twlist.tsv.gz',
  emoji16:                'emoji16.twlist.tsv.gz',
  ['emoji-curated-phrases-16']:   'emoji-curated-phrases-16.twlist.tsv.gz',
  ['emoji-cldr-names-16']:    'emoji-cldr-names-16.twlist.tsv.gz',
};

function loadTwlist(key) {
  const file = FIX(FIXTURE_FILES[key]);
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  return parseTwlistLines(text);
}

function loadJsonGz(name) {
  return JSON.parse(gunzipSync(readFileSync(FIX(name))).toString('utf8'));
}

function logMem(label) {
  const m = process.memoryUsage();
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  process.stderr.write(
    `[mem ${label}] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ` +
    `arrayBuffers=${mb(m.arrayBuffers)}MB external=${mb(m.external)}MB\n`,
  );
}

async function main() {
  process.stderr.write('=== probe-eiw-flood: load fixtures ===\n');
  let entries = [];
  for (const k of TWLIST_SOURCES) {
    const arr = loadTwlist(k);
    process.stderr.write(`  ${k.padEnd(20)} ${arr.length.toLocaleString()} entries\n`);
    entries = entries.concat(arr);
  }
  process.stderr.write(`  combined: ${entries.length.toLocaleString()} entries\n`);
  // sortDict pre-collapse is now done inside runAugsPacked itself; the
  // probe passes raw concatenated entries and lets the production path
  // do the work, so the diagnose output reflects what real builds see.

  process.stderr.write('=== load CLDR + curated keywords ===\n');
  const cldr = loadJsonGz('emoji16.cldr.json.gz');
  process.stderr.write(`  cldr keys: ${Object.keys(cldr).length.toLocaleString()}\n`);

  const curatedTxt = gunzipSync(readFileSync(FIX('emoji16.curated-keywords.tsv.gz'))).toString('utf8');
  const curatedEntries = parseTwlistLines(curatedTxt);
  const curatedKeywords = new Set(curatedEntries.map(e => e.word));
  process.stderr.write(`  curated keywords: ${curatedKeywords.size.toLocaleString()}\n`);

  logMem('pre-aug');

  process.stderr.write('=== runAugsPacked (vowel + eiw + wie, mix=7, diagnose=true) ===\n');
  const t0 = Date.now();
  let lastTickPerAug = new Map();
  // Hashed-merged-types path: shared hashMap captures both layers (the
  // pre-collapse sortDict inside runAugsPacked plus the final sortDict
  // below). Mirrors the production byos-build flow at hashedMergedTypes:true.
  const hashMap = new Map();
  try {
    const out = await runAugsPacked(entries, ['vowel', 'eiw', 'wie'], {
      cldr,
      curatedKeywords,
      mix: 7,
      useWorkers: false,
      diagnose: true,
      hashed: true,
      hashMap,
      onProgress: (e) => {
        if (e.phase === 'aug-progress') {
          const prev = lastTickPerAug.get(e.augKind) || 0;
          // Only report every ~500K to keep stderr readable.
          if (e.emitted - prev >= 500_000) {
            lastTickPerAug.set(e.augKind, e.emitted);
            process.stderr.write(`  iter${e.iter} ${e.augKind}: ${e.emitted.toLocaleString()} emitted\n`);
          }
        } else if (e.phase === 'aug-done') {
          process.stderr.write(`  iter${e.iter} ${e.augKind}: DONE ${e.emitted.toLocaleString()} entries\n`);
          lastTickPerAug.set(e.augKind, 0);
        } else if (e.phase === 'aug-iter') {
          process.stderr.write(`  iter${e.iter} TOTAL emitted across augs: ${e.total.toLocaleString()}\n`);
        }
      },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`=== runAugsPacked: SUCCESS in ${dt}s, ${out.length.toLocaleString()} entries ===\n`);
    logMem('post-aug');

    // Mirror the session-base worker pipeline: sortDict → buildDictionary
    // → packDictToSAB. Reproduces the actual build that the user runs
    // from nicetext.html when they tick all chips + Flood.
    process.stderr.write('=== sortDict (final, on aug output) ===\n');
    const tSort = Date.now();
    const mtw = sortDict(out, { hashed: true, hashMap });
    process.stderr.write(`  hashMap entries: ${hashMap.size.toLocaleString()}\n`);
    process.stderr.write(
      `  mtwlist: ${mtw.length.toLocaleString()} unique words in ` +
      `${((Date.now() - tSort) / 1000).toFixed(1)}s\n`,
    );
    // Investigate type-name length distribution before sab-pack throws.
    let maxTypeLen = 0;
    let maxTypeWord = '';
    let over32k = 0;
    let over64k = 0;
    for (const e of mtw) {
      const len = e.type.length;
      if (len > maxTypeLen) { maxTypeLen = len; maxTypeWord = e.word; }
      if (len > 32 * 1024) over32k++;
      if (len > 64 * 1024) over64k++;
    }
    process.stderr.write(
      `  type-name lengths: max=${maxTypeLen.toLocaleString()} (word "${maxTypeWord}"), ` +
      `>32KB: ${over32k}, >64KB: ${over64k}\n`,
    );
    logMem('post-sortDict');

    process.stderr.write('=== buildDictionary ===\n');
    const tBuild = Date.now();
    const dict = buildDictionary(mtw, { name: 'flood-probe', tieBreak: 'prefer-shorter' });
    process.stderr.write(
      `  dict: ${dict.types.length.toLocaleString()} types, ` +
      `${dict.words.length.toLocaleString()} words in ` +
      `${((Date.now() - tBuild) / 1000).toFixed(1)}s\n`,
    );

    process.stderr.write('=== packDictToSAB ===\n');
    const tPack = Date.now();
    const sab = packDictToSAB(dict);
    process.stderr.write(
      `  sab: ${(sab.byteLength / 1e6).toFixed(0)} MB in ` +
      `${((Date.now() - tPack) / 1000).toFixed(1)}s\n`,
    );
    logMem('post-pack');
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`=== runAugsPacked: FAILED after ${dt}s ===\n`);
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
    if (err && err.stack) process.stderr.write(err.stack + '\n');
    logMem('at-failure');
    process.exitCode = 1;
  }
}

await main();
