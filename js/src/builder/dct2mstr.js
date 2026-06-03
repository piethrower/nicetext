// dct2mstr: MTWLIST → JSON dictionary with per-type Huffman codes.
//
// Per type, we Huffman-encode all words (no power-of-2 truncation; every
// word is reachable). Word weights come from `frequencies` (Map<word, count>);
// any word missing from the map is treated as weight 1.
//
// Result: every word has its own (code, bits) pair. Common words (high
// weight) get short codes, when the encoder reads random-looking bits,
// short-code words are picked more often, so the cover text auto-Zipfs.
//
// JSON schema (version 2):
//   {
//     "version": 2,
//     "name": "shakespeare",
//     "types": [ { "index": 1, "name": "noun", "wordCount": 4096 } ],
//     "words": [ { "word": "the", "typeIndex": 1, "code": 0, "bits": 1 } ]
//   }
//
// Notes:
//   - Type records no longer carry `bitCount` (codes are variable per word).
//   - Single-word types: bits=0, code=0 (encoder consumes no bits, decoder
//     writes none). Same as the old single-word behavior.
//
// Browser-safe ESM. No Node deps.

import { buildHuffman, verifyHuffman } from './huffman.js';

export function buildDictionary(mtwlist, opts = {}) {
  const { name = 'unnamed', frequencies = null, tieBreak = 'alpha-asc' } = opts;

  const typeToWords = new Map();
  for (const { type, word } of mtwlist) {
    if (!typeToWords.has(type)) typeToWords.set(type, []);
    typeToWords.get(type).push(word);
  }

  const types = [];
  const words = [];
  let typeIndex = 1; // 0 reserved (matches OG dct2mstr)

  const sortedTypes = [...typeToWords.keys()].sort();
  const getWeight = (w) =>
    frequencies && frequencies.has(w) ? frequencies.get(w) : 1;

  // Per-type input ordering before Huffman. The heap in huffman.js
  // ties on `order ASC`, so the LAST-inserted word in a tied weight
  // group ends up at the SHALLOWEST slot. To put short words at
  // shallow slots, sort longest-first so they're inserted earlier
  // (deeper) and shortest-last (shallower). See research-notes §12.1.
  const sortWords = tieBreak === 'length-desc'
    ? (ws) => ws.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    : (ws) => ws.sort();

  for (const typeName of sortedTypes) {
    const wordsOfType = sortWords([...typeToWords.get(typeName)]);
    if (wordsOfType.length === 0) continue;

    // Build Huffman codes weighted by per-word frequency.
    const items = wordsOfType.map(w => ({ item: w, weight: getWeight(w) }));
    const coded = buildHuffman(items);
    verifyHuffman(coded); // sanity check: prefix-free + Kraft

    types.push({ index: typeIndex, name: typeName, wordCount: wordsOfType.length });
    for (const { item, code, bits } of coded) {
      words.push({ word: item, typeIndex, code, bits });
    }
    typeIndex++;
  }

  return { version: 2, name, types, words };
}

// buildDictionaryAsync(mtwlist, opts), yielding variant.
//
// Same return shape as buildDictionary; yields to the event loop and
// emits onProgress every ~yieldEveryWords words processed across the
// type-by-type Huffman loop. The mtwlist scan is fast and runs sync;
// the per-type Huffman + word push is where the time goes on big
// dicts (3M+ words).
//
// opts: { name, frequencies, tieBreak, onProgress, yieldEveryWords, signal }
//   onProgress event shape:
//     { phase:'builddict-start', total }
//     { phase:'builddict-progress', i, total }   tick by words processed
//     { phase:'builddict-end',   total }
export async function buildDictionaryAsync(mtwlist, opts = {}) {
  const { name = 'unnamed', frequencies = null, tieBreak = 'alpha-asc' } = opts;
  const onProgress = opts.onProgress ?? null;
  const yieldEveryWords = opts.yieldEveryWords ?? 50_000;
  const signal = opts.signal ?? null;

  const typeToWords = new Map();
  for (const { type, word } of mtwlist) {
    if (!typeToWords.has(type)) typeToWords.set(type, []);
    typeToWords.get(type).push(word);
  }

  const totalWords = mtwlist.length;
  if (onProgress) onProgress({ phase: 'builddict-start', total: totalWords });

  const types = [];
  const words = [];
  let typeIndex = 1;

  const sortedTypes = [...typeToWords.keys()].sort();
  const getWeight = (w) =>
    frequencies && frequencies.has(w) ? frequencies.get(w) : 1;
  const sortWords = tieBreak === 'length-desc'
    ? (ws) => ws.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    : (ws) => ws.sort();

  let processedSinceYield = 0;
  let totalProcessed = 0;
  for (const typeName of sortedTypes) {
    const wordsOfType = sortWords([...typeToWords.get(typeName)]);
    if (wordsOfType.length === 0) continue;

    const items = wordsOfType.map(w => ({ item: w, weight: getWeight(w) }));
    const coded = buildHuffman(items);
    verifyHuffman(coded);

    types.push({ index: typeIndex, name: typeName, wordCount: wordsOfType.length });
    for (const { item, code, bits } of coded) {
      words.push({ word: item, typeIndex, code, bits });
    }
    typeIndex++;

    processedSinceYield += wordsOfType.length;
    totalProcessed += wordsOfType.length;
    if (processedSinceYield >= yieldEveryWords) {
      processedSinceYield = 0;
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({
        phase: 'builddict-progress', i: totalProcessed, total: totalWords,
      });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (onProgress) onProgress({ phase: 'builddict-end', total: totalWords });
  return { version: 2, name, types, words };
}

function makeAbort() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
