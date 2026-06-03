// Eve job handlers. Step 2 of the multi-worker scheduler arc.
// Each handler is a pure-compute function the orchestrator
// dispatches; these tests invoke them directly with synthetic
// inputs to validate the contract before the worker shell wraps
// them in Step 3.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  runSuspectedTokenScanJob,
  runIsNiceTextJob,
  runVocabCheckJob,
  runCorpusVocabCheckJob,
  runBuildSuspectedMonotypedModelJob,
  runMonotypedModelCheckCardJob,
} from '../../js/src/eve/job-handlers.js';
import { aggregateMonotypedModelVerdicts } from '../../js/src/eve/monotyped-model-check.js';
import { packStrings } from '../../js/src/eve/packed-strings-sab.js';
import { packMonotypedModel } from '../../js/src/eve/monotyped-model-sab.js';

function packSet(words) {
  return packStrings([...new Set(words)].sort());
}

test('suspected-token-scan: emoji-free suspected -> three unlikely verdicts', async () => {
  const suspected = 'The quick brown fox jumps over the lazy dog.';
  const out = await runSuspectedTokenScanJob({ suspectedText: suspected });
  assert.equal(out.verdicts.length, 3);
  const byKnob = new Map(out.verdicts.map(v => [v.knob, v]));
  assert.equal(byKnob.get('augment.wordsIntoEmoji').verdict, 'unlikely');
  assert.equal(byKnob.get('augment.wordsIntoEmoji').rule, 'no-emoji-after-full-scan');
  assert.equal(byKnob.get('augment.emojiIntoWords').verdict, 'unlikely');
  assert.equal(byKnob.get('augment.maxEmojiCluster').verdict, 'unlikely');
});

test('suspected-token-scan: one emoji -> wordsIntoEmoji likely', async () => {
  const suspected = 'The fox 🦊 jumps.';
  const out = await runSuspectedTokenScanJob({ suspectedText: suspected });
  const v = out.verdicts.find(x => x.knob === 'augment.wordsIntoEmoji');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'emoji-glyph-present');
});

test('is-nicetext: preclean-idempotent suspected -> likely', async () => {
  const suspected = ('Hello there friend, how are you today? '.repeat(20)).trim();
  const v = await runIsNiceTextJob({ suspectedText: suspected });
  assert.equal(v.knob, 'isNiceText');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
});

test('is-nicetext: curly apostrophe suspected -> unlikely (preclean changes bytes)', async () => {
  const suspected = ('don’t worry about it. '.repeat(40)).trim();
  const v = await runIsNiceTextJob({ suspectedText: suspected });
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'preclean-changed-bytes');
});

test('vocab-check: structural result keyed by TW-list name (SAB inputs)', () => {
  const suspected = 'the cat sat on the windward mat.';
  const sets = new Map([
    ['windy', packSet(['windward'])],
    ['empty', packSet(['quokka'])],
  ]);
  const out = runVocabCheckJob({ suspectedText: suspected, wlistsByKey: sets });
  assert.ok(out.totalUnique > 0);
  assert.equal(out.perTwlistCoverage.get('windy').hits, 1);
  assert.equal(out.perTwlistCoverage.get('empty').hits, 0);
});

test('corpus-vocab-check: all words present -> likely (SAB vocab)', () => {
  const suspectedUniqueWords = new Set(['the', 'cat', 'sat']);
  const vocabSab = packSet(['the', 'cat', 'sat', 'mat', 'on']);
  const v = runCorpusVocabCheckJob({
    suspectedUniqueWords, vocabSab, corpusName: 'fixture',
  });
  assert.equal(v.knob, 'story.vocabulary.fixture');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'corpus-vocab-superset');
  assert.equal(v.data.missing, 0);
});

test('corpus-vocab-check: missing words -> unlikely (SAB vocab)', () => {
  const suspectedUniqueWords = new Set(['the', 'cat', 'quokka', 'platypus']);
  const vocabSab = packSet(['the', 'cat']);
  const v = runCorpusVocabCheckJob({
    suspectedUniqueWords, vocabSab, corpusName: 'fixture',
  });
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'corpus-vocab-missing-words');
  assert.equal(v.data.missing, 2);
});

test('corpus-vocab-check: null vocabSab counts all as missing', () => {
  const suspectedUniqueWords = new Set(['x', 'y']);
  const v = runCorpusVocabCheckJob({
    suspectedUniqueWords, vocabSab: null, corpusName: 'gone',
  });
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.data.missing, 2);
});

test('build-suspected-shapes + aggregate: empty cards = empty verdicts', async () => {
  const buildOut = await runBuildSuspectedMonotypedModelJob({ suspectedText: 'Hello world.' });
  assert.equal(buildOut.totalSuspected, 1);
  const agg = aggregateMonotypedModelVerdicts([], buildOut.totalSuspected, {});
  assert.equal(agg.verdicts.length, 0);
});

test('monotyped-model-check-card + aggregate: too few suspected sentences -> all unknown', async () => {
  const buildOut = await runBuildSuspectedMonotypedModelJob({ suspectedText: 'One.' });
  const cardSab = packMonotypedModel(['Cap|g|^.\n^']);
  const stats = await runMonotypedModelCheckCardJob({
    suspectedMonotypedModelSab: buildOut.monotypedModelSab,
    card: {
      name: 'fake',
      monotypedModelSab: cardSab,
    },
  });
  const agg = aggregateMonotypedModelVerdicts([stats], buildOut.totalSuspected, {});
  const v = agg.verdicts.find(x => x.knob === 'story.style.fake');
  assert.equal(v.verdict, 'unknown');
  assert.equal(agg.verdicts.filter(x => x.knob === 'phrases').length, 0);
});
