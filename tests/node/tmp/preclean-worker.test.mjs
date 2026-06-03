// Node smoke for preclean-async.js. Verifies the worker spawns,
// processes a request, returns the cleaned text, and that serialized
// calls don't interleave.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { precleanCorpusAsync } from '../../../js/src/builder/preclean-async.js';
import { precleanCorpus } from '../../../js/src/builder/precleanCorpus.js';

test('precleanCorpusAsync returns cleaned text', async () => {
  // Mix of curly quotes, em dash, Cyrillic confusable, numeric chain.
  const input = 'café ‘smart’ quotes, dash and 1.2.3.4 chain.';
  const expected = precleanCorpus(input);
  const actual = await precleanCorpusAsync(input);
  assert.equal(actual, expected);
});

test('precleanCorpusAsync handles a 1 MB blob', async () => {
  let text = '';
  const sample = 'Hello world. “smart” quotes, dash. 1.2.3.4. ';
  while (text.length < 1024 * 1024) text += sample;
  text = text.slice(0, 1024 * 1024);
  const expected = precleanCorpus(text);
  const actual = await precleanCorpusAsync(text);
  assert.equal(actual.length, expected.length);
  assert.equal(actual, expected);
});

test('serialized calls return correct results in order', async () => {
  const inputs = [
    'one, dash',
    'two ‘quote’',
    'three 1.2.3.4 chain',
    'four “double”',
  ];
  const expected = inputs.map(precleanCorpus);
  // Fire all four without awaiting individually; precleanCorpusAsync
  // serializes internally.
  const promises = inputs.map(t => precleanCorpusAsync(t));
  const results = await Promise.all(promises);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(results[i], expected[i], `result ${i} mismatch`);
  }
});
