// entries-sab.js: packed (type, word) entries in a SharedArrayBuffer.
//
// Layout:
//   header (32 bytes)
//     u32 magic         "NTEN" (NiceText ENtries) little-endian
//     u32 version       1
//     u32 entryCount    number of entries currently appended
//     u32 entryCapacity max entries the offset table can hold
//     u32 poolUsed      bytes currently used in the string pool
//     u32 poolCapacity  bytes available in the string pool
//     u32 entriesOffset byte offset of the entry-offset table
//     u32 poolOffset    byte offset of the string pool
//   entry-offset table (entryCapacity * 8 bytes)
//     each entry: u32 typeStringOffset, u32 wordStringOffset
//     offsets are absolute byte offsets into the SAB
//   string pool (poolCapacity bytes)
//     each string: u16 byteLength + UTF-8 bytes (no null terminator)
//     strings are appended; no string-level dedup in v1
//
// Two reasons strings carry an inline length rather than null-
// termination: (1) avoids a scan to find the boundary, (2) lets the
// dedup table key on (offset, length) without re-reading the pool.
//
// All multi-byte fields are little-endian. Browser-safe ESM. No deps.

const MAGIC = 0x4E45544E; // "NTEN" little-endian
const VERSION = 1;

const HDR_MAGIC = 0;
const HDR_VERSION = 4;
const HDR_ENTRY_COUNT = 8;
const HDR_ENTRY_CAPACITY = 12;
const HDR_POOL_USED = 16;
const HDR_POOL_CAPACITY = 20;
const HDR_ENTRIES_OFFSET = 24;
const HDR_POOL_OFFSET = 28;
const HEADER_SIZE = 32;
const ENTRY_SLOT_SIZE = 8; // u32 typeOff + u32 wordOff
const STRING_LEN_PREFIX = 2; // u16

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Estimate the SAB byte size needed to hold up to `entryCapacity`
// entries with `poolCapacity` bytes of string data. Caller should
// pad poolCapacity for headroom; appendEntry returns false when full.
export function entriesSabByteLength(entryCapacity, poolCapacity) {
  return HEADER_SIZE + entryCapacity * ENTRY_SLOT_SIZE + poolCapacity;
}

// Allocate a fresh entries-SAB with the requested capacity. Returns
// a `view` object the rest of the API consumes; the caller can pass
// `view.sab` across worker boundaries.
export function createEntriesSAB(entryCapacity, poolCapacity) {
  if (!Number.isInteger(entryCapacity) || entryCapacity < 0) {
    throw new Error('createEntriesSAB: entryCapacity must be a non-negative integer');
  }
  if (!Number.isInteger(poolCapacity) || poolCapacity < 0) {
    throw new Error('createEntriesSAB: poolCapacity must be a non-negative integer');
  }
  const total = entriesSabByteLength(entryCapacity, poolCapacity);
  const sab = new SharedArrayBuffer(total);
  const dv = new DataView(sab);
  dv.setUint32(HDR_MAGIC, MAGIC, true);
  dv.setUint32(HDR_VERSION, VERSION, true);
  dv.setUint32(HDR_ENTRY_COUNT, 0, true);
  dv.setUint32(HDR_ENTRY_CAPACITY, entryCapacity, true);
  dv.setUint32(HDR_POOL_USED, 0, true);
  dv.setUint32(HDR_POOL_CAPACITY, poolCapacity, true);
  const entriesOffset = HEADER_SIZE;
  const poolOffset = entriesOffset + entryCapacity * ENTRY_SLOT_SIZE;
  dv.setUint32(HDR_ENTRIES_OFFSET, entriesOffset, true);
  dv.setUint32(HDR_POOL_OFFSET, poolOffset, true);
  return wrapEntriesSAB(sab);
}

