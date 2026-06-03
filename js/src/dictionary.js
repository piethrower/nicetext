// Dictionary loader. Packs the JSON into a SharedArrayBuffer (or
// ArrayBuffer fallback) using the layout in docs/architecture-sab.md,
// and returns a dict object whose lookups read directly from bytes via
// DataView. No Map<word>, no Map<typeIndex,...>: workers can share the
// same dict ref without re-parsing.
//
// Browser-safe ESM. No Node deps.

import { packDictToSAB, SAB_CONSTANTS } from './builder/sab-pack.js';

const {
  MAGIC, VERSION, HEADER_SIZE,
  TYPE_ENTRY_SIZE, NODE_SIZE,
  BYWORD_ENTRY_SIZE, BYTYPENAME_ENTRY_SIZE,
  NO_NODE, NO_WORD,
} = SAB_CONSTANTS;

const POOL_LEN_PREFIX_SIZE = 2;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// Read header fields off the SAB into a plain object; cached on the
// dict so callers don't pay DataView reads per lookup for header bits.
function readHeader(view) {
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `dictionary: bad SAB magic 0x${magic.toString(16)} (expected NTDC)`
    );
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`dictionary: unsupported SAB version ${version}`);
  }
  return {
    typeCount:        view.getUint32(8, true),
    wordCount:        view.getUint32(12, true),
    maxWordLength:    view.getUint32(16, true),
    typeTableOffset:  view.getUint32(20, true),
    byWordOffset:     view.getUint32(24, true),
    byTypeNameOffset: view.getUint32(28, true),
    stringPoolOffset: view.getUint32(32, true),
    stringPoolLength: view.getUint32(36, true),
  };
}

// Build the dict from a parsed JSON object. JSON is retained on the
// dict so callers (notably build-time tools) that still need
// json.types or json.words can reach them; the runtime engine never
// touches json after pack.
export function loadDictionary(json) {
  const sab = packDictToSAB(json);
  const dict = wrapDictionaryFromSAB(sab);
  dict.json = json;
  return dict;
}

// Wrap a previously-packed dict SAB into the runtime dict object,
// without re-packing. Used by workers that receive a SAB ref from the
// parent's resource cache: they construct the runtime wrapper without
// JSON.parse or pack costs. Works for either a SharedArrayBuffer or a
// plain ArrayBuffer with the same byte layout.
export function wrapDictionaryFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const header = readHeader(view);
  const dict = {
    sab, view, bytes, header,
    maxWordLength: header.maxWordLength,
  };
  // Step 4 (phrase-and-charset arc): scan the byWord index once at
  // load time for multi-word entries (those whose value contains a
  // space). Build a Map keyed by first-word → list of phrase entries
  // sorted longest-first, plus a maxPhraseLen counter. Both the lexer
  // (for greedy longest-match fusion at decode time) and the encoder
  // (for peek-and-buffer phrase-detection) consume these.
  const { phraseIndex, maxPhraseLen } = buildPhraseIndex(dict);
  dict.phraseIndex = phraseIndex;
  dict.maxPhraseLen = maxPhraseLen;
  return dict;
}

// Walk the byWord index for multi-word entries. Returns
// { phraseIndex, maxPhraseLen }, phraseIndex is a Map<firstWord,
// Array<{parts, canonical}>>, sorted longest-first within each bucket
// so greedy longest-match consumers iterate in the right order.
// maxPhraseLen is the count of WORDs in the longest phrase (0 if no
// phrases). Both are empty / 0 when the dict has no multi-word entries
// (the common case before any source ships phrases).
function buildPhraseIndex(dict) {
  const phraseIndex = new Map();
  let maxPhraseLen = 0;
  const W = dict.header.wordCount;
  const base = dict.header.byWordOffset;
  const view = dict.view;
  for (let i = 0; i < W; i++) {
    const off = base + i * BYWORD_ENTRY_SIZE;
    const poolOff = view.getUint32(off + 0, true);
    const word = readPoolString(dict, poolOff);
    if (!word.includes(' ')) continue;
    const parts = word.split(' ');
    if (parts.length > maxPhraseLen) maxPhraseLen = parts.length;
    let arr = phraseIndex.get(parts[0]);
    if (!arr) { arr = []; phraseIndex.set(parts[0], arr); }
    arr.push({ parts, canonical: word });
  }
  // Sort each bucket longest-first so greedy longest-match consumers
  // can short-circuit on the first match.
  for (const arr of phraseIndex.values()) {
    arr.sort((a, b) => b.parts.length - a.parts.length);
  }
  return { phraseIndex, maxPhraseLen };
}

// Enumerate every word string in the dict, in byWord (alphabetical)
// order. Used by build-time tools (e.g. tools/build-freq-fixtures.js)
// that need the vocab set from a packed SAB dict without re-parsing a
// JSON intermediate. Walks the byWord index once and decodes each
// pool entry via readPoolString. O(W) with one TextDecoder.decode per
// word: fine for tool-scale use; not on any runtime hot path.
export function listDictWords(dict) {
  const W = dict.header.wordCount;
  const base = dict.header.byWordOffset;
  const view = dict.view;
  const out = new Array(W);
  for (let i = 0; i < W; i++) {
    const off = base + i * BYWORD_ENTRY_SIZE;
    const poolOff = view.getUint32(off + 0, true);
    out[i] = readPoolString(dict, poolOff);
  }
  return out;
}

