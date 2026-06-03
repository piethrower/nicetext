// Type streams, yield a sequence of types for the encoder to fill with
// words. Reads from the SAB-backed dict's type table; no JSON access.
// Browser-safe ESM. No Node deps.

import { lookupType } from './dictionary.js';

// "Encoding type" = wordCount > 1 (anything with at least 2 words can carry
// bits via Huffman). Single-word types are skipped by default.

// Pick a type uniformly weighted by wordCount (types with more words usually
// carry more bits per pick → better cover-text density).
export function weightedTypeStream(dict, { random = Math.random, onlyEncoding = true } = {}) {
  const T = dict.header.typeCount;
  const indices = [];
  const weights = [];
  let total = 0;
  for (let i = 1; i <= T; i++) {
    const t = lookupType(dict, i);
    if (onlyEncoding && t.wordCount <= 1) continue;
    indices.push(i);
    weights.push(t.wordCount);
    total += t.wordCount;
  }
  if (indices.length === 0) {
    throw new Error('typestream: no encoding types in dictionary');
  }
  return {
    next() {
      const r = random() * total;
      let acc = 0;
      for (let i = 0; i < indices.length; i++) {
        acc += weights[i];
        if (r < acc) return { typeIndex: indices[i], wordCount: weights[i] };
      }
      const last = indices.length - 1;
      return { typeIndex: indices[last], wordCount: weights[last] };
    },
  };
}

// Cycle through every encoding type once each. Deterministic; useful for tests.
export function roundRobinTypeStream(dict, { onlyEncoding = true } = {}) {
  const T = dict.header.typeCount;
  const indices = [];
  for (let i = 1; i <= T; i++) {
    const t = lookupType(dict, i);
    if (onlyEncoding && t.wordCount <= 1) continue;
    indices.push({ typeIndex: i, wordCount: t.wordCount });
  }
  if (indices.length === 0) {
    throw new Error('typestream: no encoding types in dictionary');
  }
  let i = 0;
  return {
    next() {
      const t = indices[i];
      i = (i + 1) % indices.length;
      return t;
    },
  };
}
