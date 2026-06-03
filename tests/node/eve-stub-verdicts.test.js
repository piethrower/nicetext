// Honest stubs catalog: every entry produces a verdict envelope
// of `unknown` with a named-rule attribution, and the orchestrator
// emits the catalog wholesale so the verdict table covers every
// byos knob (no silent omissions).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { getStubVerdicts } from '../../js/src/eve/stub-verdicts.js';

test('stub verdicts: every entry is unknown with named-rule attribution', () => {
  const stubs = getStubVerdicts();
  assert.ok(stubs.length > 0, 'catalog non-empty');
  for (const v of stubs) {
    assert.equal(v.verdict, 'unknown', `${v.knob} verdict is unknown`);
    assert.equal(typeof v.rule, 'string', `${v.knob} carries a rule string`);
    assert.ok(v.rule.length > 0, `${v.knob} rule is non-empty`);
    assert.equal(typeof v.why, 'string', `${v.knob} carries a why string`);
    assert.ok(v.why.length > 0, `${v.knob} why is non-empty`);
    assert.equal(v.contradiction, false);
    assert.equal(v.done, true);
    // history has one entry recording the abstention-with-attribution.
    assert.equal(v.history.length, 1);
    assert.equal(v.history[0].rule, v.rule);
    assert.equal(v.history[0].from, 'unknown');
    assert.equal(v.history[0].to, 'unknown');
  }
});

test('stub verdicts: includes tieBreak and frequencies sources', () => {
  // augment.vowel removed with the cover-transforms arc (the xanax
  // rewriter now handles a/an agreement). Remaining stubs are the
  // strategy-5-deferred set.
  const knobs = new Set(getStubVerdicts().map(v => v.knob));
  assert.ok(knobs.has('tieBreak'), 'tieBreak stub present');
  assert.ok(knobs.has('frequencies.norvig'), 'frequencies.norvig stub present');
  assert.ok(knobs.has('frequencies.google'), 'frequencies.google stub present');
  assert.ok(knobs.has('frequencies.gutenberg'), 'frequencies.gutenberg stub present');
  assert.ok(!knobs.has('augment.vowel'), 'augment.vowel stub retired');
});

test('stub verdicts: rule names match strategy 5 deferred bucket', () => {
  const stubs = getStubVerdicts();
  const byKnob = new Map(stubs.map(v => [v.knob, v]));
  assert.equal(byKnob.get('tieBreak').rule, 'strategy-5-deferred');
  assert.equal(byKnob.get('frequencies.norvig').rule, 'strategy-5-deferred');
  assert.equal(byKnob.get('frequencies.google').rule, 'strategy-5-deferred');
  assert.equal(byKnob.get('frequencies.gutenberg').rule, 'strategy-5-deferred');
});
