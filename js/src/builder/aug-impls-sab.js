// aug-impls-sab.js: SAB-native implementations of the four augs.
//
// Each aug:
//   in:  inputView (entries-SAB), running bag at start of iteration
//   out: outputView (entries-SAB), only this aug's contributions
//
// Internal dedup uses a per-aug SAB dedup table sized for expected
// output. Lifts the JS Map/Set 2^24 cap that the JS-object versions
// hit on master + wide-phrase configurations.
//
// See docs/research-notes.md §18.4. Browser-safe ESM, no fs/dom.

import {
  createEntriesSAB,
  appendEntry,
  entryAt,
  entryCount,
  entrySpansAt,
  iterEntries,
  packEntries,
  unpackEntries,
  createDedupTable,
  dedupAdd,
  dedupHasJSKey,
  dedupSlotCountFor,
} from './entries-sab.js';

const EMOJI_TEST_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const TEXT_ENCODER = new TextEncoder();

function looksLikeEmoji(v) {
  return EMOJI_TEST_RE.test(v);
}

function resolveKeywords(emoji, cldr, curated) {
  const raw = cldr[emoji] || [];
  return curated ? raw.filter(k => curated.has(k)) : raw;
}

// Build the type/word/emoji-home indexes from a list of packed input
// views. Decodes UTF-8 once per entry; returns JS Maps. The number of
// UNIQUE types/words in master is well below the JS Map 2^24 cap
// (master has ~5000 types and ~150k unique words), so JS Maps are
// fine here. What we ARE replacing with SAB is the per-emit dedup,
// which is where the cap actually hits.
//
// Each call accepts an array of views (the aug's input layer), so a
// single aug pass can union entries across multiple SABs (e.g. the
// fixed-point orchestrator passes the prior-iter contributions of all
// other augs as separate SABs). Logic is identical to the single-view
// version; outer loop iterates the view list.
function buildIndexesFromPacked(views) {
  const typeWords = new Map();
  const wordTypes = new Map();
  const emojiHomeTypes = new Map();
  for (const view of views) {
    const n = entryCount(view);
    for (let i = 0; i < n; i++) {
      const e = entryAt(view, i);
      if (!typeWords.has(e.type)) typeWords.set(e.type, new Set());
      typeWords.get(e.type).add(e.word);
      if (!wordTypes.has(e.word)) wordTypes.set(e.word, new Set());
      wordTypes.get(e.word).add(e.type);
      if (looksLikeEmoji(e.word)) {
        if (!emojiHomeTypes.has(e.word)) emojiHomeTypes.set(e.word, new Set());
        emojiHomeTypes.get(e.word).add(e.type);
      }
    }
  }
  return { typeWords, wordTypes, emojiHomeTypes };
}

// Scratch buffer used by the inline (type, word) dedup-key check.
// Avoids allocating per-emit Uint8Arrays. Re-grown if too small.
let scratchBuf = new Uint8Array(256);
function scratchBufFor(typeBytes, wordBytes) {
  const need = typeBytes.length + wordBytes.length;
  if (scratchBuf.length < need) scratchBuf = new Uint8Array(need * 2);
  scratchBuf.set(typeBytes, 0);
  scratchBuf.set(wordBytes, typeBytes.length);
  return scratchBuf;
}

// Growable output: starts with an initial SAB sized to an estimate,
// doubles capacity (entries + pool) when an append would overflow,
// rebuilds the dedup table at the new size. Amortized O(N) since
// capacity doubles each grow.
//
// The dedup table stores entry indices, which stay valid across a
// SAB swap because grow copies entries in original order. The hash
// is computed from key bytes and matched against the entry's stored
// bytes via the new view; offsets differ between SABs but logical
// content matches. So a swap-and-rebuild keeps semantics intact.
function makeGrowableOutput(estEntries, estPoolBytes, opts = {}) {
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const tickEvery = Math.max(1, opts.tickEvery | 0 || 200);
  let entryCap = Math.max(64, Math.ceil(estEntries * 1.25));
  let poolCap = Math.max(1024, Math.ceil(estPoolBytes * 1.25));
  let view = createEntriesSAB(entryCap, poolCap);
  let table = createDedupTable(dedupSlotCountFor(entryCap));
  let emittedCount = 0;
  let nextTick = tickEvery;

  function grow() {
    entryCap *= 2;
    poolCap *= 2;
    const newView = createEntriesSAB(entryCap, poolCap);
    const newTable = createDedupTable(dedupSlotCountFor(entryCap));
    const n = entryCount(view);
    for (let i = 0; i < n; i++) {
      const e = entryAt(view, i);
      const ok = appendEntry(newView, e.type, e.word);
      if (!ok) throw new Error('grow: post-doubling appendEntry failed (sizing bug)');
      dedupAdd(newTable, newView, i);
    }
    view = newView;
    table = newTable;
  }

  function emit(type, word) {
    const typeBytes = TEXT_ENCODER.encode(type);
    const wordBytes = TEXT_ENCODER.encode(word);
    const buf = scratchBufFor(typeBytes, wordBytes);
    const fakeView = { bytes: buf };
    if (_dedupContains(table, view, fakeView, 0, typeBytes.length, typeBytes.length, wordBytes.length)) {
      return false;
    }
    if (!appendEntry(view, type, word)) {
      grow();
      if (!appendEntry(view, type, word)) {
        throw new Error('aug-impl-sab: append still failed after grow (input larger than 2x cap)');
      }
    }
    dedupAdd(table, view, entryCount(view) - 1);
    emittedCount++;
    if (onTick && emittedCount >= nextTick) {
      onTick(emittedCount);
      nextTick = emittedCount + tickEvery;
    }
    return true;
  }

  return {
    emit,
    finalView: () => view,
  };
}

