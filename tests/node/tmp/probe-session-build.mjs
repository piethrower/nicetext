// Smoke for the session-base-dictionary pipeline. Mirrors what
// js/src/worker/build-session-worker.js does, minus fetch + postMessage.
// Loads fixtures off disk, runs sortDict + buildDictionary + packDictToSAB,
// optionally restrictToVocab + buildDictionary(frequencies),
// generateModelTable + packModelTableToSAB. Asserts the result is wrappable.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restrictToVocab } from '../../../js/src/builder/sources.js';
import { applyVowelAugmentation } from '../_aug-helpers.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { listWordsWithCounts } from '../../../js/src/builder/listword.js';
import { generateModelTable } from '../../../js/src/builder/genmodel.js';
import { packDictToSAB } from '../../../js/src/builder/sab-pack.js';
import { packModelTableToSAB } from '../../../js/src/builder/modeltable-pack.js';
import { wrapDictionaryFromSAB, lookupWord } from '../../../js/src/dictionary.js';
import { wrapModelTableFromSAB } from '../../../js/src/modeltable.js';
import { readJsonMaybeGz, readTwlistMaybeGz } from '../_helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = (n) => join(ROOT, 'fixtures', n);
const txtGz = (p) => gunzipSync(readFileSync(p)).toString('utf8');

const ranges = readJsonMaybeGz(FIX('content-ranges.json.gz'));

function sliceCorpus(text, basename) {
  const r = ranges[basename];
  if (!r) return text;
  return text.split('\n').slice(r.startLine - 1, r.endLine).join('\n');
}

function buildBase(selections, vowelAug) {
  const map = {
    impf2p: 'impf2p.twlist.tsv.gz',
    impkimmo: 'impkimmo.twlist.tsv.gz',
    mit: 'expandedmitlist.twlist.tsv.gz',
    numeric: 'numeric.twlist.tsv.gz',
    rhyme: 'rhyme.twlist.tsv.gz',
    claude2026: 'claude2026.twlist.tsv.gz',
    connectors: 'connectors.twlist.tsv.gz',
  };
  let combined = [];
  for (const k of selections) combined = combined.concat(readTwlistMaybeGz(FIX(map[k])));
  if (vowelAug) combined = applyVowelAugmentation(combined);
  const dictJson = buildDictionary(sortDict(combined), { name: 'session-base' });
  const sab = packDictToSAB(dictJson);
  return { combined, dictJson, sab };
}

// Case 1: Flat (base only, three sources, no vowel-aug).
{
  const { dictJson, sab } = buildBase(['mit', 'numeric', 'connectors'], false);
  const wrapped = wrapDictionaryFromSAB(sab);
  // Pick a known word from connectors and confirm it round-trips.
  const got = lookupWord(wrapped, 'all');
  if (!got) throw new Error('flat: expected "all" in dict');
  console.log('flat:', dictJson.types.length, 'types,', dictJson.words.length, 'words,', sab.byteLength, 'SAB bytes,', got.bits, 'bits for "all"');
}

// Case 2: Aesop, Use Corpus = on.
{
  const { combined } = buildBase(['impf2p', 'impkimmo', 'mit', 'numeric', 'rhyme', 'claude2026', 'connectors'], true);
  const corpus = sliceCorpus(txtGz(FIX('aesop.txt.gz')), 'aesop.txt');
  const counts = listWordsWithCounts(corpus);
  const restricted = restrictToVocab(combined, new Set(counts.keys()));
  const corpusJson = buildDictionary(sortDict(restricted), { name: 'session-corpus-aesop', frequencies: counts });
  const corpusSab = packDictToSAB(corpusJson);
  const wrapped = wrapDictionaryFromSAB(corpusSab);
  const modelJson = generateModelTable(corpus, wrapped, { name: 'session-model-aesop', dedupe: true });
  const modelSab = packModelTableToSAB(modelJson);
  wrapModelTableFromSAB(modelSab);
  console.log('aesop+corpus:', corpusJson.types.length, 'types,', corpusJson.words.length, 'words,',
              corpusSab.byteLength, 'corpus-SAB bytes,', modelJson.models.length, 'models,', modelSab.byteLength, 'model-SAB bytes');
}

// Case 3: JFK, Use Corpus = off (model built against base dict).
{
  const { combined, sab: baseSab } = buildBase(['impkimmo', 'connectors'], true);
  const corpus = sliceCorpus(txtGz(FIX('jfk.txt.gz')), 'jfk.txt');
  const wrapped = wrapDictionaryFromSAB(baseSab);
  const modelJson = generateModelTable(corpus, wrapped, { name: 'session-model-jfk', dedupe: false });
  const modelSab = packModelTableToSAB(modelJson);
  wrapModelTableFromSAB(modelSab);
  console.log('jfk+nocorpus:', modelJson.models.length, 'models,', modelSab.byteLength, 'model-SAB bytes (ordered=' + modelJson.ordered + ')');
}

console.log('\nOK');
