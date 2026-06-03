// Cross-card preclean idempotency smoke. For every shipped card,
// encode a small random payload and assert that precleanCorpus(suspected)
// === suspected. This proves the strong-signal claim that Eve's
// `isNiceText` detector relies on: bytes a real NiceText engine
// emits are preclean-stable.
//
// If any card produces a non-idempotent suspected, that surfaces a real
// engine bug (not an Eve bug). When the assertion fails, file it
// against the engine and downgrade Eve's `isNiceText` confidence
// from strong to weak until the bug is fixed.
//
// Per-card dict fixtures are preloaded by the harness via
// tests/node/cards-fixtures.js, so this runs cross-runtime.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import cardsRegistry from '../../fixtures/cards.data.js';
import { weightedTypeStream } from '../../js/src/typestream.js';
import { mulberry32 } from '../../js/src/random.js';
import { precleanCorpus } from '../../js/src/builder/precleanCorpus.js';
import {
  encodeToString,
  loadDictFixture,
  fixtureURL,
} from './_helpers.js';

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

assert.ok(cardsRegistry.length > 0, 'cards registry must not be empty');

for (const card of cardsRegistry) {
  test(
    `eve isNiceText invariant: ${card.name} suspected is preclean-idempotent`,
    async () => {
      const dictUrl = fixtureURL(card.name, import.meta.url);
      const dict = loadDictFixture(dictUrl);
      const payload = makePayload(card.name.length * 17 + 3, 32);
      const stream = weightedTypeStream(dict, { random: mulberry32(987) });
      const suspected = await encodeToString(payload, dict, { typeStream: stream });
      assert.ok(suspected.length > 0, `${card.name}: suspected should be non-empty`);
      const precleaned = precleanCorpus(suspected);
      assert.equal(
        precleaned,
        suspected,
        `${card.name}: suspected should be preclean-idempotent (engine emits preclean-stable bytes by design). ` +
        `If this fails, file an engine bug and downgrade Eve isNiceText confidence.`,
      );
    },
  );
}
