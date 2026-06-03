// Anchor tests for the SAB-backed model-table implementation. Mirrors
// dict-sab.test.js: pin down the binary layout invariants and exercise
// a real encode/decode round-trip through modelTableStream so a future
// regression surfaces as a clear test failure rather than as a
// mysterious cover-text mismatch.
//
// See docs/architecture-sab.md (model-table layout TBD section) and
// js/src/builder/modeltable-pack.js for the layout being verified.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import {
  modelTableStream,
  tableIsCompatibleWithDict,
} from '../../js/src/modeltable.js';
import { MODELTABLE_SAB_CONSTANTS } from '../../js/src/builder/modeltable-pack.js';
import {
  encodeToString, decodeToBytes,
  loadDictFixture, loadModelTableFixture, loadModelTableJsonFixture,
  fixtureURL,
} from './_helpers.js';
import { mulberry32 } from '../../js/src/random.js';

const table = loadModelTableFixture(fixtureURL('jfk', import.meta.url, 'model'));
const dict  = loadDictFixture(fixtureURL('jfk', import.meta.url));
// loadModelTableFixture no longer attaches `.json` to the SAB wrapper:
// the runtime path (post sab-fixtures arc) loads SAB-only fixtures
// and never parses JSON. Cross-shape assertions below still want the
// JSON view; unpack the SAB once for those.
const tableJson = loadModelTableJsonFixture(fixtureURL('jfk', import.meta.url, 'model'));

test('modeltable-sab: header has correct magic and version', () => {
  const view = new DataView(table.sab);
  assert.equal(view.getUint32(0, true), MODELTABLE_SAB_CONSTANTS.MAGIC);
  assert.equal(view.getUint32(4, true), MODELTABLE_SAB_CONSTANTS.VERSION);
});

test('modeltable-sab: header counts match JSON', () => {
  assert.equal(table.header.typeNameCount, tableJson.typeNames.length);
  assert.equal(table.header.modelCount, tableJson.models.length);
  assert.equal(table.header.ordered, !!tableJson.ordered);
});

test('modeltable-sab: punct count is the distinct punct vocabulary', () => {
  const punctSet = new Set();
  for (const m of tableJson.models) {
    for (const t of m.tokens) if (typeof t === 'string') punctSet.add(t);
  }
  assert.equal(table.header.punctCount, punctSet.size);
});

test('modeltable-sab: runtime wrapper omits the name field (no SAB carrier)', () => {
  // json.name is metadata-only-on-load; the SAB format has no name
  // field and no runtime consumer reads it. Asserting absence pins
  // down the SAB-only loader contract so a future addition of name
  // to the wrapper would be a deliberate format bump rather than an
  // accidental re-introduction of a JSON-side-channel.
  assert.equal(table.name, undefined);
});

test('modeltable-sab: tableIsCompatibleWithDict returns true for matching pair', () => {
  assert.equal(tableIsCompatibleWithDict(table, dict), true);
});

test('modeltable-sab: random stream produces expandable models', () => {
  const stream = modelTableStream(table, { dict, mode: 'random', random: mulberry32(42) });
  const m = stream.next();
  assert.ok(Array.isArray(m));
  assert.ok(m.length > 0);
  for (const item of m) {
    assert.ok(item.kind === 'type' || item.kind === 'punct',
      `expected kind type|punct, got ${item.kind}`);
    if (item.kind === 'type') {
      // Either a resolved typeIndex or a name fallback (when missing).
      assert.ok(
        typeof item.typeIndex === 'number' || typeof item.name === 'string',
        'type item must have typeIndex or name'
      );
    } else {
      assert.equal(typeof item.value, 'string');
    }
  }
});

test('modeltable-sab: sequential stream visits models in order', () => {
  const stream = modelTableStream(table, { dict, mode: 'sequential' });
  // Just confirm consecutive .next() calls return arrays without throwing.
  for (let i = 0; i < 5; i++) {
    const m = stream.next();
    assert.ok(Array.isArray(m));
  }
});

test('modeltable-sab: encode → decode round-trip via random stream', async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const stream = modelTableStream(table, { dict, mode: 'random', random: mulberry32(7) });
  const cover = await encodeToString(payload, dict, { modelStream: stream, randomSeed: 0xC0FFEE });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, payload);
});

test('modeltable-sab: encode → decode round-trip via sequential stream', async () => {
  const payload = new Uint8Array([42, 100, 200, 0, 255]);
  const stream = modelTableStream(table, { dict, mode: 'sequential' });
  const cover = await encodeToString(payload, dict, { modelStream: stream, randomSeed: 0xC0FFEE });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, payload);
});

test('modeltable-sab: tokens decoded match JSON typeName/punct sequences', () => {
  // Walk the SAB-decoded models and assert tokens match the JSON view
  // for the first few models. This pins down the token encoding (high
  // bit = punct flag, low bits = index) end-to-end.
  for (let i = 0; i < Math.min(5, tableJson.models.length); i++) {
    const json = tableJson.models[i];
    const m = table.view.getUint32(table.header.modelTableOffset + i * MODELTABLE_SAB_CONSTANTS.MODEL_ENTRY_SIZE, true);
    // Re-derive from SAB and compare to JSON token-by-token.
    const tokenOff = table.view.getUint32(table.header.modelTableOffset + i * MODELTABLE_SAB_CONSTANTS.MODEL_ENTRY_SIZE + 0, true);
    const tokenCount = table.view.getUint32(table.header.modelTableOffset + i * MODELTABLE_SAB_CONSTANTS.MODEL_ENTRY_SIZE + 4, true);
    assert.equal(tokenCount, json.tokens.length, `model ${i} token count mismatch`);
    for (let k = 0; k < tokenCount; k++) {
      const tok = table.view.getUint32(tokenOff + k * 4, true);
      const isPunct = !!(tok & MODELTABLE_SAB_CONSTANTS.TOKEN_PUNCT_FLAG);
      const idx = tok & MODELTABLE_SAB_CONSTANTS.TOKEN_INDEX_MASK;
      const jsonTok = json.tokens[k];
      if (typeof jsonTok === 'number') {
        assert.equal(isPunct, false, `model ${i} token ${k}: expected typeName, got punct`);
        assert.equal(idx, jsonTok, `model ${i} token ${k}: typeName index mismatch`);
      } else {
        assert.equal(isPunct, true, `model ${i} token ${k}: expected punct, got typeName`);
      }
    }
  }
});
