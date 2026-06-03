// SAB binary packer for sentence-model-table JSON. Same shape rationale
// as the dict packer: workers share one SAB ref, no per-isolate parse,
// engine reads via byte-offset arithmetic. See docs/architecture-sab.md
// for layout notes.
//
// Browser-safe ESM. No Node deps.

const MAGIC = 0x544D544E; // "NTMT" little-endian
const VERSION = 1;

// Header layout (48 bytes):
//   0  magic           u32 ("NTMT" LE)
//   4  version         u32
//   8  typeNameCount   u32  (T')
//  12  modelCount      u32  (M)
//  16  punctCount      u32  (P)
//  20  orderedFlag     u32  (0 or 1)
//  24  typeNamesOff    u32  (T' u32 entries: stringOffset each)
//  28  punctsOff       u32  (P u32 entries: stringOffset each)
//  32  modelTableOff   u32  (M entries, 12 bytes each)
//  36  tokensOff       u32  (N u32 tokens, count is sum of model tokenCount)
//  40  stringPoolOff   u32
//  44  stringPoolLen   u32
const HEADER_SIZE = 48;

// Each entry in typeNames or puncts is a u32 stringOffset (length lives
// in the pool's length-prefix, same as dict's string pool).
const NAME_ENTRY_SIZE = 4;

// Each model-table entry (12 bytes):
//   0  tokenOffset  u32  absolute byte offset into the SAB tokens section
//   4  tokenCount   u32
//   8  weight       u32
const MODEL_ENTRY_SIZE = 12;

// Each token is a u32. The high bit (PUNCT_FLAG) selects punct vs.
// typeName; the low 31 bits are the index into the corresponding table.
const TOKEN_PUNCT_FLAG = 0x80000000;
const TOKEN_INDEX_MASK = 0x7FFFFFFF;

const POOL_LEN_PREFIX_SIZE = 2;

export const MODELTABLE_SAB_CONSTANTS = {
  MAGIC, VERSION, HEADER_SIZE,
  NAME_ENTRY_SIZE, MODEL_ENTRY_SIZE,
  TOKEN_PUNCT_FLAG, TOKEN_INDEX_MASK,
};

const ENCODER = new TextEncoder();

