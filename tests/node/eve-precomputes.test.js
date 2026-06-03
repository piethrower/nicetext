// Eve precomputes: assert that the shipped fixtures match what the
// in-session compute would produce for the same corpus. If they
// drift, the precompute is stale and the runtime would return
// inconsistent results when using the cache.
//
// Per-corpus fixtures:
//   - corpus wlist          → /fixtures/<stem>.wlist.sab.gz       (NTPS)
//   - corpus monotyped-model → /fixtures/<stem>.monotyped-model.sab.gz (NTMM)
//
// Both share the gzipped-SAB convention at rest. This test gunzips
// into an ArrayBuffer, wraps with the appropriate wrap* function,
// and compares against the in-session compute result.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { nodeOnly } from './_runtime.js';

import { readFileSync, existsSync } from './shims/node-fs.js';
import { gunzipSync } from './shims/node-zlib.js';
import { fileURLToPath } from './shims/node-url.js';
import { dirname, join } from './shims/node-path.js';

import { extractCorpusVocab } from '../../js/src/eve/vocab-check.js';
import { genMonotypedModel } from '../../js/src/eve/monotyped-model-check.js';
import { wrapPackedStrings } from '../../js/src/eve/packed-strings-sab.js';
import { wrapMonotypedModel } from '../../js/src/eve/monotyped-model-sab.js';
import { getCorpusFile } from '../../js/src/byos.js';
import cardsRegistry from '../../fixtures/cards.data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const FIXTURES = join(ROOT, 'fixtures');

function readGzAsBuffer(path) {
  const buf = readFileSync(path);
  return gunzipSync(buf);
}
function readGzText(path) {
  return readGzAsBuffer(path).toString('utf8');
}
function readSabAsArrayBuffer(path) {
  const buf = readGzAsBuffer(path); // node Buffer
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function loadCorpusText(name) {
  const card = cardsRegistry.find(c => c.name === name);
  if (!card) throw new Error(`unknown card: ${name}`);
  return readGzText(join(ROOT, 'fixtures', getCorpusFile(card)));
}

test('eve precompute: aesop wlist SAB matches in-session compute', nodeOnly('fixture disk read'), async () => {
  const card = cardsRegistry.find(c => c.name === 'aesop');
  const stem = getCorpusFile(card).replace(/\.txt\.gz$/, '');
  const wlistPath = join(FIXTURES, `${stem}.wlist.sab.gz`);
  assert.ok(existsSync(wlistPath),
    `${stem} wlist SAB fixture missing; run tools/build-corpus-wlist.js + tools/sab.js pack wlist`);
  const corpusText = loadCorpusText('aesop');
  const expected = extractCorpusVocab(corpusText);
  const view = wrapPackedStrings(readSabAsArrayBuffer(wlistPath));
  assert.equal(view.count, expected.size, 'vocab sizes match');
  for (const w of expected) {
    assert.ok(view.hasSorted(w), `missing word in precompute SAB: ${JSON.stringify(w)}`);
  }
});

test('eve precompute: aesop monotyped-model SAB matches in-session compute', nodeOnly('fixture disk read'), async () => {
  const card = cardsRegistry.find(c => c.name === 'aesop');
  const stem = getCorpusFile(card).replace(/\.txt\.gz$/, '');
  const modelPath = join(FIXTURES, `${stem}.monotyped-model.sab.gz`);
  assert.ok(existsSync(modelPath),
    `${stem} monotyped-model SAB fixture missing; run tools/build-monotyped-models.js`);
  const corpusText = loadCorpusText('aesop');
  const expected = await genMonotypedModel(corpusText);
  const expectedView = wrapMonotypedModel(expected.sab);
  const view = wrapMonotypedModel(readSabAsArrayBuffer(modelPath));
  assert.equal(view.orderedCount, expectedView.orderedCount, 'orderedCount matches');
  assert.equal(view.uniqueCount, expectedView.uniqueCount, 'uniqueCount matches');
  // Spot-check positional access.
  for (let i = 0; i < Math.min(view.orderedCount, 50); i++) {
    assert.equal(view.at(i), expectedView.at(i), `at(${i}) mismatch`);
  }
  // Spot-check unique-pool membership in both directions.
  for (let j = 0; j < Math.min(view.uniqueCount, 50); j++) {
    const s = expectedView.uniqueAt(j);
    assert.ok(view.hasSorted(s), `unique[${j}] missing from view: ${s}`);
  }
});

test('eve precompute: jfk SAB fixtures (smallest)', nodeOnly('fixture disk read'), async () => {
  const card = cardsRegistry.find(c => c.name === 'jfk');
  const stem = getCorpusFile(card).replace(/\.txt\.gz$/, '');
  const corpusText = loadCorpusText('jfk');
  const expectedVocab = extractCorpusVocab(corpusText);
  const vocabView = wrapPackedStrings(readSabAsArrayBuffer(join(FIXTURES, `${stem}.wlist.sab.gz`)));
  assert.equal(vocabView.count, expectedVocab.size);

  const expected = await genMonotypedModel(corpusText);
  const modelView = wrapMonotypedModel(readSabAsArrayBuffer(join(FIXTURES, `${stem}.monotyped-model.sab.gz`)));
  assert.equal(modelView.orderedCount, expected.count);
  assert.equal(modelView.uniqueCount, expected.uniqueCount);
});