// Wrap a previously-allocated entries-SAB (e.g. one received from a
// worker) into the runtime view object. Validates the magic/version.
export function wrapEntriesSAB(sab) {
  const dv = new DataView(sab);
  const magic = dv.getUint32(HDR_MAGIC, true);
  if (magic !== MAGIC) {
    throw new Error(`wrapEntriesSAB: bad magic 0x${magic.toString(16)} (expected NTEN)`);
  }
  const version = dv.getUint32(HDR_VERSION, true);
  if (version !== VERSION) {
    throw new Error(`wrapEntriesSAB: unsupported version ${version}`);
  }
  return {
    sab,
    dv,
    bytes: new Uint8Array(sab),
    entriesOffset: dv.getUint32(HDR_ENTRIES_OFFSET, true),
    poolOffset: dv.getUint32(HDR_POOL_OFFSET, true),
    entryCapacity: dv.getUint32(HDR_ENTRY_CAPACITY, true),
    poolCapacity: dv.getUint32(HDR_POOL_CAPACITY, true),
  };
}

export function entryCount(view) {
  return view.dv.getUint32(HDR_ENTRY_COUNT, true);
}

export function poolUsed(view) {
  return view.dv.getUint32(HDR_POOL_USED, true);
}

// Append a (type, word) pair to the end of the SAB. Returns true on
// success, false on capacity overflow (caller should grow). Writes
// are not atomic across multi-worker contexts; this helper is for the
// orchestrator / packers that own the SAB, not for parallel append.
export function appendEntry(view, type, word) {
  const count = entryCount(view);
  if (count >= view.entryCapacity) return false;
  const typeBytes = TEXT_ENCODER.encode(type);
  const wordBytes = TEXT_ENCODER.encode(word);
  const need = STRING_LEN_PREFIX + typeBytes.length + STRING_LEN_PREFIX + wordBytes.length;
  const used = poolUsed(view);
  if (used + need > view.poolCapacity) return false;
  if (typeBytes.length > 0xFFFF || wordBytes.length > 0xFFFF) {
    throw new Error('appendEntry: string longer than 65535 bytes; raise the prefix width');
  }
  // Write type into pool.
  const typeOff = view.poolOffset + used;
  view.dv.setUint16(typeOff, typeBytes.length, true);
  view.bytes.set(typeBytes, typeOff + STRING_LEN_PREFIX);
  let cursor = typeOff + STRING_LEN_PREFIX + typeBytes.length;
  // Write word into pool.
  const wordOff = cursor;
  view.dv.setUint16(wordOff, wordBytes.length, true);
  view.bytes.set(wordBytes, wordOff + STRING_LEN_PREFIX);
  cursor = wordOff + STRING_LEN_PREFIX + wordBytes.length;
  view.dv.setUint32(HDR_POOL_USED, cursor - view.poolOffset, true);
  // Write entry-offset slot.
  const slotOff = view.entriesOffset + count * ENTRY_SLOT_SIZE;
  view.dv.setUint32(slotOff, typeOff, true);
  view.dv.setUint32(slotOff + 4, wordOff, true);
  view.dv.setUint32(HDR_ENTRY_COUNT, count + 1, true);
  return true;
}

// `TextDecoder.decode()` rejects views backed by SharedArrayBuffer
// (the spec requires non-shared buffers). Copy the slice into a fresh
// non-shared Uint8Array before decoding. The copy is small (one
// string at a time) so the cost is bounded.
function decodeStringFromSAB(bytes, start, length) {
  if (length === 0) return '';
  const copy = new Uint8Array(length);
  for (let i = 0; i < length; i++) copy[i] = bytes[start + i];
  return TEXT_DECODER.decode(copy);
}

// Read the (type, word) pair at index i. Decodes UTF-8 lazily.
export function entryAt(view, i) {
  const slotOff = view.entriesOffset + i * ENTRY_SLOT_SIZE;
  const typeOff = view.dv.getUint32(slotOff, true);
  const wordOff = view.dv.getUint32(slotOff + 4, true);
  const typeLen = view.dv.getUint16(typeOff, true);
  const wordLen = view.dv.getUint16(wordOff, true);
  const type = decodeStringFromSAB(view.bytes, typeOff + STRING_LEN_PREFIX, typeLen);
  const word = decodeStringFromSAB(view.bytes, wordOff + STRING_LEN_PREFIX, wordLen);
  return { type, word };
}

// Iterate every (type, word) pair in the SAB in append order.
export function* iterEntries(view) {
  const n = entryCount(view);
  for (let i = 0; i < n; i++) yield entryAt(view, i);
}

