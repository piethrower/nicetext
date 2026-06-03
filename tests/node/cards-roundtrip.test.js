// Engine-level encode/decode round-trip across every card in
// cards.data.js. The byos.fixtures and byos.panel tests cover the
// schema/registry layer; this one closes the gap by actually running
// each shipped dict (and model, where present) through encode/decode
// with a small random payload.
//
// What this catches that nothing else does:
//   . a shipped dict fixture file is missing or unreadable
//   . a dict's Huffman/types shape regresses such that the encoder or
//     decoder fails on that specific corpus
//   . a model fixture exists but has zero usable models against its
//     own dict (modelTableStream throws)
//   . silent fixture drift between cards.data.js and fixtures/ (the
//     fixtureURL helper resolves paths through getDictPath/getModelPath
//     so a stale byosID surfaces as a load failure here)
//
// Two arms per card:
//   (a) dict-only via weightedTypeStream(dict) . validates the dict
//   (b) model-driven via modelTableStream(table,{dict}) . validates
//       the model table when a fixture is shipped.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import cardsRegistry from '../../fixtures/cards.data.js';
import { weightedTypeStream } from '../../js/src/typestream.js';
import { modelTableStream } from '../../js/src/modeltable.js';
import { mulberry32 } from '../../js/src/random.js';
import {
  encodeToString,
  decodeToBytes,
  loadDictFixture,
  loadModelTableFixture,
  fixtureURL,
} from './_helpers.js';

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

assert.ok(cardsRegistry.length > 0, 'cards registry must not be empty');

// Per-card dict + model fixtures are preloaded by the harness via
// tests/node/cards-fixtures.js, so these tests run in both Node and
// the browser harness.
for (const card of cardsRegistry) {
  // ---- dict-only round-trip (every card) -------------------------------
  test(`cards: ${card.name} . dict-only round-trip`, async () => {
    const dictUrl = fixtureURL(card.name, import.meta.url);
    const dict = loadDictFixture(dictUrl);
    const payload = makePayload(card.name.length * 31 + 7, 16);
    const stream = weightedTypeStream(dict, { random: mulberry32(1234) });
    const cover = await encodeToString(payload, dict, { typeStream: stream });
    assert.ok(cover.length > 0, `${card.name}: cover should be non-empty`);
    const recovered = await decodeToBytes(cover, dict);
    assert.deepEqual(recovered, payload, `${card.name}: dict-only payload mismatch`);
  });

  // ---- model-driven round-trip (cards that ship a model) --------------
  // story.style === 'flat' cards (random, mit) don't have a model;
  // skip the model arm for those.
  if (card.story?.style !== 'flat') {
    test(`cards: ${card.name} . model-table round-trip (random mode)`, async () => {
      const dict  = loadDictFixture(fixtureURL(card.name, import.meta.url));
      const table = loadModelTableFixture(fixtureURL(card.name, import.meta.url, 'model'));
      const payload = makePayload(card.name.length * 53 + 11, 16);
      const stream = modelTableStream(table, {
        dict,
        mode: 'random',
        random: mulberry32(5678),
      });
      const cover = await encodeToString(payload, dict, { modelStream: stream });
      assert.ok(cover.length > 0, `${card.name}: cover should be non-empty`);
      const recovered = await decodeToBytes(cover, dict);
      assert.deepEqual(recovered, payload, `${card.name}: model-driven payload mismatch`);
    });
  }
}
