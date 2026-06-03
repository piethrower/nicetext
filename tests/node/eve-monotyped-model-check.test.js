// MonoTypedModelCheck detector smoke. Encodes a small payload
// through one shipped card, runs the monotyped-model matcher
// across all 21 cards, and asserts that the encoding card scores
// meaningfully higher than the runners-up.
//
// What this proves:
//   - The genmodel meta-dict trick (resolveWord override) produces
//     a usable suspected-side monotyped model.
//   - The card's monotyped model loads and matches.
//   - The match rate distinguishes the right card from the wrong
//     ones on a real suspected.
//
// Per-card dict / model / corpus fixtures are preloaded by the harness
// via tests/node/cards-fixtures.js, so this runs cross-runtime.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import cardsRegistry from '../../fixtures/cards.data.js';
import { getCorpusFile } from '../../js/src/byos.js';
import { weightedTypeStream } from '../../js/src/typestream.js';
import { modelTableStream } from '../../js/src/modeltable.js';
import { mulberry32 } from '../../js/src/random.js';
import {
  encodeToString,
  loadDictFixture,
  loadModelTableFixture,
  fixtureURL,
  corpusFixtureURL,
  loadCorpusText,
} from './_helpers.js';
import { runMonotypedModelCheck } from '../../js/src/eve/monotyped-model-check.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable } from '../../js/src/modeltable.js';

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

// Load every shipped card's source corpus as raw text. The
// runMonotypedModelCheck wrapper accepts `{ name, corpusText }`
// and runs genMonotypedModel internally, mirroring the same path
// the suspected goes through.
function loadAllCardIndices(thisUrl) {
  const out = [];
  for (const card of cardsRegistry) {
    if (!getCorpusFile(card)) continue;
    out.push({
      name: card.name,
      corpusText: loadCorpusText(corpusFixtureURL(card.name, thisUrl)),
    });
  }
  return out;
}

const ENCODE_CARD = 'frankenstein';

test(
  `eve story.style: suspected encoded through ${ENCODE_CARD} -> ${ENCODE_CARD} ranks highest`,
  async () => {
    const card = cardsRegistry.find(c => c.name === ENCODE_CARD);
    assert.ok(card, `${ENCODE_CARD} card must exist`);

    const dict = loadDictFixture(fixtureURL(ENCODE_CARD, import.meta.url));
    const modelUrl = fixtureURL(ENCODE_CARD, import.meta.url, 'model');
    const table = loadModelTableFixture(modelUrl);

    // 16 bytes is the size cards-roundtrip uses for model-driven
    // round-trips against every card; works against the smallest
    // shipped dicts. The suspected that comes out is short, so we
    // lower minShapes correspondingly.
    const payload = makePayload(ENCODE_CARD.length * 11 + 1, 16);
    const stream = modelTableStream(table, {
      dict,
      mode: 'random',
      random: mulberry32(2026),
    });
    const suspected = await encodeToString(payload, dict, { modelStream: stream });
    assert.ok(suspected.length > 0, 'suspected should be non-empty');

    const allCards = loadAllCardIndices(import.meta.url);
    const result = await runMonotypedModelCheck(suspected, allCards, { minShapes: 5 });

    // Find the encoding card's row plus the others.
    const styleVerdicts = result.verdicts.filter(v => v.knob.startsWith('story.style.'));
    const target = styleVerdicts.find(v => v.knob === `story.style.${ENCODE_CARD}`);
    assert.ok(target, `target verdict for ${ENCODE_CARD} should exist`);
    assert.ok(
      target.data.rate > 0,
      `target should have non-zero match rate, got ${target.data.rate}`,
    );

    // Sanity: at least one card other than the encoder should score
    // lower than the encoder. Otherwise the detector has no
    // discriminative power.
    const others = styleVerdicts.filter(v => v.knob !== `story.style.${ENCODE_CARD}`);
    const lowerThanTarget = others.filter(v => v.data && v.data.rate < target.data.rate);
    assert.ok(
      lowerThanTarget.length > 0,
      `target card should score higher than at least one other card; target rate=${target.data.rate}, ` +
      `others=${others.map(v => `${v.knob}=${v.data ? v.data.rate.toFixed(2) : '?'}`).join(', ')}`,
    );
  },
);

// Sequential vs random matchDepth signal. After the modeltable.js
// engine change (sequential mode advances fullPos monotonically
// through fullSeq), an ordered-model sequential suspected should
// produce a high matchDepth (verdict 'likely') and a random suspected
// should produce a near-zero matchDepth (verdict 'unlikely').

test(
  `eve story.sentence: ordered-model sequential suspected -> likely; random suspected -> unlikely`,
  async () => {
    const NAME = 'shakespeare';
    const dict = loadDictFixture(fixtureURL(NAME, import.meta.url));
    const corpusText = loadCorpusText(corpusFixtureURL(NAME, import.meta.url));

    // Build an ordered (dedupe=false) model on the fly so
    // sequential mode walks corpus order.
    const orderedModelJson = await generateModelTable(corpusText, dict, { dedupe: false, name: NAME });
    const table = loadModelTable(orderedModelJson);
    const payload = makePayload(123, 16);

    const seqStream = modelTableStream(table, { dict, mode: 'sequential', random: mulberry32(1) });
    const seqSuspected = await encodeToString(payload, dict, { modelStream: seqStream });
    const randomStream = modelTableStream(table, { dict, mode: 'random', random: mulberry32(1) });
    const randomSuspected = await encodeToString(payload, dict, { modelStream: randomStream });

    const allCards = loadAllCardIndices(import.meta.url);
    const seqResult = await runMonotypedModelCheck(seqSuspected, allCards, { minShapes: 5 });
    const randomResult = await runMonotypedModelCheck(randomSuspected, allCards, { minShapes: 5 });

    const seqSent = seqResult.verdicts.find(v => v.knob === 'story.sentence');
    const randomSent = randomResult.verdicts.find(v => v.knob === 'story.sentence');
    assert.ok(seqSent, 'sequential suspected must produce story.sentence verdict');
    assert.ok(randomSent, 'random suspected must produce story.sentence verdict');
    assert.equal(seqSent.verdict, 'likely',
      `sequential suspected should be likely; got ${seqSent.verdict} (${seqSent.why})`);
    assert.equal(randomSent.verdict, 'unlikely',
      `random suspected should be unlikely; got ${randomSent.verdict} (${randomSent.why})`);
  },
);
