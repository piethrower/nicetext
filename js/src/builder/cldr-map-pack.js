// SAB binary packer for the emoji→keywords CLDR map fixture. Same
// shape rationale as the other packers: workers share one SAB ref,
// zero parse at load, byte-offset reads. The format is `NTCM`
// (NiceText Cldr Map) v1.
//
// Browser-safe ESM. No Node deps.

const MAGIC = 0x4D43544E; // "NTCM" little-endian
const VERSION = 1;

// Header layout (32 bytes):
//   0  magic               u32 ("NTCM" LE)
//   4  version             u32
//   8  emojiCount          u32 (E)
//  12  totalKeywords       u32 (K = sum of keyword-array lengths)
//  16  emojiOffsetsOff     u32 (start of emoji-offset table: E+1 u32s)
//  20  arrayOffsetsOff     u32 (start of per-emoji array-bounds
//                               table: E+1 u32s. arrayOffsets[i]
//                               and arrayOffsets[i+1] bracket emoji
//                               i's keyword indices in the keyword
//                               offsets table.)
//  24  keywordOffsetsOff   u32 (start of keyword-offset table:
//                               K+1 u32s bracketing each keyword's
//                               bytes in the string pool.)
//  28  stringPoolOff       u32 (start of UTF-8 string pool)
//
// Pool layout: emoji byte sequences first (in emoji-table order),
// then keyword byte sequences (flat, all emojis' arrays
// concatenated). Each entry's bytes are bracketed by its
// corresponding offset-table entry and the next one (sentinel at
// the end of each offset table).
//
// Emojis are sorted by UTF-8 bytes at pack time so a future binary-
// search lookup over the SAB is trivial. The current runtime
// consumer (cldr[emoji] dictionary access) is order-insensitive;
// the unpack returns a plain object preserving emoji-table order
// (insertion order in JS object iteration).

const HEADER_SIZE = 32;
const U32 = 4;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// packCldrMapToSAB({emoji: [keyword, ...], ...}) -> SAB.
//
// Input matches the JSON shape Eve / aug-impls-sab read today:
// a plain object mapping each emoji string to an array of keyword
// strings.
export function packCldrMapToSAB(map) {
  if (!map || typeof map !== 'object') {
    throw new Error('cldr-map-pack: input must be {emoji: [keyword, ...]}');
  }

  // Collect emoji keys and sort by UTF-8 bytes.
  const emojiKeys = Object.keys(map).filter((k) => Array.isArray(map[k]));
  const emojiByteRows = emojiKeys.map((e) => ({ key: e, bytes: ENCODER.encode(e) }));
  emojiByteRows.sort((a, b) => compareBytes(a.bytes, b.bytes));

  // Flatten keywords + remember per-emoji array bounds.
  const arrayBounds = new Array(emojiByteRows.length + 1);
  const keywordBytes = [];
  arrayBounds[0] = 0;
  for (let i = 0; i < emojiByteRows.length; i++) {
    const arr = map[emojiByteRows[i].key];
    for (const kw of arr) {
      if (typeof kw !== 'string') {
        throw new Error(`cldr-map-pack: keyword for emoji ${JSON.stringify(emojiByteRows[i].key)} is not a string`);
      }
      keywordBytes.push(ENCODER.encode(kw));
    }
    arrayBounds[i + 1] = keywordBytes.length;
  }

  const E = emojiByteRows.length;
  const K = keywordBytes.length;

  // Section offsets.
  const emojiOffsetsOff   = HEADER_SIZE;
  const arrayOffsetsOff   = emojiOffsetsOff + (E + 1) * U32;
  const keywordOffsetsOff = arrayOffsetsOff + (E + 1) * U32;
  const stringPoolOff     = keywordOffsetsOff + (K + 1) * U32;

  // String pool size: emoji bytes + keyword bytes.
  let poolLen = 0;
  for (const r of emojiByteRows) poolLen += r.bytes.length;
  for (const kb of keywordBytes) poolLen += kb.length;
  const totalSize = stringPoolOff + poolLen;

  let sab;
  try { sab = new SharedArrayBuffer(totalSize); }
  catch { sab = new ArrayBuffer(totalSize); }
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);

  // Header.
  view.setUint32(0,  MAGIC,             true);
  view.setUint32(4,  VERSION,           true);
  view.setUint32(8,  E,                 true);
  view.setUint32(12, K,                 true);
  view.setUint32(16, emojiOffsetsOff,   true);
  view.setUint32(20, arrayOffsetsOff,   true);
  view.setUint32(24, keywordOffsetsOff, true);
  view.setUint32(28, stringPoolOff,     true);

  // Emoji table + emoji-byte writes.
  let pos = stringPoolOff;
  for (let i = 0; i < E; i++) {
    view.setUint32(emojiOffsetsOff + i * U32, pos, true);
    bytes.set(emojiByteRows[i].bytes, pos);
    pos += emojiByteRows[i].bytes.length;
  }
  view.setUint32(emojiOffsetsOff + E * U32, pos, true);

  // Keyword offsets + keyword-byte writes. Note: pos continues from
  // the emoji-bytes end, both emoji and keyword strings share one
  // contiguous pool.
  for (let k = 0; k < K; k++) {
    view.setUint32(keywordOffsetsOff + k * U32, pos, true);
    bytes.set(keywordBytes[k], pos);
    pos += keywordBytes[k].length;
  }
  view.setUint32(keywordOffsetsOff + K * U32, pos, true);

  // Array-bounds table: bracket each emoji's keyword indices.
  for (let i = 0; i <= E; i++) {
    view.setUint32(arrayOffsetsOff + i * U32, arrayBounds[i], true);
  }

  return sab;
}

// unpackCldrMapFromSAB(sab) -> {emoji: [keyword, ...], ...}.
//
// Inverse of packCldrMapToSAB. Returns a plain object so existing
// consumers (cldr[emoji] dictionary access in aug-impls-sab.js,
// Eve diagnostics) drop in without modification.
export function unpackCldrMapFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`cldr-map-pack.unpack: bad SAB magic 0x${magic.toString(16)} (expected NTCM)`);
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`cldr-map-pack.unpack: unsupported SAB version ${version}`);
  }
  const E = view.getUint32(8, true);
  const emojiOffsetsOff   = view.getUint32(16, true);
  const arrayOffsetsOff   = view.getUint32(20, true);
  const keywordOffsetsOff = view.getUint32(24, true);

  const out = Object.create(null);
  for (let i = 0; i < E; i++) {
    const eStart = view.getUint32(emojiOffsetsOff + i * U32, true);
    const eEnd   = view.getUint32(emojiOffsetsOff + (i + 1) * U32, true);
    const emoji  = DECODER.decode(bytes.slice(eStart, eEnd));
    const kStart = view.getUint32(arrayOffsetsOff + i * U32, true);
    const kEnd   = view.getUint32(arrayOffsetsOff + (i + 1) * U32, true);
    const arr = new Array(kEnd - kStart);
    for (let k = kStart; k < kEnd; k++) {
      const wStart = view.getUint32(keywordOffsetsOff + k * U32, true);
      const wEnd   = view.getUint32(keywordOffsetsOff + (k + 1) * U32, true);
      arr[k - kStart] = DECODER.decode(bytes.slice(wStart, wEnd));
    }
    out[emoji] = arr;
  }
  return out;
}

function compareBytes(a, b) {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const CLDR_MAP_SAB_CONSTANTS = { MAGIC, VERSION, HEADER_SIZE };
