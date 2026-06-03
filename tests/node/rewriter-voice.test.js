// rewriter-voice.test.js: node smoke for the voice cover-transform
// rewriter runtime (js/src/rewriter/voice.js).
//
// voice.js shares its apply() implementation with typos / british via
// js/src/rewriter/_lookup-swap.js, so exhaustive intensity / case-
// preservation / variant-pick coverage lives in rewriter-typos.test.js.
// The tests here focus on voice-specific concerns:
//   - module exports the full setter surface (matches typos/british)
//   - apply() performs canonical -> variant swap for the loaded mode
//   - the runtime is mode-agnostic (apply doesn't know pirate vs.
//     any future mode; the lookup map is what differs)
//
// Note: voice the REWRITER (this file) is independent from voice the
// REFORMATTER (tests/node/reformatter.test.js). The two layers share
// no code path; they're tested separately.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import * as voice from '../../js/src/rewriter/voice.js';

function entry(word) {
  return { word, slotBits: [], parts: [word.toLowerCase()] };
}

function reset() { voice._resetRewriterDataForTests(); }

test('voice: module exports the full lookup-swap surface', () => {
  for (const name of [
    'apply', 'setRewriterData', 'setRewriterIntensity',
    'setRewriterRandom', '_resetRewriterDataForTests',
  ]) {
    assert.equal(typeof voice[name], 'function', `voice.${name} should be a function`);
  }
});

test('voice: pirate, hello -> ahoy', () => {
  reset();
  voice.setRewriterData(new Map([
    ['hello',  new Set(['ahoy'])],
    ['friend', new Set(['matey'])],
  ]));
  voice.setRewriterIntensity(100);
  voice.setRewriterRandom(() => 0.0);
  const buf = [entry('hello')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'ahoy');
});

test('voice: pirate, friend -> matey', () => {
  reset();
  voice.setRewriterData(new Map([
    ['hello',  new Set(['ahoy'])],
    ['friend', new Set(['matey'])],
  ]));
  voice.setRewriterIntensity(100);
  voice.setRewriterRandom(() => 0.0);
  const buf = [entry('friend')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'matey');
});

test('voice: leading-cap input survives swap', () => {
  reset();
  voice.setRewriterData(new Map([['hello', new Set(['ahoy'])]]));
  voice.setRewriterIntensity(100);
  voice.setRewriterRandom(() => 0.0);
  const buf = [entry('Hello')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'Ahoy');
});

test('voice: word not in lookup passes through', () => {
  reset();
  voice.setRewriterData(new Map([['hello', new Set(['ahoy'])]]));
  voice.setRewriterIntensity(100);
  voice.setRewriterRandom(() => 0.0);
  const buf = [entry('weather')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'weather');
});

test('voice: intensity=0 → no swap', () => {
  reset();
  voice.setRewriterData(new Map([['hello', new Set(['ahoy'])]]));
  voice.setRewriterIntensity(0);
  voice.setRewriterRandom(() => 0.0);
  const buf = [entry('hello')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'hello');
});

test('voice: apply is a no-op without data', () => {
  reset();
  const buf = [entry('hello')];
  voice.apply(buf);
  assert.equal(buf[0].word, 'hello');
});
