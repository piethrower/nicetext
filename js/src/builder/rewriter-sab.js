// rewriter-sab.js -- packer / unpacker for the per-rewriter apply-time
// lookup fixture (NTRW format, "NiceText ReWriter").
//
// Universal on-disk shape for every cover-transforms rewriter's
// private lookup data: Map<string, Set<string>>. See
// docs/cover-transforms.md and the per-rewriter modules under
// js/src/rewriter/<name>.js for how each rewriter interprets the
// keys and value-sets.
//
// Examples of how the same shape carries different semantics:
//
//   xanax      key = next-word (e.g., "united"),
//              value = set with the correct article (e.g., {"a"}).
//   typos      key = canonical word (e.g., "the"),
//              value = set of variant typos (e.g., {"teh","thier",...}).
//   british    key = US spelling (e.g., "color"),
//              value = set with the UK spelling (e.g., {"colour"}).
//   voice      key = canonical word (e.g., "hello"),
//              value = set of voice-flavored variants (e.g., {"ahoy"}).
//
// Layout: header + key-offset table + set-bounds table + value-offset
// table + string pool. Same family of layouts as cldr-map-pack.js;
// magic NTRW, version 1.
//
// Browser-safe ESM. No Node deps.

const MAGIC   = 0x5752544E; // "NTRW" little-endian
const VERSION = 1;

// Header layout (32 bytes):
//   0  magic            u32 ("NTRW" LE)
//   4  version          u32
//   8  keyCount         u32 (K = number of map keys)
//  12  totalValues      u32 (V = sum of set sizes across all keys)
//  16  keyOffsetsOff    u32 (start of key-string offset table: K+1 u32s)
//  20  setBoundsOff     u32 (start of per-key set-bounds table: K+1
//                            u32s. setBounds[i] and setBounds[i+1]
//                            bracket key i's value indices in the
//                            value-offset table.)
//  24  valueOffsetsOff  u32 (start of value-string offset table:
//                            V+1 u32s bracketing each value's bytes
//                            in the string pool.)
//  28  stringPoolOff    u32 (start of UTF-8 string pool)
//
// Pool layout: key bytes first (in sorted-by-UTF-8 order), then value
// bytes (concatenated per key, in sorted-by-UTF-8 order within each
// set). Sentinels at the ends of both offset tables bracket the last
// entry's bytes.
//
// Keys are sorted by UTF-8 bytes at pack time so a future binary-
// search lookup over the SAB is trivial. The current materializer
// (unpackRewriterMap) emits a fully-materialized Map<string,
// Set<string>>, suitable for direct random access from each
// rewriter's apply().

const HEADER_SIZE = 32;
const U32         = 4;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// packRewriterMap(input) -> SharedArrayBuffer
//
// `input` may be a Map<string, Set<string>>, Map<string, Array<string>>,
// or a plain object {key: [value, ...]}. The packer normalizes all
// three shapes into a stable sorted SAB. Empty value-sets are allowed
// and travel through unchanged; the unpacker emits Set() for them.
export function packRewriterMap(input) {
  // Normalize to an array of {keyBytes, valueByteRows[]}, sorted by
  // key bytes. Within each entry, value bytes are sorted by their
  // UTF-8 bytes too, deterministic output regardless of input
  // iteration order.
  const rows = normalizeAndSort(input);

  const K = rows.length;
  let V = 0;
  for (const r of rows) V += r.values.length;

  // Section offsets.
  const keyOffsetsOff   = HEADER_SIZE;
  const setBoundsOff    = keyOffsetsOff   + (K + 1) * U32;
  const valueOffsetsOff = setBoundsOff    + (K + 1) * U32;
  const stringPoolOff   = valueOffsetsOff + (V + 1) * U32;

  // String pool length: every key plus every value.
  let poolLen = 0;
  for (const r of rows) {
    poolLen += r.key.length;
    for (const vb of r.values) poolLen += vb.length;
  }
  const totalSize = stringPoolOff + poolLen;

  let sab;
  try { sab = new SharedArrayBuffer(totalSize); }
  catch { sab = new ArrayBuffer(totalSize); }
  const view  = new DataView(sab);
  const bytes = new Uint8Array(sab);

  // Header.
  view.setUint32(0,  MAGIC,           true);
  view.setUint32(4,  VERSION,         true);
  view.setUint32(8,  K,               true);
  view.setUint32(12, V,               true);
  view.setUint32(16, keyOffsetsOff,   true);
  view.setUint32(20, setBoundsOff,    true);
  view.setUint32(24, valueOffsetsOff, true);
  view.setUint32(28, stringPoolOff,   true);

  // Walk the string pool once, writing keys then values, recording
  // offsets into the corresponding tables in lockstep.
  let pos     = stringPoolOff;
  let vIndex  = 0;

  // Key offset table + key-byte writes.
  for (let i = 0; i < K; i++) {
    view.setUint32(keyOffsetsOff + i * U32, pos, true);
    bytes.set(rows[i].key, pos);
    pos += rows[i].key.length;
  }
  view.setUint32(keyOffsetsOff + K * U32, pos, true);

  // Set-bounds + value offset table + value-byte writes. setBounds is
  // filled in step, then value offsets stream through the same pool
  // continuation pos.
  for (let i = 0; i < K; i++) {
    view.setUint32(setBoundsOff + i * U32, vIndex, true);
    for (const vb of rows[i].values) {
      view.setUint32(valueOffsetsOff + vIndex * U32, pos, true);
      bytes.set(vb, pos);
      pos += vb.length;
      vIndex++;
    }
  }
  view.setUint32(setBoundsOff    + K * U32, V,   true);
  view.setUint32(valueOffsetsOff + V * U32, pos, true);

  return sab;
}

