// Model-table model streams. Two modes:
//   - random:     weighted-random pick (generate new paragraphs from the source's sentence patterns)
//   - sequential: replay source models in order (recreates the source's structure exactly)
//
// Disk format (model table JSON, version 2):
//   {
//     "version": 2,
//     "name": "shakespeare",
//     "ordered": false,
//     "typeNames": ["N_3sg+Sg,...", "V_Base,...", "name_male", ...],
//     "models": [
//       { "tokens": [0, "Cap", 1, ". n"], "weight": 5 },   // ints index typeNames; strings are puncts
//       ...
//     ]
//   }
//
// Storing TYPE NAMES (rather than indexes into the source dict) makes the
// table portable: any dict that contains those type names can drive it.
// modelTableStream resolves names → that dict's typeIndex at construction time.
//
// Runtime: loadModelTable(json) packs into a SharedArrayBuffer (see
// docs/architecture-sab.md and js/src/builder/modeltable-pack.js); the
// runtime engine reads via byte-offset arithmetic. Streams decode tokens
// per .next() call into a small array of {kind, ...} items.
//
// Browser-safe ESM. No Node deps.

import { lookupType, lookupTypeByName } from './dictionary.js';
import { packModelTableToSAB, MODELTABLE_SAB_CONSTANTS } from './builder/modeltable-pack.js';

const {
  MAGIC, VERSION,
  NAME_ENTRY_SIZE, MODEL_ENTRY_SIZE,
  TOKEN_PUNCT_FLAG, TOKEN_INDEX_MASK,
} = MODELTABLE_SAB_CONSTANTS;

const POOL_LEN_PREFIX_SIZE = 2;
const DECODER = new TextDecoder();

function readHeader(view) {
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `modelTable: bad SAB magic 0x${magic.toString(16)} (expected NTMT)`
    );
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`modelTable: unsupported SAB version ${version}`);
  }
  return {
    typeNameCount:    view.getUint32(8, true),
    modelCount:       view.getUint32(12, true),
    punctCount:       view.getUint32(16, true),
    ordered:          view.getUint32(20, true) === 1,
    typeNamesOffset:  view.getUint32(24, true),
    punctsOffset:     view.getUint32(28, true),
    modelTableOffset: view.getUint32(32, true),
    tokensOffset:     view.getUint32(36, true),
    stringPoolOffset: view.getUint32(40, true),
    stringPoolLength: view.getUint32(44, true),
  };
}

// Build the model-table runtime object from parsed JSON. Pack into SAB
// once; subsequent stream creations reuse the SAB cheaply.
export function loadModelTable(json) {
  const sab = packModelTableToSAB(json);
  const table = wrapModelTableFromSAB(sab);
  table.json = json;
  table.name = json.name;
  return table;
}

// Wrap a previously-packed model-table SAB into the runtime table
// object, without re-packing. Used by workers that receive a SAB ref
// from the parent's resource cache.
export function wrapModelTableFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const header = readHeader(view);
  return {
    sab, view, bytes, header,
    ordered: header.ordered,
  };
}

// Summary stats for a wrapped model table. Walks the model entry table
// once for total / max token counts and summed weights; counts come
// from the SAB header. O(modelCount) with two u32 reads per entry.
//
// When `dict` is provided, also classifies each model as dynamic
// (at least one TYPE slot resolves to a multi-word type in dict) or
// static (zero bit-bearing slots, produces the same cover bytes
// every time regardless of secret). Static models are still
// emittable at encode time and carry natural cover variety; the
// encoder force-switches to a dynamic when too many statics in a
// row stall progress. See modelTableStream and js/src/encode.js.
export function modelTableStats(table, dict = null) {
  const N = table.header.modelCount;
  let totalTokens = 0;
  let totalWeight = 0;
  let maxLength = 0;
  for (let i = 0; i < N; i++) {
    const e = readModelEntry(table, i);
    totalTokens += e.tokenCount;
    totalWeight += e.weight;
    if (e.tokenCount > maxLength) maxLength = e.tokenCount;
  }
  const out = {
    modelCount: N,
    totalSentences: totalWeight,
    avgLength: N ? totalTokens / N : 0,
    maxLength,
    sabBytes: table.sab.byteLength,
  };
  if (dict) {
    const { nameToTypeIndex, nameHasBits } = buildNameResolution(table, dict);
    let dynamicModels = 0;
    for (let i = 0; i < N; i++) {
      if (modelHasAnyBitsAvailable(table, i, nameToTypeIndex, nameHasBits)) {
        dynamicModels++;
      }
    }
    out.dynamicModels = dynamicModels;
    out.staticModels = N - dynamicModels;
  }
  return out;
}

