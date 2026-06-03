// Scheduler: generic DAG executor primitive. Tests use synchronous
// (and async) in-process onJobReady callbacks to validate ordering,
// concurrency, dependency resolution, cancellation, and failure.
// Hoisted out of js/src/eve/ once Build and Conceal/Reveal started
// using the same scheduler.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { runScheduler } from '../../js/src/scheduler.js';

// Helper: a tiny job runner that records call order and returns
// `jobId` as the result. `delays` map lets us nudge timing without
// real I/O.
function makeRunner(delays = {}) {
  const startOrder = [];
  const doneOrder = [];
  const runner = async (job) => {
    startOrder.push(job.id);
    const d = delays[job.id] ?? 0;
    if (d > 0) await new Promise(r => setTimeout(r, d));
    doneOrder.push(job.id);
    return job.id;
  };
  return { runner, startOrder, doneOrder };
}

test('scheduler: empty job list resolves to empty Map and emits complete', async () => {
  const events = [];
  const results = await runScheduler({
    jobs: [],
    onJobReady: async () => 'never',
    onProgress: (e) => events.push(e),
  });
  assert.equal(results.size, 0);
  assert.deepEqual(events, [{ kind: 'complete', totalJobs: 0 }]);
});

test('scheduler: single job with no deps runs once', async () => {
  const { runner, doneOrder } = makeRunner();
  const results = await runScheduler({
    jobs: [{ id: 'a' }],
    onJobReady: runner,
  });
  assert.deepEqual(doneOrder, ['a']);
  assert.equal(results.get('a'), 'a');
});

test('scheduler: independent jobs all run with concurrency=Infinity', async () => {
  const { runner, startOrder, doneOrder } = makeRunner();
  const results = await runScheduler({
    jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    onJobReady: runner,
  });
  assert.equal(results.size, 3);
  assert.equal(new Set(startOrder).size, 3);
  assert.equal(new Set(doneOrder).size, 3);
});

test('scheduler: dependency edge enforces order', async () => {
  // a -> b -> c (b depends on a; c depends on b).
  const { runner, doneOrder } = makeRunner();
  await runScheduler({
    jobs: [
      { id: 'c', deps: ['b'] },
      { id: 'b', deps: ['a'] },
      { id: 'a' },
    ],
    onJobReady: runner,
  });
  assert.deepEqual(doneOrder, ['a', 'b', 'c']);
});

test('scheduler: diamond DAG (fan-out + fan-in)', async () => {
  // a -> {b, c} -> d. b and c can run in parallel; d waits for both.
  const { runner, doneOrder } = makeRunner({ b: 5, c: 1 });
  await runScheduler({
    jobs: [
      { id: 'a' },
      { id: 'b', deps: ['a'] },
      { id: 'c', deps: ['a'] },
      { id: 'd', deps: ['b', 'c'] },
    ],
    onJobReady: runner,
  });
  // a runs first; d runs last; b and c order is timing-dependent.
  assert.equal(doneOrder[0], 'a');
  assert.equal(doneOrder[doneOrder.length - 1], 'd');
  assert.equal(new Set(doneOrder).size, 4);
});

test('scheduler: concurrency cap honored', async () => {
  // Five independent jobs, concurrency=2: peak in-flight is 2.
  let inFlight = 0;
  let peak = 0;
  const runner = async (job) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return job.id;
  };
  await runScheduler({
    jobs: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })),
    onJobReady: runner,
    concurrency: 2,
  });
  assert.equal(peak, 2, `peak concurrency should be 2, was ${peak}`);
});

test('scheduler: concurrency=1 serializes execution', async () => {
  let inFlight = 0;
  let peak = 0;
  const runner = async (job) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    return job.id;
  };
  await runScheduler({
    jobs: ['a', 'b', 'c'].map(id => ({ id })),
    onJobReady: runner,
    concurrency: 1,
  });
  assert.equal(peak, 1);
});

test('scheduler: cycle detection throws synchronously', () => {
  assert.throws(
    () => runScheduler({
      jobs: [
        { id: 'a', deps: ['b'] },
        { id: 'b', deps: ['a'] },
      ],
      onJobReady: async () => 'x',
    }),
    /cycle detected/,
  );
});

