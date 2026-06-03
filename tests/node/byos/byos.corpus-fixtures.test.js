// byos.corpus-fixtures.test.js: every non-flat card in cards.data.js
// must (a) carry a build.corpus pointer, and (b) the corpus fixture
// derived from that pointer must exist on disk under fixtures/. This
// is the regression net for the runtime session-build pipeline
// (js/src/builder/session.js + js/src/worker/build-session-worker.js),
// which fetches `fixtures/{getCorpusFile(card)}` to tokenize a corpus
// for the BYOS Advanced panel rebuilds.
//
// The session-build pipeline itself is browser-only (uses fetch,
// SharedArrayBuffer, Workers), so it cannot be node-tested. This
// test is the cheap proxy: if every non-flat card has a build.corpus
// and the gz exists, the runtime fetch will succeed.

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';
import { existsSync } from '../shims/node-fs.js';
import { fileURLToPath } from '../shims/node-url.js';
import { join, dirname } from '../shims/node-path.js';
import { nodeOnly } from '../_runtime.js';

import cardsRegistry from '../../../fixtures/cards.data.js';
import { getCorpusFile, FIXTURES_PREFIX } from '../../../js/src/byos.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

test('every non-flat card declares build.corpus', () => {
  const missing = [];
  for (const card of cardsRegistry) {
    if (!card.story || card.story.style === 'flat') continue;
    if (!card.build || !card.build.corpus) missing.push(card.name);
  }
  assert.deepEqual(
    missing, [],
    `non-flat cards missing build.corpus: ${missing.join(', ')}`,
  );
});

test('every non-flat card resolves to an existing fixtures/*.txt.gz', nodeOnly('on-disk fixture check'), () => {
  const missing = [];
  for (const card of cardsRegistry) {
    if (!card.story || card.story.style === 'flat') continue;
    const fname = getCorpusFile(card);
    if (!fname) { missing.push(`${card.name}: getCorpusFile returned null`); continue; }
    const path = join(REPO_ROOT, FIXTURES_PREFIX, fname);
    if (!existsSync(path)) missing.push(`${card.name} → ${fname}`);
  }
  assert.deepEqual(
    missing, [],
    `corpus fixtures missing on disk:\n  ${missing.join('\n  ')}`,
  );
});

test('every non-flat story.style maps to exactly one corpus filename', () => {
  // Two cards may share a corpus. What we forbid is two cards with the
  // SAME story.style pointing to DIFFERENT corpus files, which would
  // make the runtime STORY_CORPUS map ambiguous.
  const seen = new Map();
  for (const card of cardsRegistry) {
    if (!card.story || card.story.style === 'flat') continue;
    const fname = getCorpusFile(card);
    if (!fname) continue;
    if (seen.has(card.story.style) && seen.get(card.story.style) !== fname) {
      assert.fail(
        `style "${card.story.style}" maps to both ` +
        `"${seen.get(card.story.style)}" and "${fname}"`,
      );
    }
    seen.set(card.story.style, fname);
  }
});
