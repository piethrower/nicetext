// rewriter-british.test.js: node smoke for the british cover-transform
// rewriter runtime (js/src/rewriter/british.js).
//
// british.js shares its apply() implementation with typos via
// js/src/rewriter/_lookup-swap.js, so the exhaustive intensity /
// case-preservation / variant-pick coverage lives in
// rewriter-typos.test.js. The tests here focus on british-specific
// concerns:
//   - module exports the full setter surface (matches xanax/typos)
//   - apply() handles the canonical US -> UK direction shape
//   - apply() handles the UK -> US direction shape
//   - the runtime is mode-agnostic (apply doesn't know us-uk vs uk-us;
//     the lookup map is what differs)

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import * as british from '../../js/src/rewriter/british.js';

function entry(word) {
  return { word, slotBits: [], parts: [word.toLowerCase()] };
}

function reset() { british._resetRewriterDataForTests(); }

test('british: module exports the full lookup-swap surface', () => {
  for (const name of [
    'apply', 'setRewriterData', 'setRewriterIntensity',
    'setRewriterRandom', '_resetRewriterDataForTests',
  ]) {
    assert.equal(typeof british[name], 'function', `british.${name} should be a function`);
  }
});

test('british: us-uk (Britishize), color -> colour', () => {
  reset();
  british.setRewriterData(new Map([
    ['color',    new Set(['colour'])],
    ['organize', new Set(['organise'])],
  ]));
  british.setRewriterIntensity(100);
  british.setRewriterRandom(() => 0.0);
  const buf = [entry('color')];
  british.apply(buf);
  assert.equal(buf[0].word, 'colour');
});

test('british: uk-us (Americanize), colour -> color', () => {
  reset();
  british.setRewriterData(new Map([
    ['colour',   new Set(['color'])],
    ['organise', new Set(['organize'])],
  ]));
  british.setRewriterIntensity(100);
  british.setRewriterRandom(() => 0.0);
  const buf = [entry('colour')];
  british.apply(buf);
  assert.equal(buf[0].word, 'color');
});

test('british: leading-cap input survives swap', () => {
  reset();
  british.setRewriterData(new Map([['color', new Set(['colour'])]]));
  british.setRewriterIntensity(100);
  british.setRewriterRandom(() => 0.0);
  const buf = [entry('Color')];
  british.apply(buf);
  assert.equal(buf[0].word, 'Colour');
});

test('british: word not in current-mode map passes through', () => {
  reset();
  // Lookup is the us-uk map (color->colour). If we feed a UK word
  // (colour) in this mode, apply has nothing to do.
  british.setRewriterData(new Map([['color', new Set(['colour'])]]));
  british.setRewriterIntensity(100);
  british.setRewriterRandom(() => 0.0);
  const buf = [entry('colour')];
  british.apply(buf);
  assert.equal(buf[0].word, 'colour');
});

test('british: apply is a no-op without data', () => {
  reset();
  const buf = [entry('color')];
  british.apply(buf);
  assert.equal(buf[0].word, 'color');
});
