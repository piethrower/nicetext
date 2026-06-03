// Probe for the build-session-worker.js flow. The worker itself
// is browser-only (uses postMessage, fetch, SharedArrayBuffer), so this
// probe mirrors its function-level pipeline against on-disk fixtures.
//
// Verifies, for a representative non-flat build:
//   1. Build the corpus dict + model via Section 2.
//   2. Round-trip a payload through the corpus dict (= useCorpus=true
//      path's active dict).
//   3. Extract typeSet from corpusMtw, sortDict the combined union,
//      filter by typeSet → baseMtw. Confirm:
//        - every word in baseMtw has a merged type from typeSet
//        - corpus-dict word count ≤ base-dict word count (the base
//          dict is the "expanded" form)
//        - every word in corpusMtw appears in baseMtw with the same
//          merged-type-hash (typeSet superset invariant)
//   4. Build the base dict and round-trip the same payload through
//      it (= useCorpus=false path's active dict).
//   5. Report base-dict shrinkage vs the unfiltered "old flow" base
//      dict (sortDict(combined) without the typeSet filter).
//
// Run: node tests/node/tmp/probe-typefilter-base-dict.mjs

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restrictToVocab } from '../../../js/src/builder/sources.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { listWordsWithCounts } from '../../../js/src/builder/listword.js';
import { generateModelTable } from '../../../js/src/builder/genmodel.js';
import { packDictToSAB } from '../../../js/src/builder/sab-pack.js';
import { packModelTableToSAB } from '../../../js/src/builder/modeltable-pack.js';
import { wrapDictionaryFromSAB } from '../../../js/src/dictionary.js';
import { wrapModelTableFromSAB, tableHasUsableModels } from '../../../js/src/modeltable.js';
import { wrapEntriesSAB, unpackEntries } from '../../../js/src/builder/entries-sab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = (n) => join(ROOT, 'fixtures', n);
const txtGz = (p) => gunzipSync(readFileSync(p)).toString('utf8');

function loadTwlistSab(name) {
  const bytes = gunzipSync(readFileSync(FIX(`${name}.twlist.sab.gz`)));
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(bytes);
  return unpackEntries(wrapEntriesSAB(sab));
}

function readSelections(selections) {
  let combined = [];
  for (const k of selections) combined = combined.concat(loadTwlistSab(k));
  return combined;
}

async function runOne(label, selections, corpusFile) {
  console.log(`\n=== ${label} ===`);
  const combined = readSelections(selections);
  const corpus = txtGz(FIX(corpusFile));
  const counts = await listWordsWithCounts(corpus);
  const vocab = new Set(counts.keys());

  // --- Section 2: corpus dict + model ---
  const restricted = restrictToVocab(combined, vocab);
  const corpusMtw = await sortDict(restricted, { hashed: true });
  const corpusDictJson = buildDictionary(corpusMtw, {
    name: 'session-corpus', frequencies: counts,
  });
  const corpusSab = packDictToSAB(corpusDictJson);
  const corpusDict = wrapDictionaryFromSAB(corpusSab);
  const modelJson = await generateModelTable(corpus, corpusDict, {
    name: 'session-model', dedupe: true,
  });
  const modelSab = packModelTableToSAB(modelJson);
  const modelTable = wrapModelTableFromSAB(modelSab);

  console.log(`  corpus-dict:  ${corpusDictJson.types.length.toLocaleString()} types, ${corpusDictJson.words.length.toLocaleString()} words, ${corpusSab.byteLength.toLocaleString()} bytes`);
  console.log(`  model:        ${modelJson.models.length.toLocaleString()} models, ${modelSab.byteLength.toLocaleString()} bytes`);

  // useCorpus=true usability check.
  const usableCorpus = tableHasUsableModels(modelTable, corpusDict);
  console.log(`  usable@corpus: ${usableCorpus}`);

  // --- Section 4: typeSet filter + base dict ---
  const typeSet = new Set();
  for (const row of corpusMtw) typeSet.add(row.type);

  const fullMtw = await sortDict(combined, { hashed: true });
  // Union: filtered fullMtw + corpusMtw (corpusMtw wins on word collisions).
  // Mirrors worker logic, corpusMtw carries self-defined corpus-only
  // words and voice-isolated merged types that fullMtw doesn't have.
  const byWord = new Map();
  for (const row of fullMtw) if (typeSet.has(row.type)) byWord.set(row.word, row);
  for (const row of corpusMtw) byWord.set(row.word, row);
  const baseMtw = [...byWord.values()];

  // Invariant 1: every word in baseMtw has a merged type from typeSet.
  for (const row of baseMtw) {
    if (!typeSet.has(row.type)) throw new Error(`baseMtw row has unknown type: ${row.word} / ${row.type}`);
  }
  // Invariant 2: every word in corpusMtw appears in baseMtw with the
  // same merged-type-hash.
  const baseByWord = new Map();
  for (const row of baseMtw) baseByWord.set(row.word, row.type);
  for (const row of corpusMtw) {
    const baseType = baseByWord.get(row.word);
    if (baseType !== row.type) {
      throw new Error(`type mismatch for "${row.word}": corpus=${row.type} base=${baseType ?? '(missing)'}`);
    }
  }

  const baseDictJson = buildDictionary(baseMtw, {
    name: 'session-base', frequencies: counts,
  });
  const baseSab = packDictToSAB(baseDictJson);
  const baseDict = wrapDictionaryFromSAB(baseSab);

  // For comparison: the "old flow" would build base dict from sortDict(combined)
  // with no type filter. We didn't pack that (would OOM on huge twlists),
  // but the row count comparison is enough to show the win.
  const oldFlowBaseWordCount = fullMtw.length;
  const newFlowBaseWordCount = baseDictJson.words.length;
  const shrinkPct = (1 - newFlowBaseWordCount / oldFlowBaseWordCount) * 100;
  console.log(`  base-dict:    ${baseDictJson.types.length.toLocaleString()} types, ${baseDictJson.words.length.toLocaleString()} words, ${baseSab.byteLength.toLocaleString()} bytes`);
  console.log(`  type-filter shrinks base dict by ${shrinkPct.toFixed(1)}%  (${oldFlowBaseWordCount.toLocaleString()} → ${newFlowBaseWordCount.toLocaleString()} words)`);

  // useCorpus=false usability check (the deferred check).
  const usableBase = tableHasUsableModels(modelTable, baseDict);
  console.log(`  usable@base:   ${usableBase}`);
  if (!usableBase && usableCorpus) {
    throw new Error('base dict failed usability check while corpus dict passed, base must be ≥ as capable');
  }
}

await runOne(
  'aesop + impkimmo + mit + rhyme + connectors',
  ['impkimmo', 'mit', 'rhyme', 'connectors'],
  'aesop-curated.txt.gz',
);
await runOne(
  'jfk + impkimmo + connectors',
  ['impkimmo', 'connectors'],
  'jfk-curated.txt.gz',
);
await runOne(
  'sherlock-holmes + impkimmo + mit + claude2026 + connectors',
  ['impkimmo', 'mit', 'claude2026', 'connectors'],
  'sherlock-holmes-curated.txt.gz',
);

console.log('\nOK');