// Read the raw byte spans at index i without decoding to JS strings.
// Useful for the dedup table to compare keys without paying UTF-8
// decode cost. Returns offsets and lengths into view.bytes.
export function entrySpansAt(view, i) {
  const slotOff = view.entriesOffset + i * ENTRY_SLOT_SIZE;
  const typeOff = view.dv.getUint32(slotOff, true);
  const wordOff = view.dv.getUint32(slotOff + 4, true);
  const typeLen = view.dv.getUint16(typeOff, true);
  const wordLen = view.dv.getUint16(wordOff, true);
  return {
    typeStart: typeOff + STRING_LEN_PREFIX,
    typeLen,
    wordStart: wordOff + STRING_LEN_PREFIX,
    wordLen,
  };
}

// One-shot pack of a JS-object entries array into a fresh entries-SAB.
// Sizes the pool by measuring; sizes the entry table to entries.length.
// Returns the wrapped view. The caller should `.sab` for transfer.
//
// Use packEntries (sync) for small inputs, registry pack fns,
// tests, anything well under ~100K entries. Use packEntriesAsync
// for hot-loop callers where the loop dominates (aug-pipeline's
// 4M-entry t0 union); the async version yields to the event loop
// and emits progress so the page can keep its progress modal alive.
export function packEntries(entries) {
  let poolBytes = 0;
  for (const e of entries) {
    const t = TEXT_ENCODER.encode(e.type);
    const w = TEXT_ENCODER.encode(e.word);
    poolBytes += STRING_LEN_PREFIX + t.length + STRING_LEN_PREFIX + w.length;
    if (t.length > 0xFFFF || w.length > 0xFFFF) {
      throw new Error('packEntries: string longer than 65535 bytes');
    }
  }
  const view = createEntriesSAB(entries.length, poolBytes);
  for (const e of entries) {
    if (!appendEntry(view, e.type, e.word)) {
      throw new Error('packEntries: capacity exhausted (sizing bug)');
    }
  }
  return view;
}

// packEntriesAsync(entries, opts), yielding variant for big inputs.
//
//   opts.onProgress  optional. Receives:
//     { phase: 't0-pack-start',    total }
//     { phase: 't0-pack-progress', i, total }    every yieldEvery items
//     { phase: 't0-pack-end',      total }
//   opts.yieldEvery  items per yield (default 50,000). Lower = more
//                    progress / more event-loop time; higher = faster
//                    raw throughput.
//   opts.signal      optional AbortSignal. Throws AbortError mid-loop.
//
// Two passes (measure pool size, then write); each pass yields at
// every yieldEvery boundary. The phase tag is 't0-pack' regardless
// of which pass, callers typically only need overall progress.
export async function packEntriesAsync(entries, opts = {}) {
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const total = entries.length;
  if (onProgress) onProgress({ phase: 't0-pack-start', total });
  let poolBytes = 0;
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    const t = TEXT_ENCODER.encode(e.type);
    const w = TEXT_ENCODER.encode(e.word);
    poolBytes += STRING_LEN_PREFIX + t.length + STRING_LEN_PREFIX + w.length;
    if (t.length > 0xFFFF || w.length > 0xFFFF) {
      throw new Error('packEntriesAsync: string longer than 65535 bytes');
    }
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 't0-pack-progress', i: i + 1, total });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const view = createEntriesSAB(total, poolBytes);
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    if (!appendEntry(view, e.type, e.word)) {
      throw new Error('packEntriesAsync: capacity exhausted (sizing bug)');
    }
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 't0-pack-progress', i: total + i + 1, total: total * 2 });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress({ phase: 't0-pack-end', total });
  return view;
}

// Unpack the entire SAB into a JS-object array. Inverse of packEntries.
// Allocates one object per entry; intended for adapter / test paths,
// not for hot loops (those should use entrySpansAt directly or
// unpackEntriesAsync for big inputs).
export function unpackEntries(view) {
  const out = [];
  const n = entryCount(view);
  for (let i = 0; i < n; i++) out.push(entryAt(view, i));
  return out;
}