// Local re-export of the dedup primitive with a stable signature for
// tryEmit (avoids the JS-string convenience wrapper).
function _dedupContains(table, entriesView, keyView, typeStart, typeLen, wordStart, wordLen) {
  // Inline polynomial hash + linear probe, mirroring dedupHas in
  // entries-sab.js. Keeping it inlined here avoids the function-call
  // cost in a tight emit loop.
  let h = 0x811c9dc5;
  const tEnd = typeStart + typeLen;
  for (let i = typeStart; i < tEnd; i++) {
    h ^= keyView.bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= 0xFF;
  h = Math.imul(h, 0x01000193);
  const wEnd = wordStart + wordLen;
  for (let i = wordStart; i < wEnd; i++) {
    h ^= keyView.bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;
  let slot = h & table.mask;
  for (let probes = 0; probes < table.slotCount; probes++) {
    const idx = table.slots[slot];
    if (idx === 0xFFFFFFFF) return false;
    const span = entrySpansAt(entriesView, idx);
    if (
      span.typeLen === typeLen && span.wordLen === wordLen &&
      _bytesEqual(keyView.bytes, typeStart, entriesView.bytes, span.typeStart, typeLen) &&
      _bytesEqual(keyView.bytes, wordStart, entriesView.bytes, span.wordStart, wordLen)
    ) {
      return true;
    }
    slot = (slot + 1) & table.mask;
  }
  return false;
}
function _bytesEqual(a, aStart, b, bStart, len) {
  for (let i = 0; i < len; i++) if (a[aStart + i] !== b[bStart + i]) return false;
  return true;
}

// ---------- Mix-phrase helper ----------
//
// Folded into A and B per the redesigned phrase-and-charset spec §C.
// `mix` is an integer 0..MIX_MAX; meaning per (emoji, keyword, T):
//
//   atom         (T, E)            ← emitted unconditionally by A/B
//   mix=1        (T, "k E")
//   mix=N (N≥2)  (T, "k E"), (T, "k EE"), ..., (T, "k E×N")
//                (T, "EE"),  (T, "EEE"),  ..., (T, "E×N")
//
// Bare-1 isn't emitted because it duplicates the atom. Each level n in
// 1..N adds the word-phrase "k E×n"; each level n in 2..N additionally
// adds the bare "E×n". Total mix-attributable emits per tuple = 2N − 1.
// Symmetric on B (swap T → T_E).
//
// The cap (MIX_MAX) is engine-side guard against silly inputs from
// hand-edited byos.json; the schema also rejects above MIX_MAX.
export const MIX_MAX = 10;

function emitMixVariants(out, T, k, emoji, mix) {
  if (mix <= 0) return;
  let repeated = '';
  for (let n = 1; n <= mix; n++) {
    repeated += emoji;
    out.emit(T, `${k} ${repeated}`);
    if (n >= 2) out.emit(T, repeated);
  }
}

// ---------- Aug A: emoji into existing word types ----------

export function emojiIntoWordsContributionPacked(inputViews, opts = {}) {
  const cldr = opts.cldr;
  if (!cldr) return createEntriesSAB(0, 0);
  const mix = clampMix(opts.mix);
  const curated = opts.curatedKeywords instanceof Set ? opts.curatedKeywords : null;
  const { wordTypes, emojiHomeTypes } = buildIndexesFromPacked(inputViews);
  if (opts.diagnose) {
    reportDiagnose('eiw', mix, emojiHomeTypes, wordTypes, cldr, curated, opts.onDiagnose);
  }
  // Per-tuple emit budget: 1 atom + 2N − 1 mix variants ≈ 2N. Estimate
  // tuples conservatively from the home-emoji count × small fanout.
  const perTuple = Math.max(1, 2 * mix);
  const estEntries = Math.max(64, emojiHomeTypes.size * 5 * perTuple);
  const estPool = estEntries * 32;
  const out = makeGrowableOutput(estEntries, estPool, { onTick: opts.onTick });
  for (const [emoji, homeTypes] of emojiHomeTypes) {
    const keywords = resolveKeywords(emoji, cldr, curated);
    if (keywords.length === 0) continue;
    for (const k of keywords) {
      const targetTypes = wordTypes.get(k);
      if (!targetTypes) continue;
      for (const T of targetTypes) {
        if (homeTypes.has(T)) continue;
        out.emit(T, emoji);
        emitMixVariants(out, T, k, emoji, mix);
      }
    }
  }
  return out.finalView();
}

// ---------- Aug B: words into emoji types ----------

export function wordsIntoEmojiContributionPacked(inputViews, opts = {}) {
  const cldr = opts.cldr;
  if (!cldr) return createEntriesSAB(0, 0);
  const mix = clampMix(opts.mix);
  const curated = opts.curatedKeywords instanceof Set ? opts.curatedKeywords : null;
  const { wordTypes, emojiHomeTypes } = buildIndexesFromPacked(inputViews);
  if (opts.diagnose) {
    reportDiagnose('wie', mix, emojiHomeTypes, wordTypes, cldr, curated, opts.onDiagnose);
  }
  const perTuple = Math.max(1, 2 * mix);
  const estEntries = Math.max(64, emojiHomeTypes.size * 5 * perTuple);
  const estPool = estEntries * 32;
  const out = makeGrowableOutput(estEntries, estPool, { onTick: opts.onTick });
  for (const [emoji, homeTypes] of emojiHomeTypes) {
    const keywords = resolveKeywords(emoji, cldr, curated);
    if (keywords.length === 0) continue;
    for (const k of keywords) {
      if (!wordTypes.has(k)) continue;
      for (const T_E of homeTypes) {
        out.emit(T_E, k);
        emitMixVariants(out, T_E, k, emoji, mix);
      }
    }
  }
  return out.finalView();
}

// ---------- Diagnose: pre-emit fanout walk ----------
//
// Pure tally over the same (E, k, T) iteration the emit loop will do.
// No emits, no SAB allocation. For eiw, T comes from wordTypes(k) minus
// homeTypes(E); for wie, T comes from homeTypes(E). Reports the planned
// scale so we can see where a flood-config build is going to land
// before the SAB grow loop tries to allocate.
//
// Stats (per aug):
//   emojiCount       : |emojiHomeTypes|
//   keywordsPerEmoji : distribution of |resolveKeywords(E)|
//   typesPerEKpair   : distribution of |targetTypes(E, k)| (post home-type filter for eiw)
//   ETpairs          : count of distinct (E, T) pairs across the iteration
//   tuples           : count of (E, k, T) triples
//   topEKbyTypes     : top 10 (E, k) by typesPerEKpair, with the keyword
//   topKbyEKfanout   : top 10 keywords k by sum-of-target-types across all E using k
//   plannedRawEmits  : 2N × tuples (with N = mix), or 1 × tuples when N=0
//   plannedUniqueEntries: N × ETpairs + N × tuples (N≥1), or ETpairs (N=0)
//   poolBytesEstimate: plannedUniqueEntries × 32 (rough)
function reportDiagnose(aug, mix, emojiHomeTypes, wordTypes, cldr, curated, onDiagnose) {
  const stats = gatherFanout(aug, mix, emojiHomeTypes, wordTypes, cldr, curated);
  if (typeof onDiagnose === 'function') {
    onDiagnose({ aug, stats });
    return;
  }
  // Default sink: stderr (Node) or console.error (browser).
  // eslint-disable-next-line no-console
  console.error(formatDiagnose(aug, mix, stats));
}

function gatherFanout(aug, mix, emojiHomeTypes, wordTypes, cldr, curated) {
  const keywordsPerEmoji = [];
  const typesPerEKpair = [];
  const etPairSet = new Set();
  const ekRows = []; // {emoji, keyword, typeCount}
  const kFanout = new Map(); // keyword -> sum of typeCount across E
  let tuples = 0;

  for (const [emoji, homeTypes] of emojiHomeTypes) {
    const keywords = resolveKeywords(emoji, cldr, curated);
    keywordsPerEmoji.push(keywords.length);
    for (const k of keywords) {
      let targetTypes;
      if (aug === 'eiw') {
        const types = wordTypes.get(k);
        if (!types) { typesPerEKpair.push(0); continue; }
        targetTypes = types;
      } else { // wie
        if (!wordTypes.has(k)) { typesPerEKpair.push(0); continue; }
        targetTypes = homeTypes;
      }
      let count = 0;
      for (const T of targetTypes) {
        if (aug === 'eiw' && homeTypes.has(T)) continue;
        count++;
        etPairSet.add(emoji + '\x00' + T);
      }
      typesPerEKpair.push(count);
      tuples += count;
      if (count > 0) {
        ekRows.push({ emoji, keyword: k, typeCount: count });
        kFanout.set(k, (kFanout.get(k) || 0) + count);
      }
    }
  }

  ekRows.sort((a, b) => b.typeCount - a.typeCount);
  const topEK = ekRows.slice(0, 10);
  const topK = [...kFanout.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const N = mix;
  const ETpairs = etPairSet.size;
  const plannedRawEmits = N === 0 ? tuples : 2 * N * tuples;
  const plannedUniqueEntries = N === 0 ? ETpairs : N * ETpairs + N * tuples;

  return {
    emojiCount: emojiHomeTypes.size,
    keywordsPerEmoji: percentiles(keywordsPerEmoji),
    typesPerEKpair: percentiles(typesPerEKpair),
    ETpairs,
    tuples,
    topEKbyTypes: topEK,
    topKbyEKfanout: topK,
    mix: N,
    plannedRawEmits,
    plannedUniqueEntries,
    poolBytesEstimate: plannedUniqueEntries * 32,
  };
}

function percentiles(arr) {
  if (arr.length === 0) return { n: 0, mean: 0, p50: 0, p90: 0, p99: 0, max: 0, sum: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    sum,
    mean: sum / sorted.length,
    p50: at(0.50),
    p90: at(0.90),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

function formatDiagnose(aug, mix, s) {
  const lines = [];
  lines.push(`[${aug}-diagnose mix=${mix}]`);
  lines.push(`  emojis with home types: ${s.emojiCount}`);
  lines.push(
    `  keywords/emoji: n=${s.keywordsPerEmoji.n} sum=${s.keywordsPerEmoji.sum} ` +
    `mean=${s.keywordsPerEmoji.mean.toFixed(1)} p50=${s.keywordsPerEmoji.p50} ` +
    `p90=${s.keywordsPerEmoji.p90} p99=${s.keywordsPerEmoji.p99} max=${s.keywordsPerEmoji.max}`,
  );
  lines.push(
    `  target-types/(E,k): n=${s.typesPerEKpair.n} sum=${s.typesPerEKpair.sum} ` +
    `mean=${s.typesPerEKpair.mean.toFixed(1)} p50=${s.typesPerEKpair.p50} ` +
    `p90=${s.typesPerEKpair.p90} p99=${s.typesPerEKpair.p99} max=${s.typesPerEKpair.max}`,
  );
  lines.push(`  distinct (E,T) pairs: ${s.ETpairs.toLocaleString()}`);
  lines.push(`  (E,k,T) tuples:        ${s.tuples.toLocaleString()}`);
  lines.push(`  planned raw emits:     ${s.plannedRawEmits.toLocaleString()}`);
  lines.push(`  planned unique entries: ${s.plannedUniqueEntries.toLocaleString()}`);
  lines.push(`  pool bytes estimate:   ${(s.poolBytesEstimate / 1e6).toFixed(0)} MB`);
  if (s.topKbyEKfanout.length) {
    lines.push(`  top 10 keywords by total target-type fanout:`);
    for (const [k, v] of s.topKbyEKfanout) {
      lines.push(`    ${k.padEnd(20)} ${v.toLocaleString()}`);
    }
  }
  if (s.topEKbyTypes.length) {
    lines.push(`  top 10 (emoji, keyword) pairs by target-type count:`);
    for (const r of s.topEKbyTypes) {
      lines.push(`    ${r.emoji}  ${r.keyword.padEnd(20)} ${r.typeCount.toLocaleString()}`);
    }
  }
  return lines.join('\n');
}

function clampMix(raw) {
  const n = (raw | 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > MIX_MAX ? MIX_MAX : n;
}

// Vowel aug retired with the cover-transforms arc. a/an agreement is
// now handled by the xanax rewriter (js/src/rewriter/xanax.js) which
// mutates the encoder's phraseBuf per-emission with strict-ortho
// lookahead, rather than tagging every leading-vowel-or-h dict word
// with a 'begins_with_a_vowel' type at build time.

// ---------- JS-object adapters (back-compat for orchestrator/tests) ----------
//
// Pack the JS-array input into entries-SAB, run the packed aug, unpack
// the contribution-only output back to JS objects. Used by the
// existing aug-pipeline.js orchestrator and any test that wants the
// pre-SAB shape. Phase 3 will move the orchestrator off these.

export function emojiIntoWordsContributionFromArray(entries, opts) {
  const inputView = packEntries(entries);
  const out = emojiIntoWordsContributionPacked([inputView], opts);
  return unpackEntries(out);
}
export function wordsIntoEmojiContributionFromArray(entries, opts) {
  const inputView = packEntries(entries);
  const out = wordsIntoEmojiContributionPacked([inputView], opts);
  return unpackEntries(out);
}
