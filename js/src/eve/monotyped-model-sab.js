// monotyped-model-sab.js: single-SAB container for one corpus's
// monotyped model (MM) plus its derived collapsed monotyped model
// (CMM) pool. Three structures from one file:
//   - MM unique pool:    deduped + lexicographically-sorted MM strings,
//                        binary-searchable via .hasSorted(s).
//   - MM ordered index:  N u32 entries (N = corpus sentence count);
//                        each entry is an index 0..M-1 into the MM
//                        unique pool. Provides positional access via
//                        .at(i) without duplicating bytes for repeated
//                        sentences.
//   - CMM unique pool:   for each MM, collapse every run of consecutive
//                        'g' parts to a single 'g'. Dedupe + sort the
//                        result, store as a second utf-8 pool with its
//                        own offsets array and its own binary-search
//                        method .cmmHasSorted(s). Plus a 4*M u32 array
//                        mapping each unique-MM index j → CMM-pool
//                        index. Many-to-one by design (multiple MMs
//                        can map to the same CMM); no reverse fanout.
//
// Cross-sab matching: pack-once-per-corpus + pack-once-per-suspected,
// then comparison is two binary searches per suspected sentence,
// .hasSorted (exact MM membership) and .cmmHasSorted (CMM membership,
// the phrase-augment-tolerant equivalence).
//
// Layout (all little-endian):
//   header (40 bytes)
//     u32 magic            "NTMM"  (NiceText MonoTyped Model)
//     u32 version          2
//     u32 uniqueCount      M    (unique MM count)
//     u32 orderedCount     N    (ordered MM count)
//     u32 cmmUniqueCount   P    (unique CMM count, P ≤ M)
//     u32 poolOffset       byte offset of the MM utf-8 pool
//     u32 indexOffset      byte offset of the MM ordered-index u32 array
//     u32 cmmOffsetsOffset byte offset of the CMM offsets array
//     u32 cmmPoolOffset    byte offset of the CMM utf-8 pool
//     u32 cmmIndexOffset   byte offset of the per-unique-MM CMM index
//
//   MM unique offsets  (4 * (M + 1) bytes)
//     u32 per unique MM; offsets[i+1] - offsets[i] is the byte length
//     of unique[i]. The +1 sentinel holds one-past-end pool position.
//   MM pool            utf-8 bytes of the M unique sorted MM strings.
//   MM ordered index   (4 * N bytes) u32 per corpus position; index
//                      into MM unique pool.
//   CMM offsets        (4 * (P + 1) bytes) u32 per unique CMM + sentinel.
//   CMM pool           utf-8 bytes of the P unique sorted CMM strings.
//   CMM index          (4 * M bytes) u32 per unique-MM index; value
//                      is the index into the CMM pool for that MM's
//                      collapsed monotyped model.
//
// Browser-safe and node-safe ESM, zero deps.

const MAGIC = 0x4D4D544E; // "NTMM" little-endian
const VERSION = 2;

const HDR_MAGIC = 0;
const HDR_VERSION = 4;
const HDR_UNIQUE_COUNT = 8;
const HDR_ORDERED_COUNT = 12;
const HDR_CMM_UNIQUE_COUNT = 16;
const HDR_POOL_OFFSET = 20;
const HDR_INDEX_OFFSET = 24;
const HDR_CMM_OFFSETS_OFFSET = 28;
const HDR_CMM_POOL_OFFSET = 32;
const HDR_CMM_INDEX_OFFSET = 36;
const HEADER_SIZE = 40;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// MONO_TYPE: the single placeholder every word token monotypes to.
// Exported because the check module + builders both need the literal.
export const MONO_TYPE = 'g';

// collapsedMonotypedModel(mm) -> string
//
// Replace every run of consecutive 'g' parts with a single 'g'. The
// canonical representative of the phrase-augment equivalence class:
// two MM strings produced by the same skeleton with any (≥1) g-run
// lengths collapse to the same CMM. Match-by-CMM is the phrase-
// augment-tolerant predicate; no per-sentence variant enumeration
// required.
//
// Input is a pipe-joined MM string (the same form produced by
// genMonotypedModel and stored in the MM pool). Output is its CMM.
export function collapsedMonotypedModel(mm) {
  const parts = mm.split('|');
  const out = [];
  let prev = null;
  for (const p of parts) {
    if (p === MONO_TYPE && prev === MONO_TYPE) continue;
    out.push(p);
    prev = p;
  }
  return out.join('|');
}

