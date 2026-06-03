// Eve Phase I detector smoke tests. Synthetic suspecteds in, verdict
// table out. No decoding, no fixture loading from disk.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { tokenize } from '../../js/src/lexer.js';
import { runPhase1 } from '../../js/src/eve/core.js';
import {
  createWordsIntoEmojiCheck,
  createEmojiIntoWordsCheck,
  createMixedPhrasesCheck,
  createSourceCheck,
  createCustomCorpusCheck,
  createCustomTwlistCheck,
} from '../../js/src/eve/checks.js';
import { countCombinations } from '../../js/src/eve/combinations.js';
import { runIsNiceTextCheck } from '../../js/src/eve/preclean-check.js';
import {
  runVocabCheck,
  extractCorpusVocab,
} from '../../js/src/eve/vocab-check.js';

function findVerdict(result, knob) {
  return result.verdicts.find(v => v.knob === knob);
}

test('wordsIntoEmoji: emoji-free suspected -> unlikely, attribution to negative rule', async () => {
  const suspected = 'The quick brown fox jumps over the lazy dog.';
  const result = await runPhase1(tokenize(suspected), [createWordsIntoEmojiCheck()]);
  const v = findVerdict(result, 'augment.wordsIntoEmoji');
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'no-emoji-after-full-scan');
  assert.equal(v.contradiction, false);
  assert.equal(v.history.length, 1);
});

test('wordsIntoEmoji: one emoji -> likely, attribution to positive rule', async () => {
  const suspected = 'The quick brown fox 🦊 jumps.';
  const result = await runPhase1(tokenize(suspected), [createWordsIntoEmojiCheck()]);
  const v = findVerdict(result, 'augment.wordsIntoEmoji');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.done, true);
  assert.equal(v.rule, 'emoji-glyph-present');
  assert.equal(v.contradiction, false);
});

test('mixedPhrases: longest emoji-run tracked', async () => {
  const suspected = 'apple banana 🍎🍌 cherry 🍓🍓🍓 done.';
  const result = await runPhase1(tokenize(suspected), [createMixedPhrasesCheck()]);
  const v = findVerdict(result, 'augment.maxEmojiCluster');
  assert.match(v.why, /longest emoji-run = 3/);
});

test('mixedPhrases: no emoji -> unlikely with max=0, attribution', async () => {
  const suspected = 'plain text only no emoji here.';
  const result = await runPhase1(tokenize(suspected), [createMixedPhrasesCheck()]);
  const v = findVerdict(result, 'augment.maxEmojiCluster');
  assert.equal(v.verdict, 'unlikely');
  assert.match(v.why, /longest emoji-run = 0/);
  assert.equal(v.rule, 'no-emoji-runs-after-full-scan');
  assert.equal(v.contradiction, false);
});

test('sources: hit on first matching word -> likely, done, set-token-hit rule', async () => {
  const suspected = 'the cat sat on the windward mat.';
  const twlist = new Set(['windward']);
  const result = await runPhase1(
    tokenize(suspected),
    [createSourceCheck('toy', twlist)],
  );
  const v = findVerdict(result, 'sources.toy');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.done, true);
  assert.equal(v.rule, 'set-token-hit');
});

test('sources: budget reached with no hit -> unlikely, done, budget-exhausted rule', async () => {
  const suspected = ('the cat sat on the mat. '.repeat(5)).trim();
  const twlist = new Set(['quokka', 'platypus']);
  const result = await runPhase1(
    tokenize(suspected),
    [createSourceCheck('toy', twlist, { budget: 4 })],
  );
  const v = findVerdict(result, 'sources.toy');
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.done, true);
  assert.equal(v.rule, 'budget-exhausted-no-set-tokens');
});

test('isNiceText: preclean-idempotent suspected -> likely with preclean-idempotent rule', async () => {
  // A simple preclean-stable string: ASCII letters, single spaces,
  // standard punctuation. precleanCorpus collapses runs of
  // whitespace and normalizes apostrophes, so a single-spaced ASCII
  // sentence passes through unchanged.
  const suspected = ('Hello there friend, how are you today? '.repeat(20)).trim();
  const v = await runIsNiceTextCheck(suspected);
  assert.equal(v.knob, 'isNiceText');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
  assert.equal(v.contradiction, false);
});