test('scheduler: unknown dep id throws', () => {
  assert.throws(
    () => runScheduler({
      jobs: [{ id: 'a', deps: ['nope'] }],
      onJobReady: async () => 'x',
    }),
    /unknown id "nope"/,
  );
});

test('scheduler: duplicate job id throws', () => {
  assert.throws(
    () => runScheduler({
      jobs: [{ id: 'a' }, { id: 'a' }],
      onJobReady: async () => 'x',
    }),
    /duplicate job id "a"/,
  );
});

test('scheduler: AbortSignal cancels remaining jobs', async () => {
  const startOrder = [];
  const controller = new AbortController();
  const runner = async (job) => {
    startOrder.push(job.id);
    if (job.id === 'a') controller.abort();
    await new Promise(r => setTimeout(r, 1));
    return job.id;
  };
  await assert.rejects(
    () => runScheduler({
      jobs: [
        { id: 'a' },
        { id: 'b', deps: ['a'] },
        { id: 'c', deps: ['a'] },
      ],
      onJobReady: runner,
      signal: controller.signal,
    }),
    /aborted/,
  );
  // 'a' starts; abort fires inside it; 'b' and 'c' never start.
  assert.deepEqual(startOrder, ['a']);
});

test('scheduler: pre-aborted signal rejects without dispatching', async () => {
  const controller = new AbortController();
  controller.abort();
  const startOrder = [];
  await assert.rejects(
    () => runScheduler({
      jobs: [{ id: 'a' }],
      onJobReady: async (job) => { startOrder.push(job.id); return job.id; },
      signal: controller.signal,
    }),
    /aborted/,
  );
  assert.deepEqual(startOrder, []);
});

test('scheduler: failed job rejects the run and cancels downstream', async () => {
  const startOrder = [];
  const runner = async (job) => {
    startOrder.push(job.id);
    if (job.id === 'b') throw new Error('boom');
    return job.id;
  };
  await assert.rejects(
    () => runScheduler({
      jobs: [
        { id: 'a' },
        { id: 'b', deps: ['a'] },
        { id: 'c', deps: ['b'] },
      ],
      onJobReady: runner,
    }),
    /boom/,
  );
  assert.deepEqual(startOrder, ['a', 'b']);
});

test('scheduler: progress events fire for start/done/complete', async () => {
  const events = [];
  await runScheduler({
    jobs: [
      { id: 'a', kind: 'load' },
      { id: 'b', kind: 'compute', deps: ['a'] },
    ],
    onJobReady: async (job) => job.id,
    onProgress: (e) => events.push(e),
  });
  // Expect: job-start(a), job-done(a), job-start(b), job-done(b), complete.
  const kinds = events.map(e => e.kind);
  assert.deepEqual(kinds, ['job-start', 'job-done', 'job-start', 'job-done', 'complete']);
  assert.equal(events[0].jobKind, 'load');
  assert.equal(events[2].jobKind, 'compute');
  assert.equal(events[4].totalJobs, 2);
});

test('scheduler: thrown onProgress handler does not break the run', async () => {
  const results = await runScheduler({
    jobs: [{ id: 'a' }, { id: 'b' }],
    onJobReady: async (job) => job.id,
    onProgress: () => { throw new Error('broken UI handler'); },
  });
  assert.equal(results.size, 2);
});

test('scheduler: result Map keys job results by id', async () => {
  const runner = async (job) => `result-for-${job.id}`;
  const results = await runScheduler({
    jobs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    onJobReady: runner,
  });
  assert.equal(results.get('a'), 'result-for-a');
  assert.equal(results.get('b'), 'result-for-b');
  assert.equal(results.get('c'), 'result-for-c');
});

test('scheduler: failed job-failed event carries error reference', async () => {
  const events = [];
  await assert.rejects(
    () => runScheduler({
      jobs: [{ id: 'a' }],
      onJobReady: async () => { throw new Error('nope'); },
      onProgress: (e) => events.push(e),
    }),
    /nope/,
  );
  const failed = events.find(e => e.kind === 'job-failed');
  assert.ok(failed, 'job-failed event expected');
  assert.equal(failed.jobId, 'a');
  assert.match(failed.error.message, /nope/);
});