// packMonotypedModel(orderedSentences, opts?) -> ArrayBuffer | SharedArrayBuffer
//
// orderedSentences  Array<string>. MM strings in corpus order;
//                   duplicates expected. The function dedupes + sorts
//                   internally to build the MM unique pool, the per-
//                   position ordered index, the CMM unique pool, and
//                   the per-unique-MM CMM index.
// opts.shared       true -> SharedArrayBuffer (runtime, cross-worker).
//                   Default false -> ArrayBuffer (build-time, gz to disk).
export function packMonotypedModel(orderedSentences, opts = {}) {
  if (!Array.isArray(orderedSentences)) {
    throw new TypeError('packMonotypedModel: orderedSentences must be an array');
  }
  const N = orderedSentences.length;

  // Dedupe + sort MMs. utf-16 code-unit comparison agrees with utf-8
  // byte order for ASCII and the BMP characters MMs contain ('g',
  // punct, EOS literals, case markers, '|' separator).
  const uniqueMm = [...new Set(orderedSentences)].sort();
  const M = uniqueMm.length;

  // Compute CMM for each unique MM. Many MMs may map to the same CMM.
  const cmmForUnique = new Array(M);
  const cmmSet = new Set();
  for (let j = 0; j < M; j++) {
    const c = collapsedMonotypedModel(uniqueMm[j]);
    cmmForUnique[j] = c;
    cmmSet.add(c);
  }
  const uniqueCmm = [...cmmSet].sort();
  const P = uniqueCmm.length;

  // Map MM string → MM-pool index; CMM string → CMM-pool index.
  const mmIndexOf = new Map();
  for (let j = 0; j < M; j++) mmIndexOf.set(uniqueMm[j], j);
  const cmmIndexOf = new Map();
  for (let p = 0; p < P; p++) cmmIndexOf.set(uniqueCmm[p], p);

  // Encode pools, accumulate byte sizes.
  const mmEncoded = new Array(M);
  let mmPoolBytes = 0;
  for (let j = 0; j < M; j++) {
    const enc = TEXT_ENCODER.encode(uniqueMm[j]);
    mmEncoded[j] = enc;
    mmPoolBytes += enc.length;
  }
  const cmmEncoded = new Array(P);
  let cmmPoolBytes = 0;
  for (let p = 0; p < P; p++) {
    const enc = TEXT_ENCODER.encode(uniqueCmm[p]);
    cmmEncoded[p] = enc;
    cmmPoolBytes += enc.length;
  }

  const mmOffsetsBytes = (M + 1) * 4;
  const mmOrderedIndexBytes = N * 4;
  const cmmOffsetsBytes = (P + 1) * 4;
  const cmmIndexBytes = M * 4;

  const mmOffsetsOffset = HEADER_SIZE;
  const mmPoolOffset = mmOffsetsOffset + mmOffsetsBytes;
  const mmIndexOffset = mmPoolOffset + mmPoolBytes;
  const cmmOffsetsOffset = mmIndexOffset + mmOrderedIndexBytes;
  const cmmPoolOffset = cmmOffsetsOffset + cmmOffsetsBytes;
  const cmmIndexOffset = cmmPoolOffset + cmmPoolBytes;
  const total = cmmIndexOffset + cmmIndexBytes;

  const buf = opts.shared ? new SharedArrayBuffer(total) : new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setUint32(HDR_MAGIC, MAGIC, true);
  dv.setUint32(HDR_VERSION, VERSION, true);
  dv.setUint32(HDR_UNIQUE_COUNT, M, true);
  dv.setUint32(HDR_ORDERED_COUNT, N, true);
  dv.setUint32(HDR_CMM_UNIQUE_COUNT, P, true);
  dv.setUint32(HDR_POOL_OFFSET, mmPoolOffset, true);
  dv.setUint32(HDR_INDEX_OFFSET, mmIndexOffset, true);
  dv.setUint32(HDR_CMM_OFFSETS_OFFSET, cmmOffsetsOffset, true);
  dv.setUint32(HDR_CMM_POOL_OFFSET, cmmPoolOffset, true);
  dv.setUint32(HDR_CMM_INDEX_OFFSET, cmmIndexOffset, true);

  // MM unique offsets + pool bytes.
  let p = mmPoolOffset;
  for (let j = 0; j < M; j++) {
    dv.setUint32(mmOffsetsOffset + j * 4, p, true);
    u8.set(mmEncoded[j], p);
    p += mmEncoded[j].length;
  }
  dv.setUint32(mmOffsetsOffset + M * 4, p, true); // MM sentinel

  // MM ordered index entries.
  for (let i = 0; i < N; i++) {
    const j = mmIndexOf.get(orderedSentences[i]);
    dv.setUint32(mmIndexOffset + i * 4, j, true);
  }

  // CMM unique offsets + pool bytes.
  let q = cmmPoolOffset;
  for (let pIdx = 0; pIdx < P; pIdx++) {
    dv.setUint32(cmmOffsetsOffset + pIdx * 4, q, true);
    u8.set(cmmEncoded[pIdx], q);
    q += cmmEncoded[pIdx].length;
  }
  dv.setUint32(cmmOffsetsOffset + P * 4, q, true); // CMM sentinel

  // Per-unique-MM CMM index entries.
  for (let j = 0; j < M; j++) {
    const cmmIdx = cmmIndexOf.get(cmmForUnique[j]);
    dv.setUint32(cmmIndexOffset + j * 4, cmmIdx, true);
  }

  return buf;
}

