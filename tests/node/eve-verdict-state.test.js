// Verdict-state primitive: initial state, quiet promotion, agreement,
// reversal, and abstention. Step 1 of the verdict meta-rule refactor.
//
// Runs in both node and browser via the shim imports.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { createVerdictState, applyRule } from '../../js/src/eve/verdict-state.js';

test('initial state is unknown with no rule attribution', () => {
  const s = createVerdictState('augment.wordsIntoEmoji');
  assert.equal(s.knob, 'augment.wordsIntoEmoji');
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.rule, null);
  assert.equal(s.confidence, 0);
  assert.equal(s.contradiction, false);
  assert.deepEqual(s.history, []);
});

test('quiet promotion: unknown -> likely records rule and history', () => {
  const s = createVerdictState('augment.wordsIntoEmoji');
  applyRule(s, {
    rule: 'emoji-glyph-present',
    verdict: 'likely',
    confidence: 0.95,
    why: 'emoji glyph present in suspected',
  });
  assert.equal(s.verdict, 'likely');
  assert.equal(s.rule, 'emoji-glyph-present');
  assert.equal(s.confidence, 0.95);
  assert.equal(s.contradiction, false);
  assert.equal(s.history.length, 1);
  assert.deepEqual(s.history[0], {
    rule: 'emoji-glyph-present',
    from: 'unknown',
    to: 'likely',
    why: 'emoji glyph present in suspected',
    confidence: 0.95,
  });
});

test('quiet promotion: unknown -> unlikely', () => {
  // augment.vowel was the original example; replaced with tieBreak
  // (also a valid knob name) after the vowel-aug retirement.
  const s = createVerdictState('tieBreak');
  applyRule(s, { rule: 'tiebreak-signal-absent', verdict: 'unlikely', confidence: 0.7 });
  assert.equal(s.verdict, 'unlikely');
  assert.equal(s.rule, 'tiebreak-signal-absent');
  assert.equal(s.contradiction, false);
});

test('agreement keeps first-firing rule, raises confidence to max', () => {
  const s = createVerdictState('sources.foo');
  applyRule(s, { rule: 'first-hit', verdict: 'likely', confidence: 0.6 });
  applyRule(s, { rule: 'second-hit', verdict: 'likely', confidence: 0.8 });
  assert.equal(s.verdict, 'likely');
  assert.equal(s.rule, 'first-hit', 'attribution stays on first-firing rule');
  assert.equal(s.confidence, 0.8, 'confidence rises to max of the two');
  assert.equal(s.contradiction, false);
  assert.equal(s.history.length, 2);
});

test('agreement with lower confidence does not lower the recorded confidence', () => {
  const s = createVerdictState('sources.foo');
  applyRule(s, { rule: 'first-hit', verdict: 'likely', confidence: 0.9 });
  applyRule(s, { rule: 'second-hit', verdict: 'likely', confidence: 0.5 });
  assert.equal(s.confidence, 0.9);
});

test('reversal sets contradiction and moves attribution to the reverser', () => {
  const s = createVerdictState('story.style.aesop');
  applyRule(s, { rule: 'shape-overlap', verdict: 'likely', confidence: 0.8, why: '80% shape match' });
  applyRule(s, { rule: 'must-literal-mismatch', verdict: 'unlikely', confidence: 0.9, why: 'suspected word X not in corpus' });
  assert.equal(s.verdict, 'unlikely');
  assert.equal(s.rule, 'must-literal-mismatch');
  assert.equal(s.confidence, 0.9);
  assert.equal(s.contradiction, true);
  assert.equal(s.history.length, 2);
  assert.equal(s.history[1].from, 'likely');
  assert.equal(s.history[1].to, 'unlikely');
});

test('abstention (incoming unknown) is a no-op even after a prior verdict', () => {
  const s = createVerdictState('frequencies.norvig');
  applyRule(s, { rule: 'zipf-fit', verdict: 'likely', confidence: 0.6 });
  applyRule(s, { rule: 'sample-too-small', verdict: 'unknown', confidence: 0 });
  assert.equal(s.verdict, 'likely');
  assert.equal(s.rule, 'zipf-fit');
  assert.equal(s.history.length, 1, 'abstaining rule does not enter history');
});

test('abstention on a fresh state is a no-op', () => {
  const s = createVerdictState('phrases');
  applyRule(s, { rule: 'no-shape-data', verdict: 'unknown' });
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.rule, null);
  assert.equal(s.history.length, 0);
});

test('invalid incoming verdict throws', () => {
  const s = createVerdictState('augment.maxEmojiCluster');
  assert.throws(() => applyRule(s, { rule: 'bogus', verdict: 'maybe' }), /invalid verdict/);
});

test('missing rule identifier throws', () => {
  const s = createVerdictState('augment.maxEmojiCluster');
  assert.throws(() => applyRule(s, { verdict: 'likely', confidence: 0.5 }), /rule is required/);
});
