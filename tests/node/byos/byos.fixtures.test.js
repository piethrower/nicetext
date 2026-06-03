// byos.fixtures.test.js: every tools/byos/*.byos.json must parse, pass
// strict validation, round-trip through generateBYOSID/generateBYOS, and
// declare a unique byosID across the set. This is the standing
// regression check for the canonical fixture inputs.

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';
import { readFileSync, readdirSync } from '../shims/node-fs.js';
import { fileURLToPath } from '../shims/node-url.js';
import { dirname, join } from '../shims/node-path.js';
import { isNode, nodeOnly } from '../_runtime.js';

import {
  validate, generateBYOSID, generateBYOS,
} from '../../../js/src/byos.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BYOS_DIR = join(HERE, '..', '..', '..', 'tools', 'byos');

// readdirSync is Node-only, skip the enumeration in browser. Tests
// below are marked Node-only too, so empty FILES = no tests register
// in browser, no failures.
const FILES = isNode ? readdirSync(BYOS_DIR)
  .filter(f => f.endsWith('.byos.json'))
  .sort() : [];

test('tools/byos/ contains at least one byos.json fixture', nodeOnly('filesystem walk'), () => {
  // The per-file regression tests below validate every fixture
  // individually (parse + validate + round-trip + unique byosID).
  // The hardcoded canonical-list sanity check that used to live here
  // was a vestige of the hand-maintained STORY_STYLES enum era.
  // Adding a card is now byos.json + bake.
  assert.ok(FILES.length > 0, 'tools/byos/ must contain at least one fixture');
});

const seenIDs = new Map();

for (const f of FILES) {
  test(`${f}: parses, validates, round-trips, byosID is unique`, () => {
    const raw = readFileSync(join(BYOS_DIR, f), 'utf8');
    const byos = JSON.parse(raw);
    validate(byos);
    const id = generateBYOSID(byos);
    const decoded = generateBYOS(id);
    const id2 = generateBYOSID(decoded);
    assert.equal(id2, id, `round-trip drifted: ${id} -> ${id2}`);
    if (seenIDs.has(id)) {
      assert.fail(`byosID collision: ${f} and ${seenIDs.get(id)} both encode to ${id}`);
    }
    seenIDs.set(id, f);
  });
}