// packModelTableToSABAsync(json, opts), yielding variant.
//
// Same byte layout as packModelTableToSAB; yields every yieldEvery
// models in the model-table + tokens write loop, which is the loop
// that dominates on big models (Shakespeare ~71K models, ~3M
// tokens). String-pool intern + section sizing are fast (T'+P
// strings, ~few thousand) and stay sync.
//
// opts:
//   onProgress  (event) => void. Shapes:
//     { phase: 'packmodel-start',    totalModels }
//     { phase: 'packmodel-progress', i, total }    every yieldEvery
//     { phase: 'packmodel-end',      totalModels }
//   yieldEvery  default 5,000 models
//   signal      optional AbortSignal
export async function packModelTableToSABAsync(json, opts = {}) {
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 5_000;
  const signal = opts.signal ?? null;
  if (!json || json.version !== 2) {
    throw new Error(`modeltable-pack: unsupported model-table version ${json && json.version}`);
  }
  if (!Array.isArray(json.typeNames)) {
    throw new Error('modeltable-pack: model table missing typeNames');
  }
  if (!Array.isArray(json.models)) {
    throw new Error('modeltable-pack: model table missing models');
  }
  const typeNames = json.typeNames;
  const models = json.models;
  const Tprime = typeNames.length;
  const M = models.length;
  if (onProgress) onProgress({ phase: 'packmodel-start', totalModels: M });

  const punctIndex = new Map();
  function internPunct(s) {
    let idx = punctIndex.get(s);
    if (idx === undefined) { idx = punctIndex.size; punctIndex.set(s, idx); }
    return idx;
  }
  let totalTokens = 0;
  for (const m of models) {
    if (!Array.isArray(m.tokens)) {
      throw new Error('modeltable-pack: model has no tokens array');
    }
    totalTokens += m.tokens.length;
    for (const t of m.tokens) if (typeof t === 'string') internPunct(t);
  }
  const P = punctIndex.size;

  const stringMap = new Map();
  const stringChunks = [];
  let stringPoolLen = 0;
  function intern(s) {
    let entry = stringMap.get(s);
    if (entry) return entry;
    const bts = ENCODER.encode(s);
    if (bts.length > 0xFFFF) {
      throw new Error(`modeltable-pack: string "${s.slice(0, 40)}..." exceeds u16 length`);
    }
    entry = { offset: stringPoolLen, length: bts.length };
    stringMap.set(s, entry);
    const prefix = new Uint8Array(POOL_LEN_PREFIX_SIZE);
    prefix[0] = bts.length & 0xFF;
    prefix[1] = (bts.length >> 8) & 0xFF;
    stringChunks.push(prefix);
    stringChunks.push(bts);
    stringPoolLen += POOL_LEN_PREFIX_SIZE + bts.length;
    return entry;
  }
  const typeNameOffsets = new Array(Tprime);
  for (let i = 0; i < Tprime; i++) typeNameOffsets[i] = intern(typeNames[i]).offset;
  const punctOffsets = new Array(P);
  for (const [s, idx] of punctIndex) punctOffsets[idx] = intern(s).offset;

  const typeNamesOff = HEADER_SIZE;
  const punctsOff = typeNamesOff + Tprime * NAME_ENTRY_SIZE;
  const modelTableOff = punctsOff + P * NAME_ENTRY_SIZE;
  const tokensOff = modelTableOff + M * MODEL_ENTRY_SIZE;
  const stringPoolOff = tokensOff + totalTokens * 4;
  const totalSize = stringPoolOff + stringPoolLen;

  let sab;
  try { sab = new SharedArrayBuffer(totalSize); }
  catch { sab = new ArrayBuffer(totalSize); }
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, Tprime, true);
  view.setUint32(12, M, true);
  view.setUint32(16, P, true);
  view.setUint32(20, json.ordered ? 1 : 0, true);
  view.setUint32(24, typeNamesOff, true);
  view.setUint32(28, punctsOff, true);
  view.setUint32(32, modelTableOff, true);
  view.setUint32(36, tokensOff, true);
  view.setUint32(40, stringPoolOff, true);
  view.setUint32(44, stringPoolLen, true);

  for (let i = 0; i < Tprime; i++) {
    view.setUint32(typeNamesOff + i * NAME_ENTRY_SIZE, typeNameOffsets[i], true);
  }
  for (let i = 0; i < P; i++) {
    view.setUint32(punctsOff + i * NAME_ENTRY_SIZE, punctOffsets[i], true);
  }

  let nextTokenByteOff = tokensOff;
  for (let i = 0; i < M; i++) {
    const m = models[i];
    const off = modelTableOff + i * MODEL_ENTRY_SIZE;
    view.setUint32(off + 0, nextTokenByteOff, true);
    view.setUint32(off + 4, m.tokens.length, true);
    view.setUint32(off + 8, m.weight | 0, true);
    for (let k = 0; k < m.tokens.length; k++) {
      const t = m.tokens[k];
      let encoded;
      if (typeof t === 'number') {
        if (t < 0 || t >= Tprime) {
          throw new Error(
            `modeltable-pack: model ${i} token ${k} typeName index ${t} out of range [0, ${Tprime})`
          );
        }
        encoded = t & TOKEN_INDEX_MASK;
      } else if (typeof t === 'string') {
        encoded = TOKEN_PUNCT_FLAG | (punctIndex.get(t) & TOKEN_INDEX_MASK);
      } else {
        throw new Error(`modeltable-pack: model ${i} token ${k} has unexpected type`);
      }
      view.setUint32(nextTokenByteOff + k * 4, encoded, true);
    }
    nextTokenByteOff += m.tokens.length * 4;
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw mtAbort();
      if (onProgress) onProgress({ phase: 'packmodel-progress', i: i + 1, total: M });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  let writePos = stringPoolOff;
  for (const chunk of stringChunks) {
    bytes.set(chunk, writePos);
    writePos += chunk.length;
  }

  if (onProgress) onProgress({ phase: 'packmodel-end', totalModels: M });
  return sab;
}