// unpackEntriesAsync(view, opts), yielding variant for big inputs.
//
//   opts.onProgress  optional. Receives:
//     { phase: 'merge-start',    total }
//     { phase: 'merge-progress', i, total }   every yieldEvery items
//     { phase: 'merge-end',      total }
//   opts.yieldEvery  items per yield (default 50,000)
//   opts.signal      optional AbortSignal
//   opts.label       optional sub-label passed back in progress events
//                    (e.g., the iteration name when merging multiple
//                    layers); rendered into the row text by the
//                    caller's onProgress handler.
export async function unpackEntriesAsync(view, opts = {}) {
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const label = opts.label ?? null;
  const out = [];
  const n = entryCount(view);
  if (onProgress) onProgress({ phase: 'merge-start', total: n, label });
  for (let i = 0; i < n; i++) {
    out.push(entryAt(view, i));
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 'merge-progress', i: i + 1, total: n, label });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress({ phase: 'merge-end', total: n, label });
  return out;
}

function makeAbort() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// ---------------------------------------------------------------------
// Dedup hash table (separate SAB, partner to entries-SAB).
//
// Open-addressing hash table over (type-bytes, word-bytes) keys, where
// the keys live in the partner entries-SAB's string pool. Slots store
// the entry index in the partner SAB; sentinel 0xFFFFFFFF means empty.
//
// Header (16 bytes): magic 'NTDD', version, slotCount, occupied.
// Slots: u32 entryIndex each. Lookups hash the key bytes, probe
// linearly until empty or match.
//
// Capacity: caller provides slotCount (must be a power of two for the
// mask trick). Load factor stays ≤ 0.5 if caller sizes
// slotCount = 2 * expectedEntries (rounded up to next power of two).
// ---------------------------------------------------------------------

const DD_MAGIC = 0x44444E54; // "NTDD"
const DD_VERSION = 1;
const DD_HDR_MAGIC = 0;
const DD_HDR_VERSION = 4;
const DD_HDR_SLOT_COUNT = 8;
const DD_HDR_OCCUPIED = 12;
const DD_HEADER_SIZE = 16;
const DD_EMPTY = 0xFFFFFFFF;

export function createDedupTable(slotCount) {
  if (!Number.isInteger(slotCount) || slotCount <= 0) {
    throw new Error('createDedupTable: slotCount must be a positive integer');
  }
  if ((slotCount & (slotCount - 1)) !== 0) {
    throw new Error('createDedupTable: slotCount must be a power of two');
  }
  const size = DD_HEADER_SIZE + slotCount * 4;
  const sab = new SharedArrayBuffer(size);
  const dv = new DataView(sab);
  dv.setUint32(DD_HDR_MAGIC, DD_MAGIC, true);
  dv.setUint32(DD_HDR_VERSION, DD_VERSION, true);
  dv.setUint32(DD_HDR_SLOT_COUNT, slotCount, true);
  dv.setUint32(DD_HDR_OCCUPIED, 0, true);
  const slots = new Uint32Array(sab, DD_HEADER_SIZE, slotCount);
  slots.fill(DD_EMPTY);
  return wrapDedupTable(sab);
}

export function wrapDedupTable(sab) {
  const dv = new DataView(sab);
  const magic = dv.getUint32(DD_HDR_MAGIC, true);
  if (magic !== DD_MAGIC) throw new Error(`wrapDedupTable: bad magic 0x${magic.toString(16)}`);
  const version = dv.getUint32(DD_HDR_VERSION, true);
  if (version !== DD_VERSION) throw new Error(`wrapDedupTable: unsupported version ${version}`);
  const slotCount = dv.getUint32(DD_HDR_SLOT_COUNT, true);
  return {
    sab,
    dv,
    slotCount,
    mask: slotCount - 1,
    slots: new Uint32Array(sab, DD_HEADER_SIZE, slotCount),
  };
}

export function dedupOccupied(table) {
  return table.dv.getUint32(DD_HDR_OCCUPIED, true);
}

