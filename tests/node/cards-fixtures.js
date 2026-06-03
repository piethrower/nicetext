// Per-card fixture URL list, derived from fixtures/cards.data.js and
// the canonical path helpers in js/src/byos.js. The harness preloads
// these alongside the manifest's static `fixtures` list so card-driven
// tests (cards-roundtrip, eve-monotyped-model-check,
// eve-preclean-idempotency) run unchanged in the browser harness.
//
// Source of truth: cards.data.js (auto-generated from tools/byos/).
// Adding or removing a card here is a no-op; this file recomputes
// from the registry every time.

import cardsRegistry from '../../fixtures/cards.data.js';
import { getDictPath, getModelPath, getCorpusPath } from '../../js/src/byos.js';

// Paths returned are relative to tests/node/ (the manifest's anchor
// directory), so the harness can resolve them against MANIFEST_URL
// identically to manifest-declared fixtures.
export function cardFixturePaths() {
  const paths = [];
  for (const card of cardsRegistry) {
    paths.push(`../../${getDictPath(card, cardsRegistry)}`);
    if (card.story?.style !== 'flat') {
      paths.push(`../../${getModelPath(card, cardsRegistry)}`);
    }
    const corpus = getCorpusPath(card);
    if (corpus) paths.push(`../../${corpus}`);
  }
  return paths;
}
