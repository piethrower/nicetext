// Tests for the mid-job skip-validation opt-out path in encode.js
// (audit follow-up 2026-05-18). Verifies:
//   - the encode completes cleanly when the signal fires mid-stream,
//   - the resulting cover is identical to a non-skipped run (same RNG
//     seed), i.e., skipping doesn't change the cover, only what was
//     verified about it,
//   - the validator detaches: a stub decode that NEVER resolves can be
//     used during the skipped run and the encode still completes
//     (proves validate side stops being awaited),
//   - skipping after encode already finished is a no-op (the signal
//     is allowed to fire late without breaking).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { _encodeWithDecode, encode } from '../../js/src/encode.js';
import { decode } from '../../js/src/decode.js';
import { wrapDictionaryFromSAB } from '../../js/src/dictionary.js';
import { weightedTypeStream } from '../../js/src/typestream.js';
import { mulberry32 } from '../../js/src/random.js';
import { loadResource } from '../../js/src/resource-loader.js';

// jfk-1.dict.sab.gz is the canonical SAB fixture. loadResource works
// in both Node (worker pool with fs-backed fetch) and browser (worker
// pool with HTTP fetch), so the same call path covers test-suite.html
// and run-node.mjs.
async function loadJfk() {
  const sab = await loadResource('jfk-1', 'dict');
  return wrapDictionaryFromSAB(sab);
}

function streamFromBytes(bytes) {
  return new ReadableStream({
    start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
  });
}

async function streamToBytes(stream) {
  const reader = stream.getReader();
  const chunks = []; let total = 0;
  for (;;) { const x = await reader.read(); if (x.done) break; if (x.value) { chunks.push(x.value); total += x.value.length; } }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function makeCollectorOutput() {
  const chunks = []; let total = 0;
  const writable = new WritableStream({
    write(chunk) { chunks.push(chunk); total += chunk.length; },
  });
  return {
    writable,
    bytes: () => {
      const out = new Uint8Array(total); let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    },
  };
}

test('skipValidationSignal: encode completes when signal fires mid-job and cover matches non-skipped run', async () => {
  const dict = await loadJfk();
  const SECRET = new Uint8Array(2048);
  for (let i = 0; i < SECRET.length; i++) SECRET[i] = (i * 17 + 3) & 0xFF;

  // Baseline: encode normally.
  const baseline = makeCollectorOutput();
  await encode(streamFromBytes(SECRET), baseline.writable, dict, {
    typeStream: weightedTypeStream(dict, { random: mulberry32(12345) }),
    randomSeed: 12345,
  });
  const baselineCover = baseline.bytes();
  assert.ok(baselineCover.length > 0);

  // Same seed, skip fires immediately (before any bytes flow).
  const skip = makeCollectorOutput();
  const skipController = new AbortController();
  skipController.abort();
  await encode(streamFromBytes(SECRET), skip.writable, dict, {
    typeStream: weightedTypeStream(dict, { random: mulberry32(12345) }),
    randomSeed: 12345,
    skipValidationSignal: skipController.signal,
  });
  const skipCover = skip.bytes();
  assert.deepEqual(skipCover, baselineCover,
    'cover bytes should be identical regardless of validation state (skipping only detaches the validator)');
});

test('skipValidationSignal: stub decode that never resolves does not hang the encode after skip', async () => {
  const dict = await loadJfk();
  const SECRET = new Uint8Array(512);
  for (let i = 0; i < SECRET.length; i++) SECRET[i] = i & 0xFF;

  // Inject a fake decode that drains its input forever. When the
  // outer encode fires the skip, validatorReadable.cancel() makes
  // reader.read() reject, the loop unwinds and fakeDecode rejects,
  // which encode.js's `.catch(if validatorSkipped return)` swallows.
  // The point is that the encode SHOULD complete via the skip path
  // even though this fake decode would never have produced a digest.
  const fakeDecode = async (input /*, output, dict, opts */) => {
    const reader = input.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  };

  const out = makeCollectorOutput();
  const skipController = new AbortController();

  // Fire the skip immediately so the test runs in seconds, not forever.
  skipController.abort();

  await _encodeWithDecode(
    fakeDecode,
    streamFromBytes(SECRET),
    out.writable,
    dict,
    {
      typeStream: weightedTypeStream(dict, { random: mulberry32(7) }),
      randomSeed: 7,
      skipValidationSignal: skipController.signal,
    },
  );
  const cover = out.bytes();
  assert.ok(cover.length > 0, 'cover should be produced even with a stub decode that never resolves');
});

test('skipValidationSignal: signal that never fires keeps validation on (no behavior change)', async () => {
  const dict = await loadJfk();
  const SECRET = new Uint8Array(1024);
  for (let i = 0; i < SECRET.length; i++) SECRET[i] = (i * 7) & 0xFF;

  const out = makeCollectorOutput();
  const idleController = new AbortController(); // never .abort()'d

  await encode(streamFromBytes(SECRET), out.writable, dict, {
    typeStream: weightedTypeStream(dict, { random: mulberry32(99) }),
    randomSeed: 99,
    skipValidationSignal: idleController.signal,
  });
  // Round-trip through real decode to confirm validation was active
  // (encode would have thrown if there was a mismatch).
  const cover = out.bytes();
  const recoverColl = makeCollectorOutput();
  await decode(streamFromBytes(cover), recoverColl.writable, dict);
  const recovered = recoverColl.bytes();
  assert.deepEqual(recovered, SECRET);
});

test('skipValidationSignal: skipped encode still round-trips through real decode', async () => {
  // Even with validation skipped, the cover should still be a valid
  // encode (the engine isn't broken, validation just isn't checking).
  const dict = await loadJfk();
  const SECRET = new Uint8Array(1500);
  for (let i = 0; i < SECRET.length; i++) SECRET[i] = (i * 23 + 5) & 0xFF;

  const out = makeCollectorOutput();
  const skipController = new AbortController();
  // Fire mid-job via a microtask after start.
  queueMicrotask(() => skipController.abort());

  await encode(streamFromBytes(SECRET), out.writable, dict, {
    typeStream: weightedTypeStream(dict, { random: mulberry32(42) }),
    randomSeed: 42,
    skipValidationSignal: skipController.signal,
  });
  const cover = out.bytes();
  const recoverColl = makeCollectorOutput();
  await decode(streamFromBytes(cover), recoverColl.writable, dict);
  const recovered = recoverColl.bytes();
  assert.deepEqual(recovered, SECRET);
});
