import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { lookupWord } from '../../js/src/dictionary.js';
import { weightedTypeStream, roundRobinTypeStream } from '../../js/src/typestream.js';
import { mulberry32 } from '../../js/src/random.js';
import { encodeToString, decodeToBytes, loadDictFixture, fixtureURL } from './_helpers.js';

const dict = loadDictFixture(fixtureURL('mit', import.meta.url));

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

test('round-trip: empty payload', async () => {
  const stream = weightedTypeStream(dict, { random: mulberry32(1) });
  const cover = await encodeToString(new Uint8Array(0), dict, { typeStream: stream });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, new Uint8Array(0));
});

test('round-trip: 1-byte payload', async () => {
  const payload = new Uint8Array([0x42]);
  const stream = weightedTypeStream(dict, { random: mulberry32(2) });
  const cover = await encodeToString(payload, dict, { typeStream: stream });
  assert.deepEqual(await decodeToBytes(cover, dict), payload);
});

test('round-trip: random payloads of various lengths', async () => {
  for (const len of [1, 7, 8, 9, 16, 50, 100, 256, 1000]) {
    const payload = makePayload(len * 7 + 13, len);
    const stream = weightedTypeStream(dict, { random: mulberry32(len * 11) });
    const cover = await encodeToString(payload, dict, { typeStream: stream });
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `len ${len}`);
  }
});

test('round-trip: round-robin type stream', async () => {
  const payload = makePayload(99, 50);
  const cover = await encodeToString(payload, dict, { typeStream: roundRobinTypeStream(dict) });
  assert.deepEqual(await decodeToBytes(cover, dict), payload);
});

test('encode is deterministic given the same seed', async () => {
  const payload = makePayload(123, 80);
  const a = await encodeToString(payload, dict, { typeStream: weightedTypeStream(dict, { random: mulberry32(7) }), randomSeed: 99 });
  const b = await encodeToString(payload, dict, { typeStream: weightedTypeStream(dict, { random: mulberry32(7) }), randomSeed: 99 });
  assert.equal(a, b);
});

test('encode + decode is robust to surrounding noise / unknown words', async () => {
  const payload = makePayload(456, 30);
  const cover = await encodeToString(payload, dict, { typeStream: weightedTypeStream(dict, { random: mulberry32(3) }) });
  // Inject unknown words and punctuation; decode should ignore them.
  const noisy = `Lorem ipsum! ${cover}, wibble; (xyzzy) blarghquux.`;
  assert.deepEqual(await decodeToBytes(noisy, dict), payload);
});

test('encode produces only words present in the dictionary', async () => {
  const payload = makePayload(11, 20);
  const cover = await encodeToString(payload, dict, { typeStream: weightedTypeStream(dict, { random: mulberry32(5) }) });
  for (const w of cover.split(' ')) {
    assert.ok(lookupWord(dict, w) !== null, `word "${w}" should be in dict`);
  }
});

test('round-trip: case-insensitive on decode', async () => {
  const payload = makePayload(777, 25);
  const cover = await encodeToString(payload, dict, { typeStream: weightedTypeStream(dict, { random: mulberry32(5) }) });
  const upper = cover.toUpperCase();
  assert.deepEqual(await decodeToBytes(upper, dict), payload);
});
