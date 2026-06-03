// Reproduce the developer's report directly against the engine: run
// generateModelTable on the tiny 3-sentence corpus with the master
// (base) dict and inspect the resulting model table to find out why
// modelTableStream rejects it as having no bit-bearing slots.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadDictionary } from '../../../js/src/dictionary.js';
import { generateModelTable } from '../../../js/src/builder/genmodel.js';

const here = dirname(fileURLToPath(import.meta.url));
const dictPath = resolve(here, '../../../fixtures/master-1.dict.json.gz');
const dictJson = JSON.parse(gunzipSync(readFileSync(dictPath)).toString('utf8'));
const dict = loadDictionary(dictJson);

const CORPUS = 'This is my style.  I like my style.  My style rocks.';
const out = generateModelTable(CORPUS, dict, { name: 'tiny-test' });

console.log('typeNames count:', out.typeNames.length);
console.log('typeNames:', out.typeNames);
console.log('models count:', out.models.length);
for (const [i, m] of out.models.entries()) {
  console.log(`  [${i}] weight=${m.weight} tokens=${JSON.stringify(m.tokens)}`);
}