test('isNiceText: preclean-changing suspected -> unlikely with preclean-changed-bytes rule', async () => {
  // Curly apostrophe (U+2019) gets normalized by precleanCorpus to
  // a straight apostrophe (U+0027), so the byte string changes
  // exactly once before stabilizing, a textbook preclean-changes
  // input that any real NiceText suspected would have already had
  // normalized at build time.
  const suspected = ('don’t worry about it. '.repeat(40)).trim();
  const v = await runIsNiceTextCheck(suspected);
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'preclean-changed-bytes');
  assert.equal(v.contradiction, false);
});

test('isNiceText: tiny slice -> unknown, no rule', async () => {
  const suspected = 'hi.';
  const v = await runIsNiceTextCheck(suspected, { minBytes: 1024 });
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.rule, null);
});

test('sources: under budget, no hit yet -> unknown, not done, no rule attribution', async () => {
  const suspected = 'cat dog.';
  const twlist = new Set(['quokka']);
  const result = await runPhase1(
    tokenize(suspected),
    [createSourceCheck('toy', twlist, { budget: 1000 })],
  );
  const v = findVerdict(result, 'sources.toy');
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.done, false);
  assert.equal(v.rule, null);
});

// Combination counter tests. Use two stub styles so expected counts
// are easy to derive in head. The emoji-intensity axis is now
// per-aug (was a single mixedPhrases axis): each of emojiIntoWords
// and wordsIntoEmoji independently carries an intensity 0..10. The
// only schema constraint is "intensity > 0 only when enabled = true",
// which the counter enforces (the off-branch contributes one tuple
// at intensity 0). With no verdicts:
//   ei=false,wi=false: 1 * 1   =   1
//   ei=false,wi=true:  1 * 11  =  11
//   ei=true ,wi=false: 11 * 1  =  11
//   ei=true ,wi=true:  11 * 11 = 121
//   total                       = 144
// Per non-flat style: 2 sentence * 2 vocabulary * 144 augment * 2
// tieBreak = 1152. Total for 2 styles, no verdicts = 2304.

const STYLES_2 = ['aesop', 'frankenstein'];

test('countCombinations: no verdicts -> full space across 2 stub styles', () => {
  const counts = countCombinations([], { styles: STYLES_2 });
  // See the math comment above. augCount = 144 per non-flat style.
  assert.equal(counts.augCount, 144);
  assert.equal(counts.total, 2304);
});

test('countCombinations: wordsIntoEmoji unlikely -> false only', () => {
  const verdicts = [{ knob: 'augment.wordsIntoEmoji', verdict: 'unlikely', why: 'x', done: false }];
  const counts = countCombinations(verdicts, { styles: STYLES_2 });
  // wi.enabled = [false]. wi_ints collapses to [0].
  //   ei=false,wi=false: 1 * 1  =  1
  //   ei=true ,wi=false: 11 * 1 = 11
  //   total                     = 12
  // Per style: 2*2*12*2 = 96. Total: 192.
  assert.equal(counts.augCount, 12);
  assert.equal(counts.total, 192);
});

test('countCombinations: maxEmojiCluster observed max=5 -> intensities in {5..10}', () => {
  const verdicts = [{
    knob: 'augment.maxEmojiCluster',
    verdict: 'unknown',
    why: 'longest emoji-run = 5',
    done: false,
    data: { max: 5 },
  }];
  const counts = countCombinations(verdicts, { styles: STYLES_2 });
  // Both intensities filtered to {5..10} = 6 values.
  //   ei=false,wi=false: 1 * 1   =  1
  //   ei=false,wi=true:  1 * 6   =  6
  //   ei=true ,wi=false: 6 * 1   =  6
  //   ei=true ,wi=true:  6 * 6   = 36
  //   total                       = 49
  // Per style: 2*2*49*2 = 392. Total: 784.
  assert.equal(counts.augCount, 49);
  assert.equal(counts.total, 784);
});

test('countCombinations: maxEmojiCluster max=0 + unlikely -> intensity=0 only', () => {
  const verdicts = [{
    knob: 'augment.maxEmojiCluster',
    verdict: 'unlikely',
    why: 'longest emoji-run = 0',
    done: false,
    data: { max: 0 },
  }];
  const counts = countCombinations(verdicts, { styles: STYLES_2 });
  // Both intensities collapse to [0]. All 4 enabled-pairs each
  // contribute exactly 1 tuple. augCount = 4. Per style:
  // 2*2*4*2 = 32. Total = 64.
  assert.equal(counts.augCount, 4);
  assert.equal(counts.total, 64);
});

