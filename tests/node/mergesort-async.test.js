// Tests for the yielding mergesort. Coverage:
//   - matches native sort on randomized input
//   - stable on equal keys
//   - handles 0 / 1 / 2 element edge cases
//   - emits 'mergesort-end' on completion
//   - emits 'mergesort-pass' during big sorts
//   - aborts via signal between yields

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { mergesortAsync } from '../../js/src/builder/mergesort-async.js';

test('mergesortAsync: empty array', async () => {
  const out = await mergesortAsync([], (a, b) => a - b);
  assert.deepEqual(out, []);
});

test('mergesortAsync: single element', async () => {
  const out = await mergesortAsync([42], (a, b) => a - b);
  assert.deepEqual(out, [42]);
});

test('mergesortAsync: two elements', async () => {
  const a = await mergesortAsync([2, 1], (a, b) => a - b);
  assert.deepEqual(a, [1, 2]);
  const b = await mergesortAsync([1, 2], (a, b) => a - b);
  assert.deepEqual(b, [1, 2]);
});

test('mergesortAsync: matches native sort on randomized input', async () => {
  const n = 5000;
  const arr = [];
  let rng = 1;
  for (let i = 0; i < n; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    arr.push(rng);
  }
  const expected = arr.slice().sort((a, b) => a - b);
  const got = await mergesortAsync(arr.slice(), (a, b) => a - b, { yieldEvery: 1000 });
  assert.deepEqual(got, expected);
});

test('mergesortAsync: stable on equal keys', async () => {
  const input = [
    { k: 1, tag: 'a' },
    { k: 2, tag: 'b' },
    { k: 1, tag: 'c' },
    { k: 2, tag: 'd' },
    { k: 1, tag: 'e' },
  ];
  const out = await mergesortAsync(input, (a, b) => a.k - b.k);
  // Equal-key items must preserve input order: a, c, e (all k=1)
  // come before b, d (k=2), and within each group the original order
  // (a-c-e and b-d) is preserved.
  assert.deepEqual(out.map(x => x.tag), ['a', 'c', 'e', 'b', 'd']);
});

test('mergesortAsync: emits mergesort-end exactly once', async () => {
  const events = [];
  await mergesortAsync([3, 1, 4, 1, 5, 9, 2, 6], (a, b) => a - b, {
    yieldEvery: 1,
    onProgress: (e) => events.push(e.phase),
  });
  const ends = events.filter(p => p === 'mergesort-end');
  assert.equal(ends.length, 1);
});

test('mergesortAsync: emits mergesort-pass during big sorts', async () => {
  const arr = Array.from({ length: 5000 }, (_, i) => 5000 - i);
  const passes = [];
  await mergesortAsync(arr, (a, b) => a - b, {
    yieldEvery: 500,
    onProgress: (e) => {
      if (e.phase === 'mergesort-pass') passes.push(e);
    },
  });
  assert.ok(passes.length > 0, 'expected at least one mergesort-pass event');
  // Each event carries the current runSize and total.
  for (const e of passes) {
    assert.equal(e.total, 5000);
    assert.ok(Number.isInteger(e.runSize) && e.runSize >= 1);
  }
});

test('mergesortAsync: aborts via signal between yields', async () => {
  const ctrl = new AbortController();
  const arr = Array.from({ length: 5000 }, (_, i) => 5000 - i);
  // Trigger abort on the first onProgress callback (i.e., as soon as
  // the sort yields), then await the promise and expect it to reject.
  let aborted = false;
  await mergesortAsync(arr, (a, b) => a - b, {
    yieldEvery: 100,
    signal: ctrl.signal,
    onProgress: () => { if (!aborted) { aborted = true; ctrl.abort(); } },
  }).then(
    () => { throw new Error('expected mergesortAsync to throw on abort'); },
    (err) => { assert.equal(err.name, 'AbortError'); },
  );
});
