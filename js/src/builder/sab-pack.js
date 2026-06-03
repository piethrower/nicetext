// SAB binary packer for dict JSON. Produces a SharedArrayBuffer that the
// runtime engine reads via byte-offset arithmetic, no Map, no per-worker
// parsed copy. See docs/architecture-sab.md for layout and rationale.
//
// Browser-safe ESM. No Node deps. No fs, no Buffer, no process.

import { mergesortAsync } from './mergesort-async.js';

const MAGIC = 0x4344544E; // "NTDC" little-endian
const VERSION = 1;
const NO_NODE = 0xFFFFFFFF;
const NO_WORD = 0xFFFFFFFF;

// Lexicographic compare of two Uint8Array byte sequences. Returns
// negative / 0 / positive in the same shape as Array#sort comparators.
function compareBytes(a, b) {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// Header layout (40 bytes):
//   0  magic         u32 ("NTDC" LE)
//   4  version       u32
//   8  typeCount     u32  (T)
//  12  wordCount     u32  (W)
//  16  maxWordLength u32
//  20  typeTableOff  u32  (T entries)
//  24  byWordOff     u32  (W entries, sorted by word for binary search)
//  28  byTypeNameOff u32  (T entries, sorted by name for binary search)
//  32  stringPoolOff u32
//  36  stringPoolLen u32
const HEADER_SIZE = 40;

// Type table entry (24 bytes per type, indexed by (typeIndex - 1)):
//   0  nameOffset      u32
//   4  nameLength      u16
//   6  (reserved)      u16
//   8  wordCount       u32
//  12  treeNodeOffset  u32  (byte offset, not entry index)
//  16  treeNodeCount   u32
//  20  index           u32  (the type's own typeIndex; redundant, easy)
const TYPE_ENTRY_SIZE = 24;

// Tree node (12 bytes): two child indices (relative to this type's node
// array) and a wordOffset into the string pool. Sentinel value 0xFFFFFFFF
// means "no child" (for leaves) or "internal node" (for wordOffset).
const NODE_SIZE = 12;

// byWord entry (16 bytes), sorted alphabetically by word for binary search:
//   0  stringOffset  u32
//   4  length        u16
//   6  bits          u16
//   8  typeIndex     u32
//  12  code          u32
const BYWORD_ENTRY_SIZE = 16;

// byTypeName entry (12 bytes), sorted alphabetically by name:
//   0  nameOffset    u32
//   4  length        u16
//   6  (reserved)    u16
//   8  typeIndex     u32
const BYTYPENAME_ENTRY_SIZE = 12;

export const SAB_CONSTANTS = {
  MAGIC, VERSION, HEADER_SIZE,
  TYPE_ENTRY_SIZE, NODE_SIZE,
  BYWORD_ENTRY_SIZE, BYTYPENAME_ENTRY_SIZE,
  NO_NODE, NO_WORD,
};

// Build an in-memory Huffman tree per type from the JSON's per-word
// (bits, code) pairs. Each leaf records its wordOffset (filled in once
// the string pool is built). Internal nodes have wordOffset = NO_WORD.
function buildTreeForType(words) {
  // Single-word type: one leaf, no path.
  if (words.length === 1) {
    return { root: { left: null, right: null, wordOffset: NO_WORD, _word: words[0] } };
  }
  const root = { left: null, right: null, wordOffset: NO_WORD };
  for (const w of words) {
    let node = root;
    if (w.bits === 0) {
      // wordCount > 1 but bits=0 would be a malformed code. Should not
      // occur in valid dicts; let the encoder loop's bounds check catch
      // it if it ever does.
      throw new Error(
        `sab-pack: word "${w.word}" in type ${w.typeIndex} has bits=0 but type has multiple words`
      );
    }
    // Walk MSB-first. Use division (not bit-shift) because bits can
    // exceed 30 and JS bit operators truncate to 32-bit signed.
    let mask = Math.pow(2, w.bits - 1);
    let code = w.code;
    for (let i = 0; i < w.bits; i++) {
      const bit = code >= mask ? 1 : 0;
      if (bit === 1) code -= mask;
      mask /= 2;
      let child = bit === 0 ? node.left : node.right;
      if (!child) {
        child = { left: null, right: null, wordOffset: NO_WORD };
        if (bit === 0) node.left = child; else node.right = child;
      }
      node = child;
    }
    node._word = w; // attach for later wordOffset assignment
  }
  return { root };
}

// DFS the tree, assign each node a contiguous index, return nodes in
// index order so the writer can emit them with their child indices.
function flattenTree(root) {
  const nodes = [];
  function visit(n) {
    n._idx = nodes.length;
    nodes.push(n);
    if (n.left) visit(n.left);
    if (n.right) visit(n.right);
  }
  visit(root);
  return nodes;
}

// Convert a JS string to UTF-8 bytes.
const ENCODER = new TextEncoder();

// String pool entries are length-prefixed (u16 length, then bytes), so a
// reader with just an offset can decode the string. byWord and
// byTypeName indexes don't need to carry length redundantly.
const POOL_LEN_PREFIX_SIZE = 2;

// packDictToSAB(json) -> SharedArrayBuffer.
//
// json is the parsed dict JSON object (version 2). The returned SAB
// is immediately readable by loadDictionary(); see js/src/dictionary.js.
//
// Sync. For big dicts (3M+ words) prefer packDictToSABAsync, which
// yields to the event loop every 50K items in the word-bound loops
// and emits onProgress events so a progress modal can tick through
// the pack rather than going silent for 20+ seconds.
export function packDictToSAB(json) {
  if (!json || json.version !== 2) {
    throw new Error(`sab-pack: unsupported dict version ${json && json.version}`);
  }
  const types = json.types;
  const words = json.words;
  const T = types.length;
  const W = words.length;

  // Validate types are contiguous from 1.
  for (let i = 0; i < T; i++) {
    if (types[i].index !== i + 1) {
      throw new Error(
        `sab-pack: types must be contiguous from 1; types[${i}].index = ${types[i].index}`
      );
    }
  }

  // Group words by typeIndex.
  const wordsByType = new Map();
  for (const w of words) {
    if (!wordsByType.has(w.typeIndex)) wordsByType.set(w.typeIndex, []);
    wordsByType.get(w.typeIndex).push(w);
  }

  // Build trees per type and flatten.
  const typeTrees = new Array(T); // typeTrees[i] = { nodes, root } for type index i+1
  let totalNodes = 0;
  let maxWordLength = 0;
  for (let i = 0; i < T; i++) {
    const t = types[i];
    const wordsOfType = wordsByType.get(t.index) || [];
    if (wordsOfType.length === 0) {
      typeTrees[i] = { nodes: [], root: null };
      continue;
    }
    if (wordsOfType.length !== t.wordCount) {
      throw new Error(
        `sab-pack: type ${t.index} declares wordCount=${t.wordCount} but has ${wordsOfType.length} words`
      );
    }
    const { root } = buildTreeForType(wordsOfType);
    const nodes = flattenTree(root);
    typeTrees[i] = { nodes, root };
    totalNodes += nodes.length;
    for (const w of wordsOfType) {
      if (w.word.length > maxWordLength) maxWordLength = w.word.length;
    }
  }

  // Build the string pool: every distinct word string, every distinct
  // type-name string. Use a Map<string, {offset, length}> to dedupe.
  // (Words are already unique across the dict by invariant; type names
  // are unique by construction. Dedupe is just safety.)
  const stringMap = new Map();
  const stringChunks = []; // Array<Uint8Array> to concatenate later
  let stringPoolLen = 0;
  function intern(s) {
    let entry = stringMap.get(s);
    if (entry) return entry;
    const bytes = ENCODER.encode(s);
    if (bytes.length > 0xFFFF) {
      throw new Error(`sab-pack: string "${s.slice(0, 40)}..." exceeds u16 length`);
    }
    // Cache the encoded bytes on the entry so the byWord / byTypeName
    // sorts can compare in UTF-8 byte order, matching the byte-level
    // binary search in `lookupWord` / `lookupTypeByName`. Sorting in
    // JS string order (UTF-16) and searching in UTF-8 disagrees on
    // any pair where one character is BMP ≥ U+E000 and the other is
    // supplementary-plane (emoji), since UTF-8 encodes BMP ≥ U+0800
    // as 3 bytes (lead 0xE0–0xEF) but supplementary as 4 bytes
    // (lead 0xF0–0xF7), reversing the relative order vs UTF-16.
    entry = { offset: stringPoolLen, length: bytes.length, bytes };
    stringMap.set(s, entry);
    // Stringpool layout: [u16 length][bytes...]
    const prefix = new Uint8Array(POOL_LEN_PREFIX_SIZE);
    prefix[0] = bytes.length & 0xFF;
    prefix[1] = (bytes.length >> 8) & 0xFF;
    stringChunks.push(prefix);
    stringChunks.push(bytes);
    stringPoolLen += POOL_LEN_PREFIX_SIZE + bytes.length;
    return entry;
  }
  // Intern type names first so they tend to live near the top.
  const typeNameEntries = new Array(T);
  for (let i = 0; i < T; i++) {
    typeNameEntries[i] = intern(types[i].name);
  }
  // Intern word strings; remember entry per word for byWord index AND
  // per-word-object for fast lookup during tree-node writing.
  const wordEntries = new Array(W);
  const wordRefToEntry = new Map();
  for (let i = 0; i < W; i++) {
    wordEntries[i] = intern(words[i].word);
    wordRefToEntry.set(words[i], wordEntries[i]);
  }

  // Compute section offsets.
  const typeTableOff = HEADER_SIZE;
  const treeNodesOff = typeTableOff + T * TYPE_ENTRY_SIZE;
  const byWordOff = treeNodesOff + totalNodes * NODE_SIZE;
  const byTypeNameOff = byWordOff + W * BYWORD_ENTRY_SIZE;
  const stringPoolOff = byTypeNameOff + T * BYTYPENAME_ENTRY_SIZE;
  const totalSize = stringPoolOff + stringPoolLen;

  // Allocate. SharedArrayBuffer in browsers requires COOP/COEP; in Node
  // it works without configuration. Fall back to ArrayBuffer if SAB
  // throws (older Node, browser without isolation), so the engine still
  // works for inline callers; cross-worker sharing requires SAB though.
  let sab;
  try {
    sab = new SharedArrayBuffer(totalSize);
  } catch {
    sab = new ArrayBuffer(totalSize);
  }
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);

  // Header.
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, T, true);
  view.setUint32(12, W, true);
  view.setUint32(16, maxWordLength, true);
  view.setUint32(20, typeTableOff, true);
  view.setUint32(24, byWordOff, true);
  view.setUint32(28, byTypeNameOff, true);
  view.setUint32(32, stringPoolOff, true);
  view.setUint32(36, stringPoolLen, true);

  // Tree-nodes section: write per type, tracking each type's
  // treeNodeOffset for the type table.
  const typeTreeOffsets = new Array(T);
  let nextNodeOff = treeNodesOff;
  for (let i = 0; i < T; i++) {
    const { nodes } = typeTrees[i];
    typeTreeOffsets[i] = nextNodeOff;
    for (const n of nodes) {
      const off = nextNodeOff + n._idx * NODE_SIZE;
      const leftIdx = n.left ? n.left._idx : NO_NODE;
      const rightIdx = n.right ? n.right._idx : NO_NODE;
      let wordOffset = NO_WORD;
      if (n._word) {
        wordOffset = wordRefToEntry.get(n._word).offset;
      }
      view.setUint32(off + 0, leftIdx, true);
      view.setUint32(off + 4, rightIdx, true);
      view.setUint32(off + 8, wordOffset, true);
    }
    nextNodeOff += nodes.length * NODE_SIZE;
  }

  // Type table.
  for (let i = 0; i < T; i++) {
    const t = types[i];
    const off = typeTableOff + i * TYPE_ENTRY_SIZE;
    const ne = typeNameEntries[i];
    view.setUint32(off + 0, ne.offset, true);
    view.setUint16(off + 4, ne.length, true);
    // bytes 6..7 reserved
    view.setUint32(off + 8, t.wordCount, true);
    view.setUint32(off + 12, typeTreeOffsets[i], true);
    view.setUint32(off + 16, typeTrees[i].nodes.length, true);
    view.setUint32(off + 20, t.index, true);
  }

  // byWord index: sort by UTF-8 byte order so the byte-wise binary
  // search in lookupWord agrees. JS string compare (UTF-16) diverges
  // from UTF-8 byte compare across the BMP/supplementary boundary.
  const byWordOrder = words.map((w, i) => ({ w, i, bytes: wordEntries[i].bytes }));
  byWordOrder.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let k = 0; k < W; k++) {
    const { w, i } = byWordOrder[k];
    const off = byWordOff + k * BYWORD_ENTRY_SIZE;
    const ent = wordEntries[i];
    view.setUint32(off + 0, ent.offset, true);
    view.setUint16(off + 4, ent.length, true);
    view.setUint16(off + 6, w.bits, true);
    view.setUint32(off + 8, w.typeIndex, true);
    view.setUint32(off + 12, w.code, true);
  }

  // byTypeName index: sort by UTF-8 byte order (same reason as byWord).
  const byNameOrder = types.map((t, i) => ({ t, i, bytes: typeNameEntries[i].bytes }));
  byNameOrder.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let k = 0; k < T; k++) {
    const { t, i } = byNameOrder[k];
    const off = byTypeNameOff + k * BYTYPENAME_ENTRY_SIZE;
    const ne = typeNameEntries[i];
    view.setUint32(off + 0, ne.offset, true);
    view.setUint16(off + 4, ne.length, true);
    view.setUint32(off + 8, t.index, true);
  }

  // String pool.
  let writePos = stringPoolOff;
  for (const chunk of stringChunks) {
    bytes.set(chunk, writePos);
    writePos += chunk.length;
  }

  return sab;
}

