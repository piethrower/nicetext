// Probe: nested-prefix phrase dictionary exposes encoder hole at
// encode.js / encode line 221 (the multi-word atomic path).
//
// Dict has type t with entries "x", "x x", "x x x", "x x x x",
// "x x x x x", every word is a strict prefix of every longer word,
// all in one type. With a 2-word-slot grammar:
//   - slot 1's Huffman picks "x" → buffered, strict-prefix → hold.
//   - slot 2's Huffman picks a multi-word entry like "x x" → enters
//     the line 221 path: flushBuffer() emits the held "x", then
//     fmt.emitWord("x x") atomically.
//   - Cover for the slot pair: "x x x". Decoder greedy-fuses three
//     "x" tokens into one "x x x" entry, reads code("x x x").
//   - Encoder wrote code("x") || code("x x"). Bit accounting breaks.
//
// Expected: with 20 seeds, at least one produces a cover whose
// decoded bytes do not match the original payload (or the
// MAX_NO_PROGRESS_MODELS guard at encode.js:175 throws because every
// pair keeps rewinding).

import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../../js/src/dictionary.js';
import { loadModelTable, modelTableStream } from '../../../js/src/modeltable.js';
import { mulberry32 } from '../../../js/src/random.js';
import { encodeToString, decodeToBytes } from '../_helpers.js';

const TWLIST = [
  { type: 't', word: 'x' },
  { type: 't', word: 'x x' },
  { type: 't', word: 'x x x' },
  { type: 't', word: 'x x x x' },
  { type: 't', word: 'x x x x x' },
];
const dict = loadDictionary(buildDictionary(TWLIST, { name: 'nested-prefix' }));

console.log('phraseIndex:');
for (const [k, v] of dict.phraseIndex) {
  console.log(`  ${k} → ${v.length} candidates, lengths ${v.map(c => c.parts.length).join(',')}`);
}
console.log(`maxPhraseLen: ${dict.maxPhraseLen}`);
console.log('');

// 2 word-slots of type t per sentence + EOS. Drives the encoder
// through the s1-hold + s2-pick path on bit patterns that resolve
// to that combination.
const modelJson = {
  version: 2,
  name: 'nested-prefix-2slot',
  typeNames: ['t'],
  models: [{ tokens: [0, 0, '^. ^'], weight: 1 }],
};
const model = loadModelTable(modelJson);

const payload = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x91, 0x2c, 0xff, 0x00]);
let matches = 0, mismatches = 0, throws = 0;
const samples = [];

for (let seed = 1; seed <= 20; seed++) {
  let cover, recovered;
  try {
    const stream = modelTableStream(model, { random: mulberry32(seed), dict });
    cover = await encodeToString(payload, dict, { modelStream: stream });
    recovered = await decodeToBytes(cover, dict);
  } catch (e) {
    throws++;
    samples.push({ seed, kind: 'throw', error: e.message });
    continue;
  }
  const ok = recovered.length === payload.length &&
    recovered.every((b, i) => b === payload[i]);
  if (ok) {
    matches++;
  } else {
    mismatches++;
    if (samples.length < 5) {
      samples.push({
        seed,
        kind: 'mismatch',
        cover,
        payloadHex: [...payload].map(b => b.toString(16).padStart(2, '0')).join(''),
        recoveredHex: [...recovered].map(b => b.toString(16).padStart(2, '0')).join(''),
      });
    }
  }
}

console.log(`seeds tried: 20`);
console.log(`  matches:    ${matches}`);
console.log(`  mismatches: ${mismatches}`);
console.log(`  throws:     ${throws}`);
console.log('');
for (const s of samples) {
  console.log(JSON.stringify(s, null, 2));
}

if (mismatches === 0 && throws === 0) {
  console.error('\nFAIL: expected at least one mismatch or throw to demonstrate the hole.');
  process.exit(1);
}
console.log(`\nOK: hole reproduced (${mismatches} mismatches, ${throws} throws).`);
