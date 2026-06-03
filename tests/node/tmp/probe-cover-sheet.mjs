// 1c subjective end-to-end sheet: encode the SAME payload through every
// card's shipped dict + model and print the cover. Reads like a side-by-side
// taste test of card voice.

import cardsRegistry from '../../../fixtures/cards.data.js';
import { modelTableStream } from '../../../js/src/modeltable.js';
import { mulberry32 } from '../../../js/src/random.js';
import { encodeToString, loadDictFixture, loadModelTableFixture } from '../_helpers.js';
import { getDictPath, getModelPath } from '../../../js/src/byos.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function pathFor(name, kind) {
  const card = cardsRegistry.find(c => c.name === name);
  const rel = kind === 'model' ? getModelPath(card, cardsRegistry) : getDictPath(card, cardsRegistry);
  return pathToFileURL(join(ROOT, rel));
}

const PAYLOAD_BYTES = 16;
const PAYLOAD_SEED = 2026;

function makePayload(seed, len) {
  const rng = mulberry32(seed);
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = rng() & 0xff;
  return a;
}

const payload = makePayload(PAYLOAD_SEED, PAYLOAD_BYTES);
console.log(`# Cover sheet: ${PAYLOAD_BYTES}-byte payload seed=${PAYLOAD_SEED}, encoded through each card's model\n`);

const cards = cardsRegistry.filter(c => c.story?.style && c.story.style !== 'flat');
for (const card of cards) {
  const dictUrl = pathFor(card.name, 'dict');
  const modelUrl = pathFor(card.name, 'model');
  const dict = loadDictFixture(dictUrl);
  const modelPath = typeof modelUrl === 'string' ? modelUrl : fileURLToPath(modelUrl);
  if (!existsSync(modelPath)) {
    console.log(`## ${card.name}\n(no model fixture)\n`);
    continue;
  }
  const table = loadModelTableFixture(modelUrl);
  const sentenceMode = card.story?.sentence === 'sequential' ? 'sequential' : 'random';
  const stream = modelTableStream(table, {
    dict,
    mode: sentenceMode,
    random: mulberry32(7777),
  });
  try {
    const cover = await encodeToString(payload, dict, { modelStream: stream });
    console.log(`## ${card.name}  [style=${card.story.style}, sentence=${card.story.sentence}]`);
    console.log(cover);
    console.log('');
  } catch (e) {
    console.log(`## ${card.name}\n(encode failed: ${e.message})\n`);
  }
}