// unpackDictFromSAB(sab) -> dict JSON object.
//
// Inverse of packDictToSAB at the JSON-shape level. Walks the SAB and
// reconstructs { version: 2, types: [...], words: [...] } matching the
// shape build-corpus-dict / build-base-dict / gendict emit. Used by:
//   - `sab unpack dict` (CLI native re-emit)
//   - test helpers that still consume the JSON shape (e.g. the huffman
//     tie-break analysis tests that walk dict.types / dict.words
//     directly rather than going through lookupWord).
//
// Browser-safe ESM (no fs / Buffer / process). Accepts SharedArrayBuffer
// or ArrayBuffer with the same byte layout.
const DECODER = new TextDecoder();
function readPoolStr(bytes, poolOff, poolBase) {
  const off = poolBase + poolOff;
  const len = bytes[off] | (bytes[off + 1] << 8);
  return DECODER.decode(bytes.slice(off + POOL_LEN_PREFIX_SIZE, off + POOL_LEN_PREFIX_SIZE + len));
}

// packDictToSABAsync(json, opts), yielding variant for big dicts.
//
// Mirrors packDictToSAB except the three W-bound passes
// (word interning, byWord sort, byWord write) yield every
// yieldEvery items and emit onProgress events. The native
// Array.prototype.sort that orders byWord can't yield mid-call but
// it's flanked by progress events ('bywordsort-final' before,
// 'bywordsort-end' after) so the modal carries a meaningful label
// through the sync block.
//
// opts:
//   onProgress  (event) => void. Shapes:
//     { phase:'packdict-start',     totalWords }
//     { phase:'packdict-intern',    i, total }   word interning tick
//     { phase:'packdict-sort',      total }      just before byWord sort
//     { phase:'packdict-write',     i, total }   byWord write tick
//     { phase:'packdict-end',       totalWords }
//   yieldEvery  items per yield (default 50,000)
//   signal      optional AbortSignal
export async function packDictToSABAsync(json, opts = {}) {
  if (!json || json.version !== 2) {
    throw new Error(`sab-pack: unsupported dict version ${json && json.version}`);
  }
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const types = json.types;
  const words = json.words;
  const T = types.length;
  const W = words.length;

  if (onProgress) onProgress({ phase: 'packdict-start', totalWords: W });

  for (let i = 0; i < T; i++) {
    if (types[i].index !== i + 1) {
      throw new Error(
        `sab-pack: types must be contiguous from 1; types[${i}].index = ${types[i].index}`
      );
    }
  }

  const wordsByType = new Map();
  for (const w of words) {
    if (!wordsByType.has(w.typeIndex)) wordsByType.set(w.typeIndex, []);
    wordsByType.get(w.typeIndex).push(w);
  }

  const typeTrees = new Array(T);
  let totalNodes = 0;
  let maxWordLength = 0;
  for (let i = 0; i < T; i++) {
    const t = types[i];
    const wordsOfType = wordsByType.get(t.index) || [];
    if (wordsOfType.length === 0) {
      typeTrees[i] = { nodes: [], root: null };
      continue;
    }
    if (wordsOfType.length !== t.wordCount) {
      throw new Error(
        `sab-pack: type ${t.index} declares wordCount=${t.wordCount} but has ${wordsOfType.length} words`
      );
    }
    const { root } = buildTreeForType(wordsOfType);
    const nodes = flattenTree(root);
    typeTrees[i] = { nodes, root };
    totalNodes += nodes.length;
    for (const w of wordsOfType) {
      if (w.word.length > maxWordLength) maxWordLength = w.word.length;
    }
  }

  const stringMap = new Map();
  const stringChunks = [];
  let stringPoolLen = 0;
  function intern(s) {
    let entry = stringMap.get(s);
    if (entry) return entry;
    const bytes = ENCODER.encode(s);
    if (bytes.length > 0xFFFF) {
      throw new Error(`sab-pack: string "${s.slice(0, 40)}..." exceeds u16 length`);
    }
    entry = { offset: stringPoolLen, length: bytes.length, bytes };
    stringMap.set(s, entry);
    const prefix = new Uint8Array(POOL_LEN_PREFIX_SIZE);
    prefix[0] = bytes.length & 0xFF;
    prefix[1] = (bytes.length >> 8) & 0xFF;
    stringChunks.push(prefix);
    stringChunks.push(bytes);
    stringPoolLen += POOL_LEN_PREFIX_SIZE + bytes.length;
    return entry;
  }
  const typeNameEntries = new Array(T);
  for (let i = 0; i < T; i++) typeNameEntries[i] = intern(types[i].name);

  const wordEntries = new Array(W);
  const wordRefToEntry = new Map();
  for (let i = 0; i < W; i++) {
    wordEntries[i] = intern(words[i].word);
    wordRefToEntry.set(words[i], wordEntries[i]);
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 'packdict-intern', i: i + 1, total: W });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const typeTableOff = HEADER_SIZE;
  const treeNodesOff = typeTableOff + T * TYPE_ENTRY_SIZE;
  const byWordOff = treeNodesOff + totalNodes * NODE_SIZE;
  const byTypeNameOff = byWordOff + W * BYWORD_ENTRY_SIZE;
  const stringPoolOff = byTypeNameOff + T * BYTYPENAME_ENTRY_SIZE;
  const totalSize = stringPoolOff + stringPoolLen;

  let sab;
  try {
    sab = new SharedArrayBuffer(totalSize);
  } catch {
    sab = new ArrayBuffer(totalSize);
  }
  const view = new DataView(sab);
  const sabBytes = new Uint8Array(sab);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, T, true);
  view.setUint32(12, W, true);
  view.setUint32(16, maxWordLength, true);
  view.setUint32(20, typeTableOff, true);
  view.setUint32(24, byWordOff, true);
  view.setUint32(28, byTypeNameOff, true);
  view.setUint32(32, stringPoolOff, true);
  view.setUint32(36, stringPoolLen, true);

  const typeTreeOffsets = new Array(T);
  let nextNodeOff = treeNodesOff;
  for (let i = 0; i < T; i++) {
    const { nodes } = typeTrees[i];
    typeTreeOffsets[i] = nextNodeOff;
    for (const n of nodes) {
      const off = nextNodeOff + n._idx * NODE_SIZE;
      const leftIdx = n.left ? n.left._idx : NO_NODE;
      const rightIdx = n.right ? n.right._idx : NO_NODE;
      let wordOffset = NO_WORD;
      if (n._word) wordOffset = wordRefToEntry.get(n._word).offset;
      view.setUint32(off + 0, leftIdx, true);
      view.setUint32(off + 4, rightIdx, true);
      view.setUint32(off + 8, wordOffset, true);
    }
    nextNodeOff += nodes.length * NODE_SIZE;
  }

  for (let i = 0; i < T; i++) {
    const t = types[i];
    const off = typeTableOff + i * TYPE_ENTRY_SIZE;
    const ne = typeNameEntries[i];
    view.setUint32(off + 0, ne.offset, true);
    view.setUint16(off + 4, ne.length, true);
    view.setUint32(off + 8, t.wordCount, true);
    view.setUint32(off + 12, typeTreeOffsets[i], true);
    view.setUint32(off + 16, typeTrees[i].nodes.length, true);
    view.setUint32(off + 20, t.index, true);
  }

  // byWord sort + write. Uses the yielding mergesort so the modal
  // stays responsive on big dicts (Shakespeare's complete works
  // packs ~50K words; the sort had previously been a 2-4 s silent
  // window). The inner mergesort's 'mergesort-pass' / 'mergesort-end'
  // events are forwarded to onProgress with a `subphase` field so
  // the worker's router can distinguish the byword and byname passes.
  if (onProgress) onProgress({ phase: 'packdict-sort', total: W });
  const byWordOrder = await mergesortAsync(
    words.map((w, i) => ({ w, i, bytes: wordEntries[i].bytes })),
    (a, b) => compareBytes(a.bytes, b.bytes),
    {
      yieldEvery,
      signal,
      onProgress: onProgress
        ? (e) => onProgress({ ...e, subphase: 'byword' })
        : null,
    },
  );
  for (let k = 0; k < W; k++) {
    const { w, i } = byWordOrder[k];
    const off = byWordOff + k * BYWORD_ENTRY_SIZE;
    const ent = wordEntries[i];
    view.setUint32(off + 0, ent.offset, true);
    view.setUint16(off + 4, ent.length, true);
    view.setUint16(off + 6, w.bits, true);
    view.setUint32(off + 8, w.typeIndex, true);
    view.setUint32(off + 12, w.code, true);
    if (((k + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 'packdict-write', i: k + 1, total: W });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // byTypeName: small (one entry per type) but still yielded for
  // consistency + signal honoring.
  const byNameOrder = await mergesortAsync(
    types.map((t, i) => ({ t, i, bytes: typeNameEntries[i].bytes })),
    (a, b) => compareBytes(a.bytes, b.bytes),
    {
      yieldEvery,
      signal,
      onProgress: onProgress
        ? (e) => onProgress({ ...e, subphase: 'byname' })
        : null,
    },
  );
  for (let k = 0; k < T; k++) {
    const { t, i } = byNameOrder[k];
    const off = byTypeNameOff + k * BYTYPENAME_ENTRY_SIZE;
    const ne = typeNameEntries[i];
    view.setUint32(off + 0, ne.offset, true);
    view.setUint16(off + 4, ne.length, true);
    view.setUint32(off + 8, t.index, true);
  }

  let writePos = stringPoolOff;
  for (const chunk of stringChunks) {
    sabBytes.set(chunk, writePos);
    writePos += chunk.length;
  }

  if (onProgress) onProgress({ phase: 'packdict-end', totalWords: W });
  return sab;
}

function makeAbort() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function unpackDictFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`sab-pack.unpack: bad SAB magic 0x${magic.toString(16)} (expected NTDC)`);
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`sab-pack.unpack: unsupported SAB version ${version}`);
  }
  const typeCount        = view.getUint32(8, true);
  const wordCount        = view.getUint32(12, true);
  const typeTableOffset  = view.getUint32(20, true);
  const byWordOffset     = view.getUint32(24, true);
  const stringPoolOffset = view.getUint32(32, true);

  const types = new Array(typeCount);
  for (let i = 0; i < typeCount; i++) {
    const off = typeTableOffset + i * TYPE_ENTRY_SIZE;
    const nameOffset = view.getUint32(off + 0, true);
    const wcount     = view.getUint32(off + 8, true);
    const index      = view.getUint32(off + 20, true);
    types[i] = {
      index,
      name: readPoolStr(bytes, nameOffset, stringPoolOffset),
      wordCount: wcount,
    };
  }
  // Sort by index ascending to match builder emit order.
  types.sort((a, b) => a.index - b.index);

  const words = new Array(wordCount);
  for (let i = 0; i < wordCount; i++) {
    const off = byWordOffset + i * BYWORD_ENTRY_SIZE;
    const stringOffset = view.getUint32(off + 0, true);
    const bits         = view.getUint16(off + 6, true);
    const typeIndex    = view.getUint32(off + 8, true);
    const code         = view.getUint32(off + 12, true);
    words[i] = {
      word: readPoolStr(bytes, stringOffset, stringPoolOffset),
      typeIndex,
      code,
      bits,
    };
  }

  return { version: 2, types, words };
}
