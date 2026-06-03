// Tests for the round-trip self-validation option on encode().
// Validate: true (the default) tees the cover through a concurrent
// decode() and compares fingerprints of source vs decoded bytes;
// mismatch throws and the cover is not delivered to the caller as a
// success.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import { mulberry32 } from '../../js/src/random.js';
import { Fingerprint } from '../../js/src/fingerprint.js';
import { encode, _encodeWithDecode } from '../../js/src/encode.js';
import { decode } from '../../js/src/decode.js';
import {
  bytesToStream, stringToStream, captureBytesSink,
  encodeToString, decodeToBytes,
} from './_helpers.js';

const TWLIST = [
  { type: 'noun', word: 'apple' },
  { type: 'noun', word: 'banana' },
  { type: 'noun', word: 'cherry' },
  { type: 'noun', word: 'date' },
  { type: 'verb', word: 'eats' },
  { type: 'verb', word: 'tastes' },
  { type: 'adj', word: 'fresh' },
  { type: 'adj', word: 'ripe' },
];
const DICT = loadDictionary(buildDictionary(TWLIST, { name: 'validate-test' }));
const CORPUS = 'The fresh apple tastes ripe. A banana eats cherry. Ripe date.';
const MODEL = loadModelTable(await generateModelTable(CORPUS, DICT, { name: 'validate-corpus' }));
const PAYLOAD = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x91, 0x2c, 0xff, 0x00]);

function streamFor(seed) {
  return modelTableStream(MODEL, { random: mulberry32(seed), dict: DICT });
}

test('validate=true (default) round-trips a normal payload', async () => {
  // No explicit validate flag, relies on the default-on behavior.
  for (let seed = 1; seed <= 5; seed++) {
    const cover = await encodeToString(PAYLOAD, DICT, { modelStream: streamFor(seed) });
    const recovered = await decodeToBytes(cover, DICT);
    assert.deepEqual(recovered, PAYLOAD, `seed ${seed} round-trip`);
  }
});

test('validate=false produces a successful encode', async () => {
  for (let seed = 1; seed <= 5; seed++) {
    const cover = await encodeToString(PAYLOAD, DICT, {
      modelStream: streamFor(seed),
      validate: false,
    });
    const recovered = await decodeToBytes(cover, DICT);
    assert.deepEqual(recovered, PAYLOAD, `seed ${seed} round-trip with validate off`);
  }
});

test('validate=true and validate=false produce identical cover bytes', async () => {
  // Validation must not perturb the cover. Same modelStream seed →
  // same cover regardless of validate flag.
  for (let seed = 1; seed <= 5; seed++) {
    const coverOn = await encodeToString(PAYLOAD, DICT, {
      modelStream: streamFor(seed),
      validate: true,
    });
    const coverOff = await encodeToString(PAYLOAD, DICT, {
      modelStream: streamFor(seed),
      validate: false,
    });
    assert.equal(coverOn, coverOff, `seed ${seed} cover divergence`);
  }
});

test('onProgress and onValidateProgress both fire when set', async () => {
  // Use a larger payload so both pipelines hit their YIELD_EVERY=64
  // cadence at least once. 4 KB is well past the threshold.
  const big = new Uint8Array(4096);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;

  const encodeProgress = [];
  const validateProgress = [];
  const sink = captureBytesSink();
  await encode(bytesToStream(big), sink.writable, DICT, {
    modelStream: streamFor(7),
    validate: true,
    onProgress: (p) => { encodeProgress.push(p); },
    onValidateProgress: (p) => { validateProgress.push(p); },
  });
  assert.ok(encodeProgress.length > 0, 'expected encoder progress callbacks');
  assert.ok(validateProgress.length > 0, 'expected validator progress callbacks');
  // Sanity-check the shapes.
  assert.equal(typeof encodeProgress[0].modelsProcessed, 'number');
  assert.equal(typeof validateProgress[0].wordsProcessed, 'number');
});

test('validate=true round-trips with onProgress unset (silent operation)', async () => {
  // CLI / programmatic callers don't always set callbacks. Validate
  // must not depend on them.
  const sink = captureBytesSink();
  await encode(bytesToStream(PAYLOAD), sink.writable, DICT, {
    modelStream: streamFor(11),
    validate: true,
  });
  const cover = sink.resultAsString();
  const recovered = await decodeToBytes(cover, DICT);
  assert.deepEqual(recovered, PAYLOAD);
});

// ---- Divergence detection (mechanism check) ----

test('validation failure aborts the user-side output stream', async () => {
  // The user-facing output writer must NOT close cleanly when validation
  // fails: it must abort with the validation error so worker-boundary
  // consumers see a stream error (the loud-error UI in nicetext.html
  // depends on this).
  //
  // Forces a mismatch by injecting a stub decode that drains its input
  // but writes a single wrong byte to the validator's fingerprint sink.
  // Source FNV-1a over PAYLOAD won't equal the FNV-1a of [0xff].
  const stubDecode = async (input, output, _dict, _opts) => {
    const reader = input.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    const w = output.getWriter();
    await w.write(new Uint8Array([0xff]));
    await w.close();
  };
  // Custom sink that records whether the user-facing writable was
  // closed cleanly or aborted, and with what reason.
  let closeCalled = false;
  let abortReason = null;
  const trackingSink = new WritableStream({
    write() {},
    close() { closeCalled = true; },
    abort(reason) { abortReason = reason; },
  });
  let caught = null;
  try {
    await _encodeWithDecode(stubDecode, bytesToStream(PAYLOAD), trackingSink, DICT, {
      modelStream: streamFor(2),
      validate: true,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, 'expected encode to throw on validation mismatch');
  assert.match(caught.message, /round-trip validation failed/);
  assert.equal(closeCalled, false, 'expected user writer NOT to close cleanly on mismatch');
  assert.ok(abortReason, 'expected user writer to be aborted with the validation error');
  assert.match(abortReason.message, /round-trip validation failed/);
});

test('fingerprint comparison flags a corrupted cover', async () => {
  // The validate option's failure path runs a fingerprint compare
  // between source bytes and decoded bytes. This test exercises that
  // comparison directly by encoding (validate off), corrupting one
  // word in the cover, then decoding and asserting the digests
  // diverge. Confirms the comparison semantics the validate plumbing
  // depends on.
  const cover = await encodeToString(PAYLOAD, DICT, {
    modelStream: streamFor(3),
    validate: false,
  });
  // Replace the first dict word in the cover with a different one of
  // the same type so the result still parses but decodes to different
  // bits. "apple" and "banana" are both nouns with distinct Huffman
  // codes.
  let corrupted;
  if (cover.includes('apple')) corrupted = cover.replace('apple', 'banana');
  else if (cover.includes('banana')) corrupted = cover.replace('banana', 'apple');
  else if (cover.includes('cherry')) corrupted = cover.replace('cherry', 'date');
  else corrupted = cover.replace('date', 'cherry');
  assert.notEqual(corrupted, cover, 'expected corruption to actually change cover');

  const decoded = await decodeToBytes(corrupted, DICT);
  const srcFp = new Fingerprint(); srcFp.update(PAYLOAD);
  const decFp = new Fingerprint(); decFp.update(decoded);
  assert.notEqual(srcFp.digest(), decFp.digest(),
    'expected corrupted cover to produce divergent fingerprint');
});