// wrapMonotypedModel(buf) -> view
//
// Returns an object exposing v2 fields/methods. v1 fixtures are not
// accepted (hard cut at the format change).
//
// Existing v1-compatible surface:
//   .buf: .uniqueCount, .orderedCount,
//   .uniqueAt(j): .at(i), .hasSorted(s),
//   .iterateUnique(): .iterateOrdered()
//
// New v2 surface (CMM):
//   .cmmUniqueCount
//   .cmmUniqueAt(p)           decode CMM at CMM-pool index p
//   .cmmHasSorted(s)          binary-search CMM pool with string s
//   .cmmIndexOfUnique(j)      unique-MM index j → CMM-pool index
//   .cmmIndexOfOrdered(i)     corpus position i → CMM-pool index (chains)
//   .cmmAtOrdered(i)          corpus position i → CMM string (chains + decode)
//
// Cross-sab convenience (wrapper-as-object):
//   .exactMatchAtOrdered(otherView, i)   does MM at my corpus pos i
//                                        appear in otherView.hasSorted?
//   .variantMatchAtOrdered(otherView, i) does CMM at my corpus pos i
//                                        appear in otherView.cmmHasSorted?
//
// Throws on bad magic / unsupported version.
export function wrapMonotypedModel(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const magic = dv.getUint32(HDR_MAGIC, true);
  if (magic !== MAGIC) {
    throw new Error(`wrapMonotypedModel: bad magic 0x${magic.toString(16)} (expected NTMM)`);
  }
  const version = dv.getUint32(HDR_VERSION, true);
  if (version !== VERSION) {
    throw new Error(`wrapMonotypedModel: unsupported version ${version} (expected ${VERSION})`);
  }
  const uniqueCount = dv.getUint32(HDR_UNIQUE_COUNT, true);
  const orderedCount = dv.getUint32(HDR_ORDERED_COUNT, true);
  const cmmUniqueCount = dv.getUint32(HDR_CMM_UNIQUE_COUNT, true);
  const mmOffsetsOffset = HEADER_SIZE;
  const indexOffset = dv.getUint32(HDR_INDEX_OFFSET, true);
  const cmmOffsetsOffset = dv.getUint32(HDR_CMM_OFFSETS_OFFSET, true);
  const cmmIndexOffset = dv.getUint32(HDR_CMM_INDEX_OFFSET, true);

  function mmRangeOf(j) {
    const start = dv.getUint32(mmOffsetsOffset + j * 4, true);
    const end = dv.getUint32(mmOffsetsOffset + (j + 1) * 4, true);
    return { start, end };
  }
  function cmmRangeOf(p) {
    const start = dv.getUint32(cmmOffsetsOffset + p * 4, true);
    const end = dv.getUint32(cmmOffsetsOffset + (p + 1) * 4, true);
    return { start, end };
  }
  function decodeRange(range) {
    const len = range.end - range.start;
    // Browsers reject TextDecoder.decode on Uint8Array views backed
    // by a SharedArrayBuffer. Copy into a non-shared buffer first.
    const copy = new Uint8Array(len);
    copy.set(u8.subarray(range.start, range.end));
    return TEXT_DECODER.decode(copy);
  }

  function uniqueAt(j) {
    if (j < 0 || j >= uniqueCount) {
      throw new RangeError(`wrapMonotypedModel.uniqueAt: ${j} out of range [0, ${uniqueCount})`);
    }
    return decodeRange(mmRangeOf(j));
  }
  function at(i) {
    if (i < 0 || i >= orderedCount) {
      throw new RangeError(`wrapMonotypedModel.at: ${i} out of range [0, ${orderedCount})`);
    }
    const j = dv.getUint32(indexOffset + i * 4, true);
    return uniqueAt(j);
  }
  function* iterateUnique() {
    for (let j = 0; j < uniqueCount; j++) yield uniqueAt(j);
  }
  function* iterateOrdered() {
    for (let i = 0; i < orderedCount; i++) yield at(i);
  }
  function compareRangeToBytes(range, needle) {
    const { start, end } = range;
    const len = end - start;
    const cmpLen = Math.min(len, needle.length);
    for (let k = 0; k < cmpLen; k++) {
      const a = u8[start + k];
      const b = needle[k];
      if (a !== b) return a < b ? -1 : 1;
    }
    if (len < needle.length) return -1;
    if (len > needle.length) return 1;
    return 0;
  }
  function hasSorted(needle) {
    if (typeof needle !== 'string') return false;
    const bytes = TEXT_ENCODER.encode(needle);
    let lo = 0, hi = uniqueCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareRangeToBytes(mmRangeOf(mid), bytes);
      if (cmp === 0) return true;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  function cmmUniqueAt(p) {
    if (p < 0 || p >= cmmUniqueCount) {
      throw new RangeError(`wrapMonotypedModel.cmmUniqueAt: ${p} out of range [0, ${cmmUniqueCount})`);
    }
    return decodeRange(cmmRangeOf(p));
  }
  function cmmHasSorted(needle) {
    if (typeof needle !== 'string') return false;
    const bytes = TEXT_ENCODER.encode(needle);
    let lo = 0, hi = cmmUniqueCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareRangeToBytes(cmmRangeOf(mid), bytes);
      if (cmp === 0) return true;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
  function cmmIndexOfUnique(j) {
    if (j < 0 || j >= uniqueCount) {
      throw new RangeError(`wrapMonotypedModel.cmmIndexOfUnique: ${j} out of range [0, ${uniqueCount})`);
    }
    return dv.getUint32(cmmIndexOffset + j * 4, true);
  }
  function cmmIndexOfOrdered(i) {
    if (i < 0 || i >= orderedCount) {
      throw new RangeError(`wrapMonotypedModel.cmmIndexOfOrdered: ${i} out of range [0, ${orderedCount})`);
    }
    const j = dv.getUint32(indexOffset + i * 4, true);
    return dv.getUint32(cmmIndexOffset + j * 4, true);
  }
  function cmmAtOrdered(i) {
    return cmmUniqueAt(cmmIndexOfOrdered(i));
  }

  const view = {
    buf,
    uniqueCount,
    orderedCount,
    cmmUniqueCount,
    uniqueAt,
    at,
    hasSorted,
    iterateUnique,
    iterateOrdered,
    cmmUniqueAt,
    cmmHasSorted,
    cmmIndexOfUnique,
    cmmIndexOfOrdered,
    cmmAtOrdered,
  };

  // Cross-sab convenience methods. Internally consult only the
  // primitives on each side's wrapper, preserving the wrapper-as-
  // object boundary.
  view.exactMatchAtOrdered = function exactMatchAtOrdered(otherView, i) {
    return otherView.hasSorted(at(i));
  };
  view.variantMatchAtOrdered = function variantMatchAtOrdered(otherView, i) {
    return otherView.cmmHasSorted(cmmAtOrdered(i));
  };

  return view;
}