function readPoolString(table, poolRelOffset) {
  const off = table.header.stringPoolOffset + poolRelOffset;
  const len = table.bytes[off] | (table.bytes[off + 1] << 8);
  // slice (not subarray) so TextDecoder gets a non-shared view,
  // TextDecoder.decode rejects views over SharedArrayBuffer.
  return DECODER.decode(table.bytes.slice(off + 2, off + 2 + len));
}

function readTypeName(table, idx) {
  const stringOff = table.view.getUint32(
    table.header.typeNamesOffset + idx * NAME_ENTRY_SIZE, true
  );
  return readPoolString(table, stringOff);
}

function readPunct(table, idx) {
  const stringOff = table.view.getUint32(
    table.header.punctsOffset + idx * NAME_ENTRY_SIZE, true
  );
  return readPoolString(table, stringOff);
}

function readModelEntry(table, idx) {
  const off = table.header.modelTableOffset + idx * MODEL_ENTRY_SIZE;
  return {
    tokenOffset: table.view.getUint32(off + 0, true),
    tokenCount:  table.view.getUint32(off + 4, true),
    weight:      table.view.getUint32(off + 8, true),
  };
}

// Pre-resolve typeNames against a dict. Returns:
//   nameToTypeIndex[i] = dict's typeIndex for typeNames[i], or -1 if missing
//   nameHasBits[i]     = true if typeName[i] resolves AND has wordCount > 1
function buildNameResolution(table, dict) {
  const T = table.header.typeNameCount;
  const nameToTypeIndex = new Int32Array(T);
  const nameHasBits = new Uint8Array(T);
  for (let i = 0; i < T; i++) {
    const name = readTypeName(table, i);
    const rec = lookupTypeByName(dict, name);
    if (rec) {
      nameToTypeIndex[i] = rec.typeIndex;
      if (rec.wordCount > 1) nameHasBits[i] = 1;
    } else {
      nameToTypeIndex[i] = -1;
    }
  }
  return { nameToTypeIndex, nameHasBits };
}

// "Clean" model: every type token resolves AND at least one slot has
// wordCount > 1.
function modelIsClean(table, modelIdx, nameToTypeIndex, nameHasBits) {
  const m = readModelEntry(table, modelIdx);
  let hasBits = false;
  for (let k = 0; k < m.tokenCount; k++) {
    const tok = table.view.getUint32(m.tokenOffset + k * 4, true);
    if (tok & TOKEN_PUNCT_FLAG) continue;
    const idx = tok & TOKEN_INDEX_MASK;
    if (nameToTypeIndex[idx] < 0) return false;
    if (nameHasBits[idx]) hasBits = true;
  }
  return hasBits;
}

// "Skip-mode usable": at least one type token resolves AND has wordCount > 1.
function modelHasAnyBitsAvailable(table, modelIdx, nameToTypeIndex, nameHasBits) {
  const m = readModelEntry(table, modelIdx);
  for (let k = 0; k < m.tokenCount; k++) {
    const tok = table.view.getUint32(m.tokenOffset + k * 4, true);
    if (tok & TOKEN_PUNCT_FLAG) continue;
    const idx = tok & TOKEN_INDEX_MASK;
    if (nameToTypeIndex[idx] < 0) continue;
    if (nameHasBits[idx]) return true;
  }
  return false;
}

// Decode one model's tokens to the structured {kind, ...} form the
// engine expects. Resolves typeName indices to the dict's typeIndex
// using the precomputed map; resolves puncts via the SAB punct table.
// Allocates one array per call.
function expandModel(table, modelIdx, nameToTypeIndex) {
  const m = readModelEntry(table, modelIdx);
  // Pre-decode puncts on first sight; small fixed-size cache per
  // expander invocation is fine because a session uses a few unique
  // puncts. We re-read each call; cache lives at stream level instead.
  const out = new Array(m.tokenCount);
  for (let k = 0; k < m.tokenCount; k++) {
    const tok = table.view.getUint32(m.tokenOffset + k * 4, true);
    if (tok & TOKEN_PUNCT_FLAG) {
      const punctIdx = tok & TOKEN_INDEX_MASK;
      out[k] = { kind: 'punct', value: readPunct(table, punctIdx) };
    } else {
      const nameIdx = tok & TOKEN_INDEX_MASK;
      const typeIndex = nameToTypeIndex[nameIdx];
      // typeIndex may be -1 (missing in dict). Encoder's resolveType
      // path checks `item.typeIndex !== undefined && item.typeIndex !== null`,
      // so -1 must be normalized to null/undefined here. resolveType
      // also accepts a `name` field as fallback for type lookup, but
      // since we already know the name didn't resolve, sending a -1
      // typeIndex would throw. Send name and let resolveType return
      // null (skip-mode).
      if (typeIndex < 0) {
        out[k] = { kind: 'type', name: readTypeName(table, nameIdx) };
      } else {
        out[k] = { kind: 'type', typeIndex };
      }
    }
  }
  return out;
}