test('countCombinations: flat style skips sentence/vocab axes', () => {
  const counts = countCombinations([], { styles: ['flat'] });
  // Flat: augCount * tieBreak only. 144 * 2 = 288.
  assert.equal(counts.total, 288);
});

test('countCombinations: 2 cards + flat = realistic premade space', () => {
  const styles = STYLES_2.concat(['flat']);
  const counts = countCombinations([], { styles });
  // 2 non-flat * 1152 = 2304; 1 flat * 288 = 288; total = 2592.
  assert.equal(counts.total, 2592);
});

test('countCombinations: combining detector verdicts narrows further', () => {
  const verdicts = [
    { knob: 'augment.wordsIntoEmoji', verdict: 'likely', why: 'x', done: true },
    { knob: 'augment.maxEmojiCluster', verdict: 'unknown', why: 'y', done: false,
      data: { max: 3 } },
  ];
  const counts = countCombinations(verdicts, { styles: STYLES_2 });
  // wi.enabled = [true]; both intensities filtered to {3..10} = 8.
  //   ei=false,wi=true: 1 * 8 =  8
  //   ei=true ,wi=true: 8 * 8 = 64
  //   total                    = 72
  // Per style: 2*2*72*2 = 576. Total: 1152.
  assert.equal(counts.augCount, 72);
  assert.equal(counts.total, 1152);
});

// isNiceText preclean-idempotency detector. Asymmetric: strong
// negative on preclean changes; weak positive on idempotency.

test('emojiIntoWords: no emoji -> unlikely (mirrors wordsIntoEmoji)', async () => {
  const suspected = 'Plain English text with no emoji here.';
  const result = await runPhase1(tokenize(suspected), [createEmojiIntoWordsCheck()]);
  const v = findVerdict(result, 'augment.emojiIntoWords');
  assert.equal(v.verdict, 'unlikely');
});

test('emojiIntoWords: emoji present -> likely (lower confidence than wordsIntoEmoji)', async () => {
  const suspected = 'A sentence with 🦊 in it.';
  const result = await runPhase1(tokenize(suspected), [createEmojiIntoWordsCheck()]);
  const v = findVerdict(result, 'augment.emojiIntoWords');
  assert.equal(v.verdict, 'likely');
  assert.match(v.why, /cannot disambiguate/);
});

test('customCorpus: hit -> likely with custom-corpus label', async () => {
  const suspected = 'the windward shore was distant.';
  const result = await runPhase1(tokenize(suspected), [createCustomCorpusCheck(new Set(['windward']))]);
  const v = findVerdict(result, 'customCorpus');
  assert.equal(v.verdict, 'likely');
  assert.match(v.why, /custom-corpus token hit/);
});

test('customTwlist: no hit after budget -> unlikely', async () => {
  const suspected = 'cat dog mouse fish';
  const result = await runPhase1(
    tokenize(suspected),
    [createCustomTwlistCheck(new Set(['quokka']), { budget: 3 })],
  );
  const v = findVerdict(result, 'customTwlist');
  assert.equal(v.verdict, 'unlikely');
  assert.match(v.why, /custom-TW-list/);
});

test('countCombinations: story.style unlikely verdicts drop those cards', () => {
  // 2 stub styles. Mark one as unlikely; counter should drop it
  // and report 1 style considered.
  const verdicts = [
    { knob: 'story.style.aesop', verdict: 'unlikely', why: 'low match', done: true },
  ];
  const counts = countCombinations(verdicts, { styles: ['aesop', 'frankenstein'] });
  assert.equal(counts.stylesConsidered, 1);
  assert.equal(counts.stylesIn, 2);
  // Per surviving style: 2*2*144*2 = 1152. 1 style: 1152.
  assert.equal(counts.total, 1152);
});

test('countCombinations: story.style likely verdicts keep cards alive', () => {
  // Marking a card 'likely' doesn't change the count vs no-verdict
  // case (it stays in the surviving styles list).
  const verdicts = [
    { knob: 'story.style.aesop', verdict: 'likely', why: 'high match', done: true },
  ];
  const counts = countCombinations(verdicts, { styles: ['aesop', 'frankenstein'] });
  assert.equal(counts.stylesConsidered, 2);
});

// Vocab check: stage 1 (per-twlist coverage), stage 2 (candidate
// combinations), must-literals.

