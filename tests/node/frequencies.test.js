// Tests for js/src/builder/frequencies.js: verifies the §11.4 math
// with hand-computed cases plus a small end-to-end through buildDictionary
// to check the integer weights actually move Huffman codes the way the
// math says they should.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  parseFreqLines,
  combineFrequencies,
  wordCountsToFreqSource,
} from '../../js/src/builder/frequencies.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { sortDict } from '../../js/src/builder/sortdct.js';

test('parseFreqLines: header comments skipped, totals sum, blank-line tolerance', async () => {
  const text =
    '# title: foo\n' +
    '# attribution: bar\n' +
    '\n' +
    'alice\t10\n' +
    'bob\t20\n' +
    'carol\t1\n';
  const { totalTokens, counts } = parseFreqLines(text);
  assert.equal(totalTokens, 31);
  assert.equal(counts.size, 3);
  assert.equal(counts.get('alice'), 10);
  assert.equal(counts.get('bob'), 20);
  assert.equal(counts.get('carol'), 1);
});

test('parseFreqLines: malformed lines dropped, not fatal', async () => {
  const text = 'alice\t10\nnotabline\nbob\t-3\nempty\t\ngood\t5\n';
  const { totalTokens, counts } = parseFreqLines(text);
  assert.equal(totalTokens, 15); // 10 + 5
  assert.deepEqual([...counts.keys()].sort(), ['alice', 'good']);
});

test('combineFrequencies: single source, weight = round(p * 1e9), floor 1', async () => {
  // alice=10, bob=20, carol=70; total=100.
  // p(alice)=0.1 → 1e8; p(bob)=0.2 → 2e8; p(carol)=0.7 → 7e8.
  const f1 = parseFreqLines('alice\t10\nbob\t20\ncarol\t70\n');
  const w = combineFrequencies([f1]);
  assert.equal(w.get('alice'), 100_000_000);
  assert.equal(w.get('bob'), 200_000_000);
  assert.equal(w.get('carol'), 700_000_000);
});

test('combineFrequencies: skip-if-absent averaging across two sources', async () => {
  // f1: alice=10, bob=90 (total 100) → p(alice)=0.1, p(bob)=0.9
  // f2: alice=30, carol=70 (total 100) → p(alice)=0.3, p(carol)=0.7
  // Combined:
  //   alice present in both: avg(0.1, 0.3) = 0.2 → 2e8
  //   bob present in f1 only:     0.9            → 9e8
  //   carol present in f2 only:   0.7            → 7e8
  const f1 = parseFreqLines('alice\t10\nbob\t90\n');
  const f2 = parseFreqLines('alice\t30\ncarol\t70\n');
  const w = combineFrequencies([f1, f2]);
  assert.equal(w.get('alice'), 200_000_000);
  assert.equal(w.get('bob'), 900_000_000);
  assert.equal(w.get('carol'), 700_000_000);
});

test('combineFrequencies: tiny p floors to weight=1', async () => {
  // p < 1/SCALE → round to 0 → floored to 1 by max(1, ...).
  // Construct: total 1e12, count 1 → p = 1e-12, p*1e9 = 1e-3, round → 0 → 1.
  const src = { totalTokens: 1e12, counts: new Map([['rare', 1]]) };
  const w = combineFrequencies([src]);
  assert.equal(w.get('rare'), 1);
});

test('combineFrequencies: empty/zero-total sources ignored', async () => {
  const empty = { totalTokens: 0, counts: new Map() };
  const real = parseFreqLines('alice\t1\nbob\t1\n'); // total 2
  const w = combineFrequencies([empty, real]);
  // empty contributes nothing; real alone: p=0.5 each → 5e8.
  assert.equal(w.size, 2);
  assert.equal(w.get('alice'), 500_000_000);
  assert.equal(w.get('bob'), 500_000_000);
});

test('combineFrequencies: empty source list → empty Map', async () => {
  assert.equal(combineFrequencies([]).size, 0);
  assert.equal(combineFrequencies(null).size, 0);
});

test('wordCountsToFreqSource: corpus counts ride the same merge', async () => {
  // Pretend a corpus had alice=4, bob=1 (total 5).
  const wordCounts = new Map([['alice', 4], ['bob', 1]]);
  const corpusBlob = wordCountsToFreqSource(wordCounts);
  assert.equal(corpusBlob.totalTokens, 5);
  assert.equal(corpusBlob.counts, wordCounts); // same Map reference, no copy
  // Combined with an ext source where p is reversed: alice=1, bob=4 (total 5).
  // alice avg(0.8, 0.2) = 0.5 → 5e8; bob avg(0.2, 0.8) = 0.5 → 5e8.
  const ext = parseFreqLines('alice\t1\nbob\t4\n');
  const w = combineFrequencies([corpusBlob, ext]);
  assert.equal(w.get('alice'), 500_000_000);
  assert.equal(w.get('bob'), 500_000_000);
});

test('end-to-end: heavier weight gets shorter Huffman code in 3-word type', async () => {
  // 3-word type with weights 10/20/70 should give carol the 1-bit code
  // (weight-7 leaf vs subtree-of-{alice,bob}-weighing-3); alice and bob
  // get 2-bit codes. Today's no-frequency build instead gives the
  // alphabetically-last word (carol) the short code, which happens to
  // collide with the freq-weighted outcome here, so use weights where
  // freq disagrees with alpha to actually exercise weighting.
  // Make BOB heaviest: bob=70, alice=20, carol=10. Without frequencies,
  // alpha tie-break gives carol the 1-bit code. With frequencies, bob
  // should.
  const f = parseFreqLines('alice\t20\nbob\t70\ncarol\t10\n');
  const weights = combineFrequencies([f]);
  const mtw = await sortDict([
    { type: 'people', word: 'alice' },
    { type: 'people', word: 'bob' },
    { type: 'people', word: 'carol' },
  ]);
  const dict = buildDictionary(mtw, { name: 'probe', frequencies: weights });
  const byWord = new Map(dict.words.map(w => [w.word, w]));
  // bob is heaviest → should be at depth 1 (1 bit).
  assert.equal(byWord.get('bob').bits, 1);
  // alice and carol pair into the depth-2 subtree.
  assert.equal(byWord.get('alice').bits, 2);
  assert.equal(byWord.get('carol').bits, 2);
});

test('end-to-end: missing words fall back to weight=1 (uniform)', async () => {
  // 'sklerb' isn't in the freq map; dct2mstr's getWeight defaults to 1.
  // Make 'common' heavy so the weighting actually shows: common=1000,
  // both 'rare1' and 'sklerb' default to 1 → tie → pair up via alpha.
  const weights = new Map([['common', 1000]]);
  const mtw = await sortDict([
    { type: 't', word: 'common' },
    { type: 't', word: 'rare1' },
    { type: 't', word: 'sklerb' },
  ]);
  const dict = buildDictionary(mtw, { name: 'probe', frequencies: weights });
  const byWord = new Map(dict.words.map(w => [w.word, w]));
  // common is 1000× heavier → 1-bit code at root.
  assert.equal(byWord.get('common').bits, 1);
  // rare1 + sklerb pair into subtree → both 2-bit.
  assert.equal(byWord.get('rare1').bits, 2);
  assert.equal(byWord.get('sklerb').bits, 2);
});