function mtAbort() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function packModelTableToSAB(json) {
  if (!json || json.version !== 2) {
    throw new Error(`modeltable-pack: unsupported model-table version ${json && json.version}`);
  }
  if (!Array.isArray(json.typeNames)) {
    throw new Error('modeltable-pack: model table missing typeNames');
  }
  if (!Array.isArray(json.models)) {
    throw new Error('modeltable-pack: model table missing models');
  }

  const typeNames = json.typeNames;
  const models = json.models;
  const Tprime = typeNames.length;
  const M = models.length;

  // Collect distinct punct strings in first-seen order; ~10-15 in
  // practice, so a Map<string, index> is fine.
  const punctIndex = new Map();
  function internPunct(s) {
    let idx = punctIndex.get(s);
    if (idx === undefined) {
      idx = punctIndex.size;
      punctIndex.set(s, idx);
    }
    return idx;
  }
  // Walk all tokens to populate punct table and count tokens.
  let totalTokens = 0;
  for (const m of models) {
    if (!Array.isArray(m.tokens)) {
      throw new Error('modeltable-pack: model has no tokens array');
    }
    totalTokens += m.tokens.length;
    for (const t of m.tokens) {
      if (typeof t === 'string') internPunct(t);
    }
  }
  const P = punctIndex.size;

  // String pool: intern type-names then puncts.
  const stringMap = new Map();
  const stringChunks = [];
  let stringPoolLen = 0;
  function intern(s) {
    let entry = stringMap.get(s);
    if (entry) return entry;
    const bytes = ENCODER.encode(s);
    if (bytes.length > 0xFFFF) {
      throw new Error(`modeltable-pack: string "${s.slice(0, 40)}..." exceeds u16 length`);
    }
    entry = { offset: stringPoolLen, length: bytes.length };
    stringMap.set(s, entry);
    const prefix = new Uint8Array(POOL_LEN_PREFIX_SIZE);
    prefix[0] = bytes.length & 0xFF;
    prefix[1] = (bytes.length >> 8) & 0xFF;
    stringChunks.push(prefix);
    stringChunks.push(bytes);
    stringPoolLen += POOL_LEN_PREFIX_SIZE + bytes.length;
    return entry;
  }
  const typeNameOffsets = new Array(Tprime);
  for (let i = 0; i < Tprime; i++) {
    typeNameOffsets[i] = intern(typeNames[i]).offset;
  }
  const punctOffsets = new Array(P);
  for (const [s, idx] of punctIndex) {
    punctOffsets[idx] = intern(s).offset;
  }

  // Section offsets.
  const typeNamesOff = HEADER_SIZE;
  const punctsOff = typeNamesOff + Tprime * NAME_ENTRY_SIZE;
  const modelTableOff = punctsOff + P * NAME_ENTRY_SIZE;
  const tokensOff = modelTableOff + M * MODEL_ENTRY_SIZE;
  const stringPoolOff = tokensOff + totalTokens * 4;
  const totalSize = stringPoolOff + stringPoolLen;

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
  view.setUint32(8, Tprime, true);
  view.setUint32(12, M, true);
  view.setUint32(16, P, true);
  view.setUint32(20, json.ordered ? 1 : 0, true);
  view.setUint32(24, typeNamesOff, true);
  view.setUint32(28, punctsOff, true);
  view.setUint32(32, modelTableOff, true);
  view.setUint32(36, tokensOff, true);
  view.setUint32(40, stringPoolOff, true);
  view.setUint32(44, stringPoolLen, true);

  // typeNames table.
  for (let i = 0; i < Tprime; i++) {
    view.setUint32(typeNamesOff + i * NAME_ENTRY_SIZE, typeNameOffsets[i], true);
  }
  // puncts table.
  for (let i = 0; i < P; i++) {
    view.setUint32(punctsOff + i * NAME_ENTRY_SIZE, punctOffsets[i], true);
  }

  // Model table + tokens.
  let nextTokenByteOff = tokensOff;
  for (let i = 0; i < M; i++) {
    const m = models[i];
    const off = modelTableOff + i * MODEL_ENTRY_SIZE;
    view.setUint32(off + 0, nextTokenByteOff, true);
    view.setUint32(off + 4, m.tokens.length, true);
    view.setUint32(off + 8, m.weight | 0, true);
    // Write tokens for this model.
    for (let k = 0; k < m.tokens.length; k++) {
      const t = m.tokens[k];
      let encoded;
      if (typeof t === 'number') {
        // typeName index, must fit in low 31 bits.
        if (t < 0 || t >= Tprime) {
          throw new Error(
            `modeltable-pack: model ${i} token ${k} typeName index ${t} out of range [0, ${Tprime})`
          );
        }
        encoded = t & TOKEN_INDEX_MASK;
      } else if (typeof t === 'string') {
        encoded = TOKEN_PUNCT_FLAG | (punctIndex.get(t) & TOKEN_INDEX_MASK);
      } else {
        throw new Error(`modeltable-pack: model ${i} token ${k} has unexpected type`);
      }
      view.setUint32(nextTokenByteOff + k * 4, encoded, true);
    }
    nextTokenByteOff += m.tokens.length * 4;
  }

  // String pool.
  let writePos = stringPoolOff;
  for (const chunk of stringChunks) {
    bytes.set(chunk, writePos);
    writePos += chunk.length;
  }

  return sab;
}