test('vocab: 100% per-twlist coverage flagged', () => {
  const suspected = 'apple banana cherry';
  const twlists = new Map([
    ['fruits', new Set(['apple', 'banana', 'cherry', 'date'])],
    ['veggies', new Set(['carrot', 'potato'])],
  ]);
  const v = runVocabCheck(suspected, twlists);
  assert.equal(v.perTwlistCoverage.get('fruits').rate, 1);
  assert.equal(v.perTwlistCoverage.get('veggies').rate, 0);
  assert.equal(v.mustLiterals.length, 0);
});

test('vocab: must-literals when no twlist contains a word', () => {
  const suspected = 'apple banana mystery';
  const twlists = new Map([
    ['fruits', new Set(['apple', 'banana'])],
  ]);
  const v = runVocabCheck(suspected, twlists);
  assert.deepEqual(v.mustLiterals, ['mystery']);
});

test('vocab: candidate combination suspecteds all non-literal words', () => {
  const suspected = 'apple carrot grape';
  const twlists = new Map([
    ['fruits', new Set(['apple', 'grape'])],
    ['veggies', new Set(['carrot'])],
    ['proteins', new Set(['chicken'])],
  ]);
  const v = runVocabCheck(suspected, twlists);
  // No single twlist suspecteds everything; the combination
  // [fruits, veggies] would, but it's not a unique matchingtwlists
  // group (each word has size-1 matchingtwlists). So step 5 finds
  // zero size-2+ groups.
  assert.equal(v.candidateCombinations.length, 0);
  // But each individual word is covered by exactly one twlist:
  assert.equal(v.table.get('apple').size, 1);
  assert.equal(v.table.get('carrot').size, 1);
  assert.equal(v.table.get('grape').size, 1);
});

test('vocab: distinct matchingtwlist group as candidate', () => {
  const suspected = 'apple banana cherry';
  const twlists = new Map([
    ['fruits-a', new Set(['apple', 'banana', 'cherry'])],
    ['fruits-b', new Set(['apple', 'banana', 'cherry'])],
  ]);
  const v = runVocabCheck(suspected, twlists);
  // All words have matchingtwlists = {fruits-a, fruits-b}.
  // That's a single distinct group of size 2.
  assert.equal(v.candidateCombinations.length, 1);
  const c = v.candidateCombinations[0];
  assert.deepEqual(c.twlists, ['fruits-a', 'fruits-b']);
  assert.equal(c.coversAllNonLiterals, true);
});

test('extractCorpusVocab: tokenizes and lowercases', () => {
  const text = 'Hello WORLD. Hello again.';
  const v = extractCorpusVocab(text);
  assert.ok(v.has('hello'));
  assert.ok(v.has('world'));
  assert.ok(v.has('again'));
  assert.equal(v.size, 3); // hello, world, again (dedupe)
});

test('isNiceText: preclean-idempotent clean text -> likely', async () => {
  // Plain ASCII English, no control bytes, no confusables. Should
  // pass preclean unchanged.
  const suspected = ('The quick brown fox jumps over the lazy dog. '
    + 'A second sentence with simple punctuation. ').repeat(20);
  const v = await runIsNiceTextCheck(suspected);
  assert.equal(v.knob, 'isNiceText');
  assert.equal(v.verdict, 'likely');
});

test('isNiceText: text with control bytes -> unlikely', async () => {
  // Preclean rule 1 collapses non-printable code-point runs to a
  // single space. Embedding a NUL byte run forces a diff.
  const suspected = ('Hello world this is some text.   more text here. '.repeat(40));
  const v = await runIsNiceTextCheck(suspected);
  assert.equal(v.verdict, 'unlikely');
  assert.match(v.why, /preclean changed/);
});

test('isNiceText: empty or tiny slice -> unknown', async () => {
  const v = await runIsNiceTextCheck('hi.');
  assert.equal(v.verdict, 'unknown');
  assert.match(v.why, /slice too small/);
});

test('runPhase1 reports tokenCount and runs all detectors', async () => {
  const suspected = 'hello world 🦊.';
  const result = await runPhase1(tokenize(suspected), [
    createWordsIntoEmojiCheck(),
    createMixedPhrasesCheck(),
    createSourceCheck('toy', new Set(['hello'])),
  ]);
  assert.ok(result.tokenCount > 0);
  assert.equal(result.verdicts.length, 3);
  const knobs = result.verdicts.map(v => v.knob).sort();
  assert.deepEqual(knobs, [
    'augment.maxEmojiCluster',
    'augment.wordsIntoEmoji',
    'sources.toy',
  ]);
});
