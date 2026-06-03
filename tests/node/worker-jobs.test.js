// Integration tests for the on-demand streaming worker job runners.
//
// Verifies end-to-end encode/decode round-trips through fresh
// per-job workers, dict-SAB caching across jobs, and AbortSignal
// cancellation. See docs/architecture-workers.md (on-demand model).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import {
  encodeJob,
  decodeJob,
  loadResource,
  _clearResourceCache,
  _resourceCacheSize,
} from '../../js/src/worker/jobs.js';
import { mulberry32 } from '../../js/src/random.js';
import {
  bytesToStream,
  stringToStream,
  streamToBytes,
  streamToString,
  fixtureURL,
} from './_helpers.js';

const JFK_DICT  = fixtureURL('jfk', import.meta.url);
const MIT_DICT  = fixtureURL('mit', import.meta.url);
const JFK_MODEL = fixtureURL('jfk', import.meta.url, 'model');
const MIT_GRAM  = new URL('../../grammars/mit-names.def', import.meta.url);

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

test('jobs: flat encode/decode round-trip via dict only', async () => {
  _clearResourceCache();
  const payload = makePayload(101, 32);
  const coverStream = await encodeJob({
    input: bytesToStream(payload),
    dictPath: JFK_DICT,
    randomSeed: 0xC0FFEE,
    streamSeed: 1234,
  });
  const cover = await streamToString(coverStream);
  assert.ok(cover.length > 0, 'cover text should be non-empty');
  const recoveredStream = await decodeJob({
    input: stringToStream(cover),
    dictPath: JFK_DICT,
  });
  const recovered = await streamToBytes(recoveredStream);
  assert.deepEqual(recovered, payload);
});

test('jobs: grammar-driven encode/decode round-trip', async () => {
  _clearResourceCache();
  const payload = makePayload(102, 40);
  const cover = await streamToString(await encodeJob({
    input: bytesToStream(payload),
    dictPath: MIT_DICT,
    grammarPath: MIT_GRAM,
    randomSeed: 0xC0FFEE,
    streamSeed: 5678,
  }));
  const recovered = await streamToBytes(await decodeJob({
    input: stringToStream(cover),
    dictPath: MIT_DICT,
  }));
  assert.deepEqual(recovered, payload);
});

test('jobs: model-table encode/decode round-trip (random mode)', async () => {
  _clearResourceCache();
  const payload = makePayload(103, 16);
  const cover = await streamToString(await encodeJob({
    input: bytesToStream(payload),
    dictPath: JFK_DICT,
    modelPath: JFK_MODEL,
    mode: 'random',
    randomSeed: 0xC0FFEE,
    streamSeed: 9012,
  }));
  const recovered = await streamToBytes(await decodeJob({
    input: stringToStream(cover),
    dictPath: JFK_DICT,
  }));
  assert.deepEqual(recovered, payload);
});

test('jobs: dict SAB is cached across jobs (one load worker, not three)', async () => {
  _clearResourceCache();
  const a = await streamToString(await encodeJob({
    input: bytesToStream(makePayload(201, 8)),
    dictPath: JFK_DICT,
    randomSeed: 1, streamSeed: 1,
  }));
  assert.equal(_resourceCacheSize(), 1, 'cache should hold the dict after first job');
  const b = await streamToString(await encodeJob({
    input: bytesToStream(makePayload(202, 8)),
    dictPath: JFK_DICT,
    randomSeed: 2, streamSeed: 2,
  }));
  const dec = await streamToBytes(await decodeJob({
    input: stringToStream(b),
    dictPath: JFK_DICT,
  }));
  assert.deepEqual(dec, makePayload(202, 8));
  assert.equal(_resourceCacheSize(), 1, 'cache should still hold one dict');
  assert.notEqual(a, b, 'different streamSeeds should produce different covers');
});

test('jobs: concurrent first-load requests share a single in-flight load', async () => {
  _clearResourceCache();
  const [c1, c2, c3] = await Promise.all([
    encodeJob({ input: bytesToStream(makePayload(301, 8)), dictPath: JFK_DICT, randomSeed: 1, streamSeed: 1 }).then(streamToString),
    encodeJob({ input: bytesToStream(makePayload(302, 8)), dictPath: JFK_DICT, randomSeed: 2, streamSeed: 2 }).then(streamToString),
    encodeJob({ input: bytesToStream(makePayload(303, 8)), dictPath: JFK_DICT, randomSeed: 3, streamSeed: 3 }).then(streamToString),
  ]);
  for (const [cover, seed] of [[c1, 301], [c2, 302], [c3, 303]]) {
    const dec = await streamToBytes(await decodeJob({
      input: stringToStream(cover),
      dictPath: JFK_DICT,
    }));
    assert.deepEqual(dec, makePayload(seed, 8));
  }
  assert.equal(_resourceCacheSize(), 1, 'concurrent loads should dedupe to one cache entry');
});

test('jobs: AbortSignal cancels an in-flight encode', async () => {
  _clearResourceCache();
  const ctrl = new AbortController();
  const payload = makePayload(401, 8192);
  let enginePhaseCalls = 0;
  const coverStream = await encodeJob({
    input: bytesToStream(payload),
    dictPath: JFK_DICT,
    randomSeed: 0xC0FFEE,
    streamSeed: 11,
    onProgress: (info) => {
      // Setup-phase events fire from the parent before the engine
      // worker is even spawned (dict load). Test intent is to abort
      // mid-encode, so wait for an engine-phase event.
      if (info?.phase === 'setup') return;
      enginePhaseCalls++;
      if (enginePhaseCalls === 1) ctrl.abort();
    },
    signal: ctrl.signal,
  });
  await assert.rejects(streamToString(coverStream), (err) => err.name === 'AbortError');
  assert.ok(enginePhaseCalls >= 1, 'engine-phase onProgress should have fired at least once');
});

test('jobs: AbortSignal pre-aborted rejects without spawning encode worker', async () => {
  _clearResourceCache();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    encodeJob({
      input: bytesToStream(makePayload(501, 8)),
      dictPath: JFK_DICT,
      signal: ctrl.signal,
    }),
    (err) => err.name === 'AbortError'
  );
});

test('jobs: loadResource directly returns a SAB ref', async () => {
  _clearResourceCache();
  const sab = await loadResource(JFK_DICT, 'dict');
  const isSab = typeof SharedArrayBuffer !== 'undefined' && sab instanceof SharedArrayBuffer;
  assert.ok(isSab || sab instanceof ArrayBuffer,
    `expected SAB or ArrayBuffer, got ${Object.prototype.toString.call(sab)}`);
  const view = new DataView(sab);
  assert.equal(view.getUint32(0, true), 0x4344544E);
});