// unpackModelTableFromSAB(sab) -> model-table JSON object.
//
// Inverse of packModelTableToSAB at the JSON-shape level. Walks the
// SAB and reconstructs { version:2, name, ordered, typeNames, models }
// matching what build-model-table.js / generateModelTable emit. Used
// by `sab unpack model` (CLI native re-emit) and by test helpers that
// still walk the JSON shape (modeltable-sab.test.js).
//
// Note: the SAB format does not embed `json.name`; the field is
// metadata-only-on-load (no runtime consumer). `unpack` therefore
// returns `name: null`, callers that need the original name must
// keep the JSON intermediate or read the byos card.
//
// Browser-safe ESM (no fs / Buffer / process). Accepts SharedArrayBuffer
// or ArrayBuffer with the same byte layout.
const DECODER = new TextDecoder();
function readPoolStr(bytes, poolOff, poolBase) {
  const off = poolBase + poolOff;
  const len = bytes[off] | (bytes[off + 1] << 8);
  return DECODER.decode(bytes.slice(off + POOL_LEN_PREFIX_SIZE, off + POOL_LEN_PREFIX_SIZE + len));
}

export function unpackModelTableFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`modeltable-pack.unpack: bad SAB magic 0x${magic.toString(16)} (expected NTMT)`);
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`modeltable-pack.unpack: unsupported SAB version ${version}`);
  }
  const typeNameCount  = view.getUint32(8, true);
  const modelCount     = view.getUint32(12, true);
  const punctCount     = view.getUint32(16, true);
  const orderedFlag    = view.getUint32(20, true);
  const typeNamesOff   = view.getUint32(24, true);
  const punctsOff      = view.getUint32(28, true);
  const modelTableOff  = view.getUint32(32, true);
  const stringPoolOff  = view.getUint32(40, true);

  const typeNames = new Array(typeNameCount);
  for (let i = 0; i < typeNameCount; i++) {
    const poolOff = view.getUint32(typeNamesOff + i * NAME_ENTRY_SIZE, true);
    typeNames[i] = readPoolStr(bytes, poolOff, stringPoolOff);
  }
  const puncts = new Array(punctCount);
  for (let i = 0; i < punctCount; i++) {
    const poolOff = view.getUint32(punctsOff + i * NAME_ENTRY_SIZE, true);
    puncts[i] = readPoolStr(bytes, poolOff, stringPoolOff);
  }

  const models = new Array(modelCount);
  for (let i = 0; i < modelCount; i++) {
    const off = modelTableOff + i * MODEL_ENTRY_SIZE;
    const tokenOff   = view.getUint32(off + 0, true);
    const tokenCount = view.getUint32(off + 4, true);
    const weight     = view.getUint32(off + 8, true);
    const tokens = new Array(tokenCount);
    for (let k = 0; k < tokenCount; k++) {
      const tok = view.getUint32(tokenOff + k * 4, true);
      if (tok & TOKEN_PUNCT_FLAG) {
        tokens[k] = puncts[tok & TOKEN_INDEX_MASK];
      } else {
        tokens[k] = tok & TOKEN_INDEX_MASK;
      }
    }
    models[i] = { tokens, weight };
  }

  return {
    version: 2,
    name: null,
    ordered: !!orderedFlag,
    typeNames,
    models,
  };
}
