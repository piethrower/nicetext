// rewriter-typos.test.js: node smoke for the typos cover-transform
// rewriter runtime (js/src/rewriter/typos.js).
//
// Covers:
//   - apply() is a no-op until setRewriterData() / setRewriterRandom()
//     wire the lookup map and the per-encode RNG.
//   - intensity gate skips per-emission swaps at < 100%.
//   - variant-pick uses the RNG, with same-string picks suppressed.
//   - case preservation: leading-cap input -> leading-cap pick;
//     all-caps input -> all-caps pick; lowercase passes through.
//   - apply() refreshes the entry's `parts` so phrase-fusion logic
//     sees the post-swap word.
//   - apply() leaves degenerate inputs alone (state-only entries,
//     missing word, empty buf).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  apply,
  setRewriterData,
  setRewriterIntensity,
  setRewriterRandom,
  _resetRewriterDataForTests,
} from '../../js/src/rewriter/typos.js';

function entry(word) {
  return { word, slotBits: [], parts: [word.toLowerCase()] };
}

function reset() {
  _resetRewriterDataForTests();
}

test('typos: apply is a no-op without data', () => {
  reset();
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'the');
});

test('typos: apply is a no-op without an RNG', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'the', 'no RNG should skip mutation');
});

test('typos: apply swaps at intensity 100 with a deterministic RNG', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh', 'het', 'eth'])]]));
  // RNG sequence: first call is the intensity coin (only consulted
  // when intensity < 100), so at 100 only the variant-pick coin
  // matters. Pick index = floor(0.0 * 3) = 0 -> 'teh'.
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'teh');
  assert.deepEqual(buf[0].parts, ['teh']);
});

test('typos: intensity 0 short-circuits even with data + RNG', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(0);
  setRewriterRandom(() => 0.0);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'the');
});

test('typos: intensity coin skips when draw lands above threshold', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(50);
  // Two-draw flow at intensity<100: first draw is the intensity
  // coin. 0.6 * 100 = 60 >= 50, so the apply skips.
  setRewriterRandom(() => 0.6);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'the');
});

test('typos: intensity coin fires when draw lands below threshold', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(50);
  let i = 0;
  // First draw: 0.1 (passes the 50% gate). Second draw: 0.0
  // (variant pick = 'teh').
  setRewriterRandom(() => [0.1, 0.0][i++]);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'teh');
});

test('typos: same-string pick is suppressed', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['the'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'the', 'self-replacement should be skipped');
});

test('typos: case preservation, leading capital', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('The')];
  apply(buf);
  assert.equal(buf[0].word, 'Teh');
});

test('typos: case preservation, all caps', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('THE')];
  apply(buf);
  assert.equal(buf[0].word, 'TEH');
});

test('typos: case preservation, lowercase passes through', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('the')];
  apply(buf);
  assert.equal(buf[0].word, 'teh');
});

test('typos: state-only entries are skipped', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [{ kind: 'state', value: 'Cap', slotBits: [] }];
  apply(buf);
  assert.equal(buf[0].kind, 'state');
  assert.equal(buf[0].word, undefined);
});

test('typos: empty buf is a no-op', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  apply([]);
  apply();
});

test('typos: word not in lookup passes through', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [entry('zebra')];
  apply(buf);
  assert.equal(buf[0].word, 'zebra');
});

test('typos: parts is refreshed from the swapped word', () => {
  reset();
  setRewriterData(new Map([['the', new Set(['teh'])]]));
  setRewriterIntensity(100);
  setRewriterRandom(() => 0.0);
  const buf = [{ word: 'the', slotBits: [], parts: ['the'] }];
  apply(buf);
  assert.equal(buf[0].word, 'teh');
  assert.deepEqual(buf[0].parts, ['teh']);
});
