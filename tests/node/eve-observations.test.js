// Cover Story observations -> Eve isNiceText short-circuit.
// Cover Story records what autoStrip detected and what the user
// chose to peel; Eve uses that to short-circuit isNiceText when
// the suspected bytes still carry an unstripped wrapper layer.
//
// The observations do NOT include source / filename / ingest event
// (those would be cheating; Eve couldn't derive them from bytes).
// This test only exercises the cover-pipeline-derivable fields.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { runIsNiceTextCheck } from '../../js/src/eve/preclean-check.js';

const PRECLEAN_STABLE_TEXT =
  ('Hello there friend, how are you today? '.repeat(20)).trim();

test('observations: no observations -> falls through to preclean (current behavior)', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT);
  assert.equal(v.knob, 'isNiceText');
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
});

test('observations: zero layers detected -> falls through to preclean', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT, {
    observations: { detectedLayers: [], appliedLayers: [] },
  });
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
});

test('observations: all detected layers applied -> falls through to preclean', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT, {
    observations: { detectedLayers: ['gzip'], appliedLayers: ['gzip'] },
  });
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
});

test('observations: residue (detected > applied) -> strong unlikely with unstripped-wrapper-residue', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT, {
    observations: { detectedLayers: ['gzip', 'pdf'], appliedLayers: ['gzip'] },
  });
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'unstripped-wrapper-residue');
  assert.ok(v.confidence >= 0.9, `expected high confidence, got ${v.confidence}`);
  assert.match(v.why, /pdf/);
});

test('observations: zero applied of two detected -> residue is both layers', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT, {
    observations: { detectedLayers: ['gzip', 'base64'], appliedLayers: [] },
  });
  assert.equal(v.verdict, 'unlikely');
  assert.equal(v.rule, 'unstripped-wrapper-residue');
  assert.match(v.why, /gzip/);
  assert.match(v.why, /base64/);
});

test('observations: malformed observations (non-array) -> falls through gracefully', async () => {
  const v = await runIsNiceTextCheck(PRECLEAN_STABLE_TEXT, {
    observations: { detectedLayers: null, appliedLayers: null },
  });
  assert.equal(v.verdict, 'likely');
  assert.equal(v.rule, 'preclean-idempotent');
});