// Compute summary stats for a wrapped dict. Walks the byWord index
// for total/max bits; type and word counts come from the header.
// O(W) over a u16 read per word, fast enough for per-selection
// surfacing without precomputed sidecars.
export function dictStats(dict) {
  const { wordCount, typeCount, byWordOffset } = dict.header;
  let totalBits = 0;
  let maxBits = 0;
  const view = dict.view;
  for (let i = 0; i < wordCount; i++) {
    const off = byWordOffset + i * BYWORD_ENTRY_SIZE;
    const bits = view.getUint16(off + 6, true);
    totalBits += bits;
    if (bits > maxBits) maxBits = bits;
  }
  return {
    wordCount,
    typeCount,
    avgBits: wordCount ? totalBits / wordCount : 0,
    maxBits,
    sabBytes: dict.sab.byteLength,
  };
}

// Read a length-prefixed UTF-8 string from the pool at the given
// pool-relative offset.
//
// `slice` (not `subarray`) is required when dict.bytes is backed by
// a SharedArrayBuffer: TextDecoder.decode refuses to read views over
// shared memory. slice() copies the bytes into a fresh non-shared
// ArrayBuffer. For ArrayBuffer-backed dicts the slice is also a copy
// but the cost is negligible (small string lengths).
function readPoolString(dict, poolRelOffset) {
  const off = dict.header.stringPoolOffset + poolRelOffset;
  const len = dict.bytes[off] | (dict.bytes[off + 1] << 8);
  return DECODER.decode(dict.bytes.slice(off + 2, off + 2 + len));
}

// Compare a query bytes Uint8Array against a pool entry at
// poolRelOffset. Returns negative / zero / positive like memcmp.
function compareQueryToPool(queryBytes, dict, poolRelOffset) {
  const off = dict.header.stringPoolOffset + poolRelOffset;
  const entryLen = dict.bytes[off] | (dict.bytes[off + 1] << 8);
  const dataOff = off + POOL_LEN_PREFIX_SIZE;
  const minLen = Math.min(queryBytes.length, entryLen);
  for (let i = 0; i < minLen; i++) {
    const a = queryBytes[i];
    const b = dict.bytes[dataOff + i];
    if (a !== b) return a - b;
  }
  return queryBytes.length - entryLen;
}

// Read a type-table entry by typeIndex (1-based). Returns a typeRecord
// shape: { typeIndex, name, wordCount, treeNodeOffset, treeNodeCount, ... }.
// `name` is a lazy getter: hot paths (the encoder, the typestream)
// that only need typeIndex/wordCount/treeNode* avoid the string-pool
// decode. Returns null if typeIndex is out of range.
export function lookupType(dict, typeIndex) {
  if (typeIndex < 1 || typeIndex > dict.header.typeCount) return null;
  const off = dict.header.typeTableOffset + (typeIndex - 1) * TYPE_ENTRY_SIZE;
  const view = dict.view;
  const nameOff = view.getUint32(off + 0, true);
  const nameLen = view.getUint16(off + 4, true);
  const rec = {
    typeIndex:      view.getUint32(off + 20, true),
    nameOffset:     nameOff,
    nameLength:     nameLen,
    wordCount:      view.getUint32(off + 8, true),
    treeNodeOffset: view.getUint32(off + 12, true),
    treeNodeCount:  view.getUint32(off + 16, true),
  };
  Object.defineProperty(rec, 'name', {
    enumerable: true,
    get: () => readPoolString(dict, nameOff),
  });
  return rec;
}

// Look up a type by name. Binary search over the byTypeName index.
export function lookupTypeByName(dict, name) {
  const T = dict.header.typeCount;
  if (T === 0) return null;
  const queryBytes = ENCODER.encode(name);
  const base = dict.header.byTypeNameOffset;
  let lo = 0, hi = T;
  const view = dict.view;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const off = base + mid * BYTYPENAME_ENTRY_SIZE;
    const nameOff = view.getUint32(off + 0, true);
    const cmp = compareQueryToPool(queryBytes, dict, nameOff);
    if (cmp < 0) hi = mid;
    else if (cmp > 0) lo = mid + 1;
    else {
      const typeIndex = view.getUint32(off + 8, true);
      return lookupType(dict, typeIndex);
    }
  }
  return null;
}

// Look up a word's encoding. Returns {typeIndex, code, bits} or null.
export function lookupWord(dict, word) {
  const W = dict.header.wordCount;
  if (W === 0) return null;
  const queryBytes = ENCODER.encode(word);
  const base = dict.header.byWordOffset;
  let lo = 0, hi = W;
  const view = dict.view;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const off = base + mid * BYWORD_ENTRY_SIZE;
    const stringOff = view.getUint32(off + 0, true);
    const cmp = compareQueryToPool(queryBytes, dict, stringOff);
    if (cmp < 0) hi = mid;
    else if (cmp > 0) lo = mid + 1;
    else {
      return {
        typeIndex: view.getUint32(off + 8, true),
        code:      view.getUint32(off + 12, true),
        bits:      view.getUint16(off + 6, true),
      };
    }
  }
  return null;
}

// Read a tree node within a type's node array. Returns
// { leftChild, rightChild, word | null }.
//
// For leaves, word is the resolved string; the encoder's hot loop
// pays one DataView read for the children plus a string decode at
// each leaf. The decoded string is cheap because pool entries are
// length-prefixed and TextDecoder over a small subarray is fast.
export function readTreeNode(dict, typeRec, nodeIdx) {
  const off = typeRec.treeNodeOffset + nodeIdx * NODE_SIZE;
  const view = dict.view;
  const leftChild  = view.getUint32(off + 0, true);
  const rightChild = view.getUint32(off + 4, true);
  const wordOffset = view.getUint32(off + 8, true);
  const word = wordOffset === NO_WORD ? null : readPoolString(dict, wordOffset);
  return { leftChild, rightChild, word };
}

// Sentinels exposed for callers that walk trees themselves.
export const TREE_NO_NODE = NO_NODE;