export function modelTableStream(table, opts = {}) {
  const { random = Math.random, mode = 'random', dict = null } = opts;
  if (!table || typeof table !== 'object' || !table.sab) {
    throw new Error(
      'modelTableStream: table must be a loaded model-table object ' +
      '(call loadModelTable(json) first)'
    );
  }
  if (table.header.modelCount === 0) {
    throw new Error('modelTableStream: empty model table');
  }
  if (!dict) {
    throw new Error('modelTableStream: dict is required (resolves typeNames → typeIndex per-dict)');
  }

  const { nameToTypeIndex, nameHasBits } = buildNameResolution(table, dict);

  // Pool is EVERY model (including statics that consume zero bits at
  // encode time). Statics carry natural-language variety in cover,
  // dropping them on the floor was the prior behavior and hurt
  // believability. The encoder's normal next() pulls weighted-random
  // from this full pool. If the encoder hits its "too many models in
  // a row consumed zero bits" guard, it calls next({ forceDynamic:
  // true }) for ONE pick from the dynamic-only subpool to break the
  // streak. Decoder never sees the model, so this is purely an
  // encoder-side fairness/availability lever.
  //
  // Pre-flight: if no model is dynamic for this dict, encoding is
  // genuinely impossible, throw with the same message shape.
  const M = table.header.modelCount;
  const dynamicIndices = [];
  for (let i = 0; i < M; i++) {
    if (modelHasAnyBitsAvailable(table, i, nameToTypeIndex, nameHasBits)) {
      dynamicIndices.push(i);
    }
  }
  if (dynamicIndices.length === 0) {
    throw new Error(
      'modelTableStream: no models in this table contain any bit-bearing type slots ' +
      'with the given dictionary, encoding is impossible (model table and dictionary mismatch ' +
      'or dictionary has too few multi-word types).'
    );
  }
  const fullPool = [];
  for (let i = 0; i < M; i++) fullPool.push(i);

  if (mode === 'sequential') return sequentialStream(table, fullPool, dynamicIndices, nameToTypeIndex);
  return randomStream(table, fullPool, dynamicIndices, nameToTypeIndex, random);
}

// True iff every type name referenced anywhere in the table exists in
// the dict. Used by the UI for compatibility checks.
// Public: does this table have at least one model the encoder could
// make progress on with the given dict? Mirrors modelTableStream's
// pool-construction (clean models first, then skip-mode-usable).
// Returns true iff modelTableStream would NOT throw the "no bit-
// bearing slots" error. Use at build time to fail fast with a
// corpus-specific message instead of letting the failure surface at
// conceal time.
export function tableHasUsableModels(table, dict) {
  if (!table || !table.sab || !dict) return false;
  if (table.header.modelCount === 0) return false;
  const { nameToTypeIndex, nameHasBits } = buildNameResolution(table, dict);
  const M = table.header.modelCount;
  for (let i = 0; i < M; i++) {
    if (modelIsClean(table, i, nameToTypeIndex, nameHasBits)) return true;
  }
  for (let i = 0; i < M; i++) {
    if (modelHasAnyBitsAvailable(table, i, nameToTypeIndex, nameHasBits)) return true;
  }
  return false;
}

