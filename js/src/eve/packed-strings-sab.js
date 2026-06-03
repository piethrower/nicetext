// packed-strings-sab.js: variable-length string array packed into
// a (Shared)ArrayBuffer. Used by Eve's load-twlist and
// load-corpus-precompute jobs to ship the parsed result across the
// nested-worker postMessage boundary without structured-cloning a
// Set/Map of hundreds of thousands or millions of entries.
//
// Layout (all little-endian):
//   header (16 bytes)
//     u32 magic       "NTPS" (NiceText Packed Strings)
//     u32 version     1
//     u32 stringCount number of strings
//     u32 poolOffset  byte offset of the utf-8 pool
//   offsets (4 * (stringCount + 1) bytes)
//     u32 per string, byte offset into the SAB pointing at the
//     string's first utf-8 byte. The +1 sentinel holds the
//     one-past-end pool position so the length of string i is
//     offsets[i+1] - offsets[i] (cheaper than per-string length
//     prefixes).
//   pool (variable)
//     utf-8 bytes, concatenated, no terminators
//
// Producers (build-time and worker-runtime) call `packStrings`. The
// returned buffer is a plain ArrayBuffer for build-time (so node's
// fs writes it directly to disk) or a SharedArrayBuffer for
// runtime (so workers share without copying). Consumers call
// `wrapPackedStrings(buf)` to get an iteration + sorted-membership
// view.
//
// Browser-safe and node-safe ESM, zero deps.

const MAGIC = 0x5350544E; // "NTPS" little-endian
const VERSION = 1;

const HDR_MAGIC = 0;
const HDR_VERSION = 4;
const HDR_STRING_COUNT = 8;
const HDR_POOL_OFFSET = 12;
const HEADER_SIZE = 16;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// packStrings(strings, opts?) -> ArrayBuffer | SharedArrayBuffer
//
// strings   Array<string>. Order is preserved. For
//           sorted-membership use, the caller must provide them
//           pre-sorted (lexicographic on utf-8 bytes). packStrings
//           does not sort.
// opts.shared  when true, returns a SharedArrayBuffer; otherwise an
//              ArrayBuffer (the default suits build-time output).
export function packStrings(strings, opts = {}) {
  if (!Array.isArray(strings)) {
    throw new TypeError('packStrings: strings must be an array');
  }
  const count = strings.length;
  // Two-pass to keep peak memory low. The previous implementation
  // allocated `count` Uint8Array views up front, which on very
  // large inputs (millions of words from impkimmo2026 family
  // TW-lists) put enough GC pressure on SpiderMonkey to surface
  // as "too much recursion." Pass 1 measures pool size with
  // transient encoded views that GC immediately; pass 2 encodes
  // again and writes directly into the destination buffer.
  let poolSize = 0;
  for (let i = 0; i < count; i++) {
    if (typeof strings[i] !== 'string') {
      throw new TypeError(`packStrings: strings[${i}] must be a string`);
    }
    poolSize += TEXT_ENCODER.encode(strings[i]).length;
  }
  const offsetsSize = (count + 1) * 4;
  const total = HEADER_SIZE + offsetsSize + poolSize;
  const buf = opts.shared ? new SharedArrayBuffer(total) : new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(HDR_MAGIC, MAGIC, true);
  dv.setUint32(HDR_VERSION, VERSION, true);
  dv.setUint32(HDR_STRING_COUNT, count, true);
  const poolOffset = HEADER_SIZE + offsetsSize;
  dv.setUint32(HDR_POOL_OFFSET, poolOffset, true);
  let p = poolOffset;
  for (let i = 0; i < count; i++) {
    dv.setUint32(HEADER_SIZE + i * 4, p, true);
    const bytes = TEXT_ENCODER.encode(strings[i]);
    u8.set(bytes, p);
    p += bytes.length;
  }
  dv.setUint32(HEADER_SIZE + count * 4, p, true); // sentinel
  return buf;
}

// wrapPackedStrings(buf) -> view
//
// Returns an object exposing:
//   .buf            the underlying ArrayBuffer / SharedArrayBuffer
//   .count          number of strings
//   .at(i)          decode and return string i (string allocation
//                   per call; use sparingly inside hot loops)
//   .iterate()      generator yielding each string in order
//   .hasSorted(s)   binary-search membership test; requires the
//                   producer to have packed sorted-unique strings.
//                   Compares utf-8 bytes directly, zero allocation
//                   on hit, one TextEncoder.encode on the needle.
//
// Throws on bad magic / unsupported version.
export function wrapPackedStrings(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const magic = dv.getUint32(HDR_MAGIC, true);
  if (magic !== MAGIC) {
    throw new Error(`wrapPackedStrings: bad magic 0x${magic.toString(16)} (expected NTPS)`);
  }
  const version = dv.getUint32(HDR_VERSION, true);
  if (version !== VERSION) {
    throw new Error(`wrapPackedStrings: unsupported version ${version}`);
  }
  const count = dv.getUint32(HDR_STRING_COUNT, true);

  function rangeOf(i) {
    const start = dv.getUint32(HEADER_SIZE + i * 4, true);
    const end = dv.getUint32(HEADER_SIZE + (i + 1) * 4, true);
    return { start, end };
  }
  function at(i) {
    if (i < 0 || i >= count) throw new RangeError(`wrapPackedStrings.at: ${i} out of range [0, ${count})`);
    const { start, end } = rangeOf(i);
    // Browsers reject TextDecoder.decode on Uint8Array views backed
    // by a SharedArrayBuffer. Copy into a non-shared buffer first.
    // Node doesn't enforce this, but the copy is cheap and keeps
    // the API cross-runtime.
    const len = end - start;
    const copy = new Uint8Array(len);
    copy.set(u8.subarray(start, end));
    return TEXT_DECODER.decode(copy);
  }
  function* iterate() {
    for (let i = 0; i < count; i++) yield at(i);
  }
  function compareAtToBytes(i, needle) {
    const { start, end } = rangeOf(i);
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
    let lo = 0, hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareAtToBytes(mid, bytes);
      if (cmp === 0) return true;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
  return { buf, count, at, iterate, hasSorted };
}

// Convenience for the runtime path: take a plain ArrayBuffer (e.g.
// from fetch+decompress), allocate a SharedArrayBuffer of the same
// size, and copy the bytes in. Returns the SAB. Lets workers
// expose their parsed result as a shared region while still
// reading the source as a regular ArrayBuffer.
export function copyIntoSharedArrayBuffer(arrayBuffer) {
  const u8src = new Uint8Array(arrayBuffer);
  const sab = new SharedArrayBuffer(u8src.byteLength);
  const u8dst = new Uint8Array(sab);
  u8dst.set(u8src);
  return sab;
}
