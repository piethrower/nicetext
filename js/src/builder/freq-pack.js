// SAB binary packer for word-frequency fixtures. Same shape rationale
// as the dict / model packers: workers share one SAB ref, no per-realm
// parse, the runtime reads via byte-offset arithmetic. The format
// here is `NTFQ` (NiceText FreQuency) v1.
//
// Browser-safe ESM. No Node deps.

const MAGIC = 0x5146544E; // "NTFQ" little-endian
const VERSION = 1;

// Header layout (32 bytes):
//   0  magic           u32 ("NTFQ" LE)
//   4  version         u32
//   8  wordCount       u32  (N)
//  12  totalTokensLo   u32  (low 32 bits of total token sum)
//  16  totalTokensHi   u32  (high 32 bits of total token sum)
//  20  offsetsOff      u32  (start of word-offset table, N+1 u32s)
//  24  countsOff       u32  (start of counts table, N pairs of u32)
//  28  stringPoolOff   u32  (start of string pool)
//
// Word-offset table (4 * (N+1) bytes):
//   N + 1 absolute u32 byte offsets into the string pool. Word i's
//   string bytes occupy pool[offsets[i] .. offsets[i+1]). The trailing
//   sentinel at i = N marks the pool's end, so every word's length
//   computes without a special case.
//
// Counts table (8 * N bytes):
//   N counts, each stored as a pair of u32 (lo, hi) for the u64 value.
//   The pair encoding avoids 8-byte alignment requirements and works
//   identically across runtime endianness assumptions (DataView LE).
//   Norvig's largest count is ~9e9 (well above 2^32) so u64 is the
//   load-bearing size choice here.
//
// String pool: concatenated UTF-8 bytes of every word, in word order
// (alphabetical by UTF-8 bytes, set at pack time). No length prefix
// is needed; the offsets table brackets each word.
//
// Words are sorted at pack time so a future hasSorted(word) binary-
// search lookup against the SAB is trivial. The current consumer
// (combineFrequencies) is order-insensitive, it iterates the
// returned Map, so sort order does not affect downstream weights.
const HEADER_SIZE = 32;
const OFFSET_ENTRY_SIZE = 4;
const COUNT_ENTRY_SIZE = 8; // u64 stored as two u32

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// packFreqToSAB({totalTokens, counts: Map<word, count>}) -> SAB.
//
// Input matches js/src/builder/frequencies.js / parseFreqLines's
// return shape. totalTokens is a finite number ≤ 2^53; counts are
// per-word non-negative numbers, individually up to ~9e9 in shipped
// fixtures and theoretically up to 2^64.
export function packFreqToSAB(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('freq-pack: parsed input must be {totalTokens, counts}');
  }
  const totalTokens = Number(parsed.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    throw new Error(`freq-pack: totalTokens must be a finite non-negative number; got ${parsed.totalTokens}`);
  }
  const counts = parsed.counts;
  if (!counts || typeof counts.entries !== 'function') {
    throw new Error('freq-pack: counts must be a Map-like with .entries()');
  }

  // Snapshot + sort by UTF-8 bytes. Sort lets a future
  // wrapFreqSAB.hasSorted(word) do a binary search; combineFrequencies
  // is order-insensitive so the existing pipeline is unaffected.
  const rows = [];
  for (const [w, c] of counts) {
    if (typeof w !== 'string') {
      throw new Error(`freq-pack: word keys must be strings; got ${typeof w}`);
    }
    const n = Number(c);
    if (!Number.isFinite(n) || n < 0) continue;
    rows.push({ word: w, count: n, bytes: ENCODER.encode(w) });
  }
  rows.sort((a, b) => compareBytes(a.bytes, b.bytes));

  const N = rows.length;

  // Section offsets.
  const offsetsOff = HEADER_SIZE;
  const countsOff = offsetsOff + (N + 1) * OFFSET_ENTRY_SIZE;
  const stringPoolOff = countsOff + N * COUNT_ENTRY_SIZE;
  let poolLen = 0;
  for (const r of rows) poolLen += r.bytes.length;
  const totalSize = stringPoolOff + poolLen;

  let sab;
  try { sab = new SharedArrayBuffer(totalSize); }
  catch { sab = new ArrayBuffer(totalSize); }
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);

  // Header.
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, N, true);
  // Split totalTokens into lo/hi u32 halves. totalTokens up to
  // ~2^53 fits Number safely; the split here matches the per-count
  // encoding below for consistency.
  const ttLo = totalTokens >>> 0;
  const ttHi = Math.floor(totalTokens / 0x100000000) >>> 0;
  view.setUint32(12, ttLo, true);
  view.setUint32(16, ttHi, true);
  view.setUint32(20, offsetsOff, true);
  view.setUint32(24, countsOff, true);
  view.setUint32(28, stringPoolOff, true);

  // Word offsets + string pool.
  let pos = stringPoolOff;
  for (let i = 0; i < N; i++) {
    view.setUint32(offsetsOff + i * OFFSET_ENTRY_SIZE, pos, true);
    bytes.set(rows[i].bytes, pos);
    pos += rows[i].bytes.length;
  }
  view.setUint32(offsetsOff + N * OFFSET_ENTRY_SIZE, pos, true); // sentinel

  // Counts table.
  for (let i = 0; i < N; i++) {
    const c = rows[i].count;
    const lo = (c >>> 0);
    const hi = Math.floor(c / 0x100000000) >>> 0;
    const off = countsOff + i * COUNT_ENTRY_SIZE;
    view.setUint32(off + 0, lo, true);
    view.setUint32(off + 4, hi, true);
  }

  return sab;
}

// unpackFreqFromSAB(sab) -> {totalTokens, counts: Map<word, count>}.
//
// Inverse of packFreqToSAB at the parseFreqLines-return-shape level.
// Used by sab.unpack('freq', sab) and by any runtime that wants the
// same Map<word, count> contract parseFreqLines provided.
export function unpackFreqFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`freq-pack.unpack: bad SAB magic 0x${magic.toString(16)} (expected NTFQ)`);
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`freq-pack.unpack: unsupported SAB version ${version}`);
  }
  const wordCount = view.getUint32(8, true);
  const ttLo = view.getUint32(12, true);
  const ttHi = view.getUint32(16, true);
  const totalTokens = ttHi * 0x100000000 + ttLo;
  const offsetsOff = view.getUint32(20, true);
  const countsOff = view.getUint32(24, true);

  const counts = new Map();
  for (let i = 0; i < wordCount; i++) {
    const start = view.getUint32(offsetsOff + i * OFFSET_ENTRY_SIZE, true);
    const end   = view.getUint32(offsetsOff + (i + 1) * OFFSET_ENTRY_SIZE, true);
    // slice → fresh ArrayBuffer (TextDecoder rejects SAB-backed views).
    const word = DECODER.decode(bytes.slice(start, end));
    const lo = view.getUint32(countsOff + i * COUNT_ENTRY_SIZE + 0, true);
    const hi = view.getUint32(countsOff + i * COUNT_ENTRY_SIZE + 4, true);
    const count = hi * 0x100000000 + lo;
    counts.set(word, count);
  }

  return { totalTokens, counts };
}

// Lexicographic compare of two Uint8Array byte sequences.
function compareBytes(a, b) {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const FREQ_SAB_CONSTANTS = {
  MAGIC, VERSION, HEADER_SIZE, OFFSET_ENTRY_SIZE, COUNT_ENTRY_SIZE,
};