// Yielding companion to tableHasUsableModels. Same short-circuit
// semantics: returns true the moment any clean (or, failing that,
// any skip-mode-usable) model is found; returns false only after
// scanning every model. Yields to the event loop every yieldEvery
// model-checks so the build-progress modal stays responsive on big
// corpora (Shakespeare's 39K+ unique MMs).
//
// onProgress events:
//   { phase: 'usable-clean', i, total }   during the clean-model scan
//   { phase: 'usable-skip',  i, total }   during the skip-model scan
//   { phase: 'usable-end',   total, ok }  at completion
//
// opts.yieldEvery  models per yield (default 1,000)
// opts.signal      optional AbortSignal
export async function tableHasUsableModelsAsync(table, dict, opts = {}) {
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 1_000;
  const signal = opts.signal ?? null;
  if (!table || !table.sab || !dict) {
    if (onProgress) onProgress({ phase: 'usable-end', total: 0, ok: false });
    return false;
  }
  if (table.header.modelCount === 0) {
    if (onProgress) onProgress({ phase: 'usable-end', total: 0, ok: false });
    return false;
  }
  const { nameToTypeIndex, nameHasBits } = buildNameResolution(table, dict);
  const M = table.header.modelCount;
  for (let i = 0; i < M; i++) {
    if (modelIsClean(table, i, nameToTypeIndex, nameHasBits)) {
      if (onProgress) onProgress({ phase: 'usable-end', total: M, ok: true });
      return true;
    }
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (onProgress) onProgress({ phase: 'usable-clean', i: i + 1, total: M });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  for (let i = 0; i < M; i++) {
    if (modelHasAnyBitsAvailable(table, i, nameToTypeIndex, nameHasBits)) {
      if (onProgress) onProgress({ phase: 'usable-end', total: M, ok: true });
      return true;
    }
    if (((i + 1) % yieldEvery) === 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (onProgress) onProgress({ phase: 'usable-skip', i: i + 1, total: M });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress({ phase: 'usable-end', total: M, ok: false });
  return false;
}

export function tableIsCompatibleWithDict(table, dict) {
  if (!table || !table.sab) return false;
  const T = table.header.typeNameCount;
  for (let i = 0; i < T; i++) {
    const name = readTypeName(table, i);
    if (lookupTypeByName(dict, name) === null) return false;
  }
  return true;
}

// Pre-compute weighted-random sampler for a given index list. Returns
// { pick(random) }, pick(rng) calls rng() once and returns an index
// from `pool`, weighted by each entry's model weight.
function buildSampler(table, pool) {
  let total = 0;
  const weights = new Float64Array(pool.length);
  for (let k = 0; k < pool.length; k++) {
    const m = readModelEntry(table, pool[k]);
    weights[k] = m.weight;
    total += m.weight;
  }
  return {
    pick(random) {
      const r = random() * total;
      let acc = 0;
      for (let k = 0; k < pool.length; k++) {
        acc += weights[k];
        if (r < acc) return pool[k];
      }
      return pool[pool.length - 1];
    },
  };
}

function randomStream(table, fullPool, dynamicPool, nameToTypeIndex, random) {
  const fullSampler = buildSampler(table, fullPool);
  const dynamicSampler = buildSampler(table, dynamicPool);
  return {
    // next(): normal weighted-random over the full pool (statics
    // included, providing natural cover variety).
    // next({ forceDynamic: true }): weighted-random over the
    // dynamic-only subpool. Encoder calls this to break a no-
    // progress streak.
    next(opts = {}) {
      const sampler = opts.forceDynamic ? dynamicSampler : fullSampler;
      return expandModel(table, sampler.pick(random), nameToTypeIndex);
    },
  };
}

function sequentialStream(table, fullPool, dynamicPool, nameToTypeIndex) {
  // Build a flat sequence of model indices, each repeated `weight`
  // times. Same shape as the pre-SAB sequential mode.
  function flatten(pool) {
    const seq = [];
    for (const idx of pool) {
      const m = readModelEntry(table, idx);
      const repeats = m.weight;
      for (let r = 0; r < repeats; r++) seq.push(idx);
    }
    return seq;
  }
  const fullSeq = flatten(fullPool);
  // O(1) "is this model bit-bearing?" lookup. dynamicPool is the
  // bit-bearing subset of fullPool; wrap it in a Set so the
  // force-dynamic branch can advance fullPos past static entries
  // without a linear scan.
  const dynamicSet = new Set(dynamicPool);
  let fullPos = 0;
  return {
    next(opts = {}) {
      if (opts.forceDynamic) {
        // Advance through the SAME fullSeq cursor until we land on
        // a bit-bearing model. This keeps the sequential walk
        // monotonic: every emitted cover sentence corresponds to a
        // strictly-increasing fullPos. The old dynPos sidetrack
        // produced non-monotonic walks (force-dynamic detours
        // visited bit-bearing entries from a separate cursor,
        // then normal picks resumed from wherever fullPos was),
        // which made downstream cover-order analysis (e.g., Eve's
        // sequential lock-step) impossible. See
        // docs/eve-plan.md for the cover-analysis context.
        //
        // Worst-case scan length is fullSeq.length (would wrap once
        // and visit every entry). In practice dynamicPool is
        // non-empty for any card that encodes, so the loop
        // terminates quickly.
        let scanned = 0;
        while (!dynamicSet.has(fullSeq[fullPos % fullSeq.length])) {
          fullPos++;
          if (++scanned > fullSeq.length) {
            throw new Error('sequentialStream: no bit-bearing model in fullSeq (dynamicPool empty?)');
          }
        }
      }
      const idx = fullSeq[fullPos % fullSeq.length];
      fullPos++;
      return expandModel(table, idx, nameToTypeIndex);
    },
  };
}