// Polynomial hash over a contiguous byte range of an entries-SAB's
// pool. Plain FNV-1a, fast enough for the volumes here.
function hashRange(bytes, start, length) {
  let h = 0x811c9dc5;
  const end = start + length;
  for (let i = start; i < end; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashPair(bytes, typeStart, typeLen, wordStart, wordLen) {
  // Hash the two byte ranges as if separated by a 0xFF byte (which
  // never appears in valid UTF-8) so collisions across boundaries
  // cannot happen.
  let h = 0x811c9dc5;
  const tEnd = typeStart + typeLen;
  for (let i = typeStart; i < tEnd; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= 0xFF;
  h = Math.imul(h, 0x01000193);
  const wEnd = wordStart + wordLen;
  for (let i = wordStart; i < wEnd; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesEqualRange(a, aStart, aLen, b, bStart, bLen) {
  if (aLen !== bLen) return false;
  for (let i = 0; i < aLen; i++) {
    if (a[aStart + i] !== b[bStart + i]) return false;
  }
  return true;
}

// Test whether a (type-bytes, word-bytes) key is already present in
// the table. The key is given as byte spans into `keyView.bytes`
// (the partner entries-SAB the table indexes into); slot values are
// indices into `entriesView`'s entry table for already-stored keys.
//
// `keyView` and `entriesView` may be the same view (when looking up
// an existing entry) or different (when checking a candidate from
// elsewhere: useful for cross-SAB dedup).
export function dedupHas(table, entriesView, keyView, typeStart, typeLen, wordStart, wordLen) {
  const h = hashPair(keyView.bytes, typeStart, typeLen, wordStart, wordLen);
  let slot = h & table.mask;
  for (let probes = 0; probes < table.slotCount; probes++) {
    const idx = table.slots[slot];
    if (idx === DD_EMPTY) return false;
    const span = entrySpansAt(entriesView, idx);
    if (
      bytesEqualRange(
        keyView.bytes, typeStart, typeLen,
        entriesView.bytes, span.typeStart, span.typeLen,
      ) &&
      bytesEqualRange(
        keyView.bytes, wordStart, wordLen,
        entriesView.bytes, span.wordStart, span.wordLen,
      )
    ) {
      return true;
    }
    slot = (slot + 1) & table.mask;
  }
  return false;
}

// Insert a (type-bytes, word-bytes) → entryIndex mapping. Returns
// true on insert, false if the key was already present (no change).
// Throws if the table is full (caller should size up front).
export function dedupAdd(table, entriesView, entryIndex) {
  const span = entrySpansAt(entriesView, entryIndex);
  const h = hashPair(entriesView.bytes, span.typeStart, span.typeLen, span.wordStart, span.wordLen);
  let slot = h & table.mask;
  for (let probes = 0; probes < table.slotCount; probes++) {
    const idx = table.slots[slot];
    if (idx === DD_EMPTY) {
      table.slots[slot] = entryIndex;
      table.dv.setUint32(DD_HDR_OCCUPIED, dedupOccupied(table) + 1, true);
      return true;
    }
    const existing = entrySpansAt(entriesView, idx);
    if (
      bytesEqualRange(
        entriesView.bytes, span.typeStart, span.typeLen,
        entriesView.bytes, existing.typeStart, existing.typeLen,
      ) &&
      bytesEqualRange(
        entriesView.bytes, span.wordStart, span.wordLen,
        entriesView.bytes, existing.wordStart, existing.wordLen,
      )
    ) {
      return false; // already present
    }
    slot = (slot + 1) & table.mask;
  }
  throw new Error('dedupAdd: hash table is full (caller must size up front)');
}

// Convenience for callers operating on JS strings (e.g. tests, the
// adapter that wraps the legacy aug entry points). Encodes the strings
// into a small scratch entries-SAB region and calls dedupHas.
export function dedupHasJSKey(table, entriesView, type, word) {
  const typeBytes = TEXT_ENCODER.encode(type);
  const wordBytes = TEXT_ENCODER.encode(word);
  // Allocate a scratch buffer just for hashing/comparison. Avoiding
  // the ergonomic helper in hot loops; this is for occasional
  // checks.
  const buf = new Uint8Array(typeBytes.length + wordBytes.length);
  buf.set(typeBytes, 0);
  buf.set(wordBytes, typeBytes.length);
  const fakeView = { bytes: buf };
  return dedupHas(
    table, entriesView, fakeView,
    0, typeBytes.length,
    typeBytes.length, wordBytes.length,
  );
}

// Choose a slot count for `expectedEntries` keeping load factor ≤ 0.5
// (i.e. slotCount ≥ 2 * expectedEntries, rounded up to the next
// power of two). Minimum slotCount = 16 to avoid pathological tiny
// tables in tests.
export function dedupSlotCountFor(expectedEntries) {
  let n = Math.max(16, expectedEntries * 2);
  // Round up to next power of two.
  let p = 16;
  while (p < n) p <<= 1;
  return p;
}