// unpackRewriterMap(sab) -> Map<string, Set<string>>
//
// Materialize the whole NTRW SAB into a JS Map of Sets. Suitable for
// hot-path use because the rewriter's apply() can then do native O(1)
// Map.get + Set.has lookups. The materialization cost is paid once at
// rewriter init; per-emission overhead is the bare lookup.
export function unpackRewriterMap(sab) {
  const view  = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `rewriter-sab.unpack: bad SAB magic 0x${magic.toString(16)} (expected NTRW)`);
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`rewriter-sab.unpack: unsupported SAB version ${version}`);
  }
  const K              = view.getUint32(8,  true);
  const keyOffsetsOff  = view.getUint32(16, true);
  const setBoundsOff   = view.getUint32(20, true);
  const valueOffsOff   = view.getUint32(24, true);

  const out = new Map();
  for (let i = 0; i < K; i++) {
    const keyStart = view.getUint32(keyOffsetsOff + i * U32,       true);
    const keyEnd   = view.getUint32(keyOffsetsOff + (i + 1) * U32, true);
    const key      = DECODER.decode(bytes.slice(keyStart, keyEnd));

    const setStart = view.getUint32(setBoundsOff + i * U32,       true);
    const setEnd   = view.getUint32(setBoundsOff + (i + 1) * U32, true);
    const set      = new Set();
    for (let j = setStart; j < setEnd; j++) {
      const vStart = view.getUint32(valueOffsOff + j * U32,       true);
      const vEnd   = view.getUint32(valueOffsOff + (j + 1) * U32, true);
      set.add(DECODER.decode(bytes.slice(vStart, vEnd)));
    }
    out.set(key, set);
  }
  return out;
}

// Normalize Map<string, Set<string>> / Map<string, Array<string>> /
// {key: [value, ...]} into an array of {key: Uint8Array, values:
// Uint8Array[]}, with keys sorted by UTF-8 bytes and values sorted
// the same way within each set.
function normalizeAndSort(input) {
  let pairs;
  if (input instanceof Map) {
    pairs = [...input.entries()];
  } else if (input && typeof input === 'object') {
    pairs = Object.entries(input);
  } else {
    throw new Error('rewriter-sab.pack: input must be Map or plain object');
  }
  const rows = [];
  for (const [k, v] of pairs) {
    if (typeof k !== 'string') {
      throw new Error(`rewriter-sab.pack: key must be string, got ${typeof k}`);
    }
    const valueArr = v instanceof Set ? [...v] : (Array.isArray(v) ? v.slice() : null);
    if (!valueArr) {
      throw new Error(
        `rewriter-sab.pack: value for key ${JSON.stringify(k)} must be Set or Array`);
    }
    for (const item of valueArr) {
      if (typeof item !== 'string') {
        throw new Error(
          `rewriter-sab.pack: value for key ${JSON.stringify(k)} contains non-string ${typeof item}`);
      }
    }
    const valueBytes = valueArr.map((s) => ENCODER.encode(s));
    valueBytes.sort(compareBytes);
    rows.push({ key: ENCODER.encode(k), values: valueBytes });
  }
  rows.sort((a, b) => compareBytes(a.key, b.key));
  return rows;
}

function compareBytes(a, b) {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const REWRITER_SAB_CONSTANTS = { MAGIC, VERSION, HEADER_SIZE };
