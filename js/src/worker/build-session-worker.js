// On-demand session builder worker. Receives one `build-session`
// message from the parent and walks the build pipeline.
//
// Sections:
//   1. Common prefix (both useCorpus modes): load each selected twlist
//      via loadResource(key, 'twlist', { fixture: true }), unpack and
//      concat into `combined`. Apply emoji / vowel augs. Append voice
//      reformatter singletons + rewriter singletons. Load external
//      freq fixtures. Build freqMap (style + external sources).
//   2. Non-flat path: tokenize the corpus, restrictToVocab + voice
//      re-append → sortDict → corpusMtw → buildDictionary →
//      corpusDict → generateModelTable → modelJson. The corpus dict's
//      merged-type set IS the set of merged types the model can emit,
//      so it doubles as the type-filter source for the useCorpus=false
//      branch below.
//   3. useCorpus=true branch: run tableHasUsableModelsAsync against
//      the corpus dict (throws on no-bit corpora). Post 'corpus' (the
//      active dict) + 'model'. No base dict is built on this path.
//   4. useCorpus=false branch: extract typeSet from corpusMtw,
//      sortDict the full combined union, filter rows by typeSet, build
//      the base dict from the filtered MTW. Run the deferred
//      tableHasUsableModelsAsync against the wider base dict. Post
//      'base' (the active dict) + 'model'. corpusSab from §2 stays as
//      internal scaffolding, never posted.
//   Random card (storyStyle === 'flat') is the lone exception: no
//   corpus, no model, no type filter, sortDict the full combined
//   union and post 'base'.
//
// Each posted SAB arrives at the parent as `{type:'sab', kind, sab}`.
// Final `{type:'done'}` signals success. Errors surface as
// `{type:'error', error}`.
//
// Browser-only worker. Fetches fixtures via origin-relative URLs.

import { parentPort } from './parent-port.js';
import { loadResource } from '../resource-loader-client.js';
import {
  getRedactedSingles, redactTwlistEntries,
} from '../builder/redaction.js';
import { restrictToVocabAsync } from '../builder/sources.js';
import { unpackEntriesAsync, wrapEntriesSAB } from '../builder/entries-sab.js';
import { wrapPackedStrings } from '../eve/packed-strings-sab.js';
import { unpackFreqFromSAB } from '../builder/freq-pack.js';
import { unpackCldrMapFromSAB } from '../builder/cldr-map-pack.js';
import { runAugsPacked } from '../builder/aug-pipeline.js';
import { sortDictAsync } from '../builder/sortdct.js';
import { buildDictionaryAsync } from '../builder/dct2mstr.js';
import { listWordsWithCounts } from '../builder/listword.js';
import {
  combineFrequencies,
  wordCountsToFreqSource,
} from '../builder/frequencies.js';
import { generateModelTableAsync } from '../builder/genmodel.js';

// Cover-transforms rewriter chain (docs/cover-transforms.md). Every
// rewriter ships a unique-twlist SAB at
// fixtures/rewriter-<name>.twlist.sab.gz; sortdct loads it through the
// standard twlist resource path when byos.rewriter.<name> > 0.
// The worker doesn't import the rewriter modules, apply() is called
// from the encoder (js/src/encode.js), not here.
//
// REWRITER_CHAIN is the canonical name list in the documented per-
// emission run order. SHIPPED_REWRITERS gates which names have a
// fixture on disk; enabling an unshipped rewriter throws loudly at
// load time. As each stub arc ships its data, add the name here.
const REWRITER_CHAIN = ['british', 'typos', 'voice', 'xanax'];
const SHIPPED_REWRITERS = new Set(['xanax', 'typos', 'british', 'voice']);
import { packDictToSABAsync } from '../builder/sab-pack.js';
import { packModelTableToSABAsync } from '../builder/modeltable-pack.js';
import { wrapModelTableFromSAB, tableHasUsableModelsAsync } from '../modeltable.js';
import { wrapDictionaryFromSAB } from '../dictionary.js';

const FIXTURE_DIR = new URL('../../../fixtures/', import.meta.url);

// Recognized base-dict twlist source keys. Used only as a presence
// check (unknown keys throw); the runtime path goes through
// loadResource(key, 'twlist', { fixture: true }), which composes
// /fixtures/<key>.twlist.sab.gz via the shared loader. No filename
// table needed.
//
// One of FOUR hardcoded lists that must stay in sync when adding a
// new twlist source:
//   1. js/src/byos.js               SOURCE_NAMES          (byos schema validation)
//   2. js/src/share.js              SOURCE_LABELS         (share-URL labels)
//   3. js/app.js                    ADV_SOURCE_KEYS       (Pro tab picker render allowlist)
//   4. js/src/worker/build-session-worker.js  KNOWN_TWLIST_KEYS  (this file, runtime accept check)
const KNOWN_TWLIST_KEYS = new Set([
  'impf2p',
  'impkimmo',
  // KIMMO2026 family, see SOURCE_NAMES in js/src/byos.js.
  'impkimmo2026',
  'impkimmo2026-cform',
  'impkimmo2026-root',
  'impkimmo2026-rootpos',
  'impkimmo2026-drvstem',
  'mit',
  'num-form-preserved',
  'num-form-interchangeable',
  'num-roman',
  // Poetry/Song twlists. CMU-derived siblings to rhyme.
  'rhyme',
  'cmu-syllable',
  'cmu-stress',
  'cmu-alliteration',
  'claude2026',
  'connectors',
  'moby-pos',
  'moby-thesaurus',
  'wordnet',
  'wordnet-synonyms',
  'proglang-keywords',
  'emoji16',
  'emoji-cldr-names-16',
  'emoji-curated-phrases-16',
  // emoji16-curated-keywords is loaded separately (it's a filter
  // list for Aug A/B/mix, not a TW-list whose entries fold into
  // `combined`). Listed here only to flag that the worker recognizes
  // the name.
  'emoji16-curated-keywords',
]);
// Key for the curated-keyword filter (wlist form is sufficient, the
// downstream consumer only needs the word column for set membership).
const CURATED_KEYWORDS_KEY = 'emoji16-curated-keywords';

// Word-frequency fixtures (research-notes §11). Loaded only when the
// caller passes a non-empty freqSelections array; ignored when
// useCorpus is on (the corpus is the authority for word weights and
// the freq picker is hidden in the UI). Each key maps to a runtime
// SAB at /fixtures/<key>.freq.sab.gz (NTFQ format); load is via
// loadResource(key, 'freq', { fixture: true }) below.
const KNOWN_FREQ_KEYS = new Set(['norvig', 'google', 'gutenberg']);
const FREQ_LABELS = {
  norvig:    'Norvig (web)',
  google:    'Google Books',
  gutenberg: 'Project Gutenberg',
};

// All fixture loads route through the shared resource-loader on the
// main thread: this worker emits `loadRequest` messages via
// loadResource(), main resolves them through the resource-worker
// pool (which fetches + gunzips), and the result comes back as a
// SAB. The typed fixtures (dict / model / wlist / twlist / freq /
// emoji-cldr) go through their resourceCategory-specific unpack
// path. fetchText is the residual raw-bytes path for the corpus
// text body (which has no SAB resource category, it ships as the
// raw .txt.gz; the consumer needs the bytes themselves, not a
// pre-packed structure).
async function fetchText(url, rowId) {
  const sab = await loadWithRow(
    rowId || String(url),
    String(url),
    'raw-bytes',
    { fixture: false },
  );
  // TextDecoder.decode refuses SharedArrayBuffer-backed views; copy
  // into a private ArrayBuffer first. The original SAB stays cached
  // on the main thread for the next consumer (zero-copy by design).
  const view = new Uint8Array(sab);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new TextDecoder('utf-8').decode(copy);
}

// Wrap a loadResource call with load-start / load-progress /
// load-end messages keyed by `rowId`. The parent (session.js)
// forwards these to the page's Build progress modal, which renders
// one row per active loadResource in #progress-modal-rows. Mirrors
// the pattern in js/src/eve/orchestrator.js (loadWithRow there
// emits the same shape via onEvent). Errors propagate; load-end
// fires in finally so the row always disappears.
function emitLoadProgress(phase, id, label) {
  parentPort.postMessage({ type: 'load-progress', phase, id, label });
}

// Route a sortDictAsync progress event to a per-row load-progress
// event. `rowId` is the modal row's id (e.g. 'base-sort',
// 'corpus-sort', 'aug-presort'); `humanLabel` is the noun in the
// human-readable label ('base dict', 'corpus dict', 'aug input').
// First call for a given rowId synthesizes a 'start' so the page's
// row gets created; the row stays until 'sort-end'.
const sortStartedRows = new Set();
function routeSortProgress(rowId, humanLabel, e) {
  if (!sortStartedRows.has(rowId)) {
    sortStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'sort-build':
      emitLoadProgress(
        'progress', rowId,
        `Sorting ${humanLabel}: scanning ${e.i.toLocaleString()} / ${e.total.toLocaleString()} entries`,
      );
      break;
    case 'sort-merge':
      emitLoadProgress(
        'progress', rowId,
        `Sorting ${humanLabel}: merging types ${e.i.toLocaleString()} / ${e.total.toLocaleString()} unique words`,
      );
      break;
    case 'sort-final':
      // 'sort-final' runs the unyieldable native sort. Keep the row
      // alive with a "final pass" label so the modal isn't silent
      // through the sync block; 'sort-end' removes the row.
      emitLoadProgress(
        'progress', rowId,
        `Sorting ${humanLabel}: final pass over ${e.total.toLocaleString()} entries`,
      );
      break;
    case 'sort-end':
      emitLoadProgress('end', rowId, null);
      sortStartedRows.delete(rowId);
      break;
  }
}

// Route buildDictionaryAsync progress to a per-row load-progress
// event. Same start-on-first / end-on-end pattern as routeSortProgress.
const buildDictStartedRows = new Set();
function routeBuildDictProgress(rowId, humanLabel, e) {
  if (!buildDictStartedRows.has(rowId)) {
    buildDictStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'builddict-progress':
      emitLoadProgress(
        'progress', rowId,
        `Building Huffman codes for ${humanLabel}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()} words`,
      );
      break;
    case 'builddict-end':
      emitLoadProgress('end', rowId, null);
      buildDictStartedRows.delete(rowId);
      break;
  }
}

// Route packDictToSABAsync progress similarly.
const packDictStartedRows = new Set();
function routePackDictProgress(rowId, humanLabel, e) {
  if (!packDictStartedRows.has(rowId)) {
    packDictStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'packdict-intern':
      emitLoadProgress(
        'progress', rowId,
        `Packing ${humanLabel}: interning ${e.i.toLocaleString()} / ${e.total.toLocaleString()} words`,
      );
      break;
    case 'packdict-sort':
      emitLoadProgress(
        'progress', rowId,
        `Packing ${humanLabel}: sorting ${e.total.toLocaleString()} words`,
      );
      break;
    case 'packdict-write':
      emitLoadProgress(
        'progress', rowId,
        `Packing ${humanLabel}: writing ${e.i.toLocaleString()} / ${e.total.toLocaleString()} words`,
      );
      break;
    case 'mergesort-pass': {
      // packDictToSABAsync tags inner mergesort events with subphase
      // 'byword' or 'byname' so this router can pick a label.
      const what = e.subphase === 'byname' ? 'type-name index' : 'word index';
      emitLoadProgress(
        'progress', rowId,
        `Packing ${humanLabel}: sorting ${what} (${e.mergedItems.toLocaleString()} / ${e.total.toLocaleString()})`,
      );
      break;
    }
    case 'mergesort-end':
      // The mergesort completed; the surrounding packdict phase will
      // emit its own 'packdict-end' shortly. Nothing to do here, the
      // intermediate progress text is overwritten by the next event.
      break;
    case 'packdict-end':
      emitLoadProgress('end', rowId, null);
      packDictStartedRows.delete(rowId);
      break;
  }
}

// Route restrictToVocabAsync progress to a per-row load-progress
// event. Same start-on-first / end-on-end pattern as the sort/build
// dict routers.
const restrictStartedRows = new Set();
function routeRestrictProgress(rowId, humanLabel, e) {
  if (!restrictStartedRows.has(rowId)) {
    restrictStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'restrict-filter':
      emitLoadProgress(
        'progress', rowId,
        `Restricting ${humanLabel}: filtering ${e.i.toLocaleString()} / ${e.total.toLocaleString()} entries`,
      );
      break;
    case 'restrict-cover':
      emitLoadProgress(
        'progress', rowId,
        `Restricting ${humanLabel}: covering ${e.i.toLocaleString()} / ${e.total.toLocaleString()} vocab words`,
      );
      break;
    case 'restrict-end':
      emitLoadProgress('end', rowId, null);
      restrictStartedRows.delete(rowId);
      break;
  }
}

// Route tableHasUsableModelsAsync progress similarly.
const usableStartedRows = new Set();
function routeUsableProgress(rowId, humanLabel, e) {
  if (!usableStartedRows.has(rowId)) {
    usableStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'usable-clean':
      emitLoadProgress(
        'progress', rowId,
        `Checking ${humanLabel}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()} clean models scanned`,
      );
      break;
    case 'usable-skip':
      emitLoadProgress(
        'progress', rowId,
        `Checking ${humanLabel}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()} skip-mode models scanned`,
      );
      break;
    case 'usable-end':
      emitLoadProgress('end', rowId, null);
      usableStartedRows.delete(rowId);
      break;
  }
}

// Route mergesortAsync progress to a per-row load-progress event.
// Used by the dedupe-sort inside generateModelTableAsync. The
// packDictToSABAsync byWord / byTypeName mergesort events are
// surfaced through its existing per-row router (packdict-bywordsort
// and packdict-bynamesort subphase tags differentiate the two
// passes on the same dict row).
const mergesortStartedRows = new Set();
function routeMergesortProgress(rowId, humanLabel, e) {
  if (!mergesortStartedRows.has(rowId)) {
    mergesortStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'mergesort-pass':
      emitLoadProgress(
        'progress', rowId,
        `Sorting ${humanLabel}: ${e.mergedItems.toLocaleString()} / ${e.total.toLocaleString()} merged (run ${e.runSize})`,
      );
      break;
    case 'mergesort-end':
      emitLoadProgress('end', rowId, null);
      mergesortStartedRows.delete(rowId);
      break;
  }
}

// Route packModelTableToSABAsync progress similarly.
const packModelStartedRows = new Set();
function routePackModelProgress(rowId, humanLabel, e) {
  if (!packModelStartedRows.has(rowId)) {
    packModelStartedRows.add(rowId);
    emitLoadProgress('start', rowId, null);
  }
  switch (e.phase) {
    case 'packmodel-progress':
      emitLoadProgress(
        'progress', rowId,
        `Packing ${humanLabel}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()} models`,
      );
      break;
    case 'packmodel-end':
      emitLoadProgress('end', rowId, null);
      packModelStartedRows.delete(rowId);
      break;
  }
}
async function loadWithRow(rowId, idOrPath, resourceCategory, opts = {}) {
  emitLoadProgress('start', rowId, null);
  try {
    return await loadResource(idOrPath, resourceCategory, {
      ...opts,
      onProgress: (label) => emitLoadProgress('progress', rowId, label),
    });
  } finally {
    emitLoadProgress('end', rowId, null);
  }
}

function postSab(kind, sab, extra = {}) {
  const isSab = typeof SharedArrayBuffer !== 'undefined' && sab instanceof SharedArrayBuffer;
  const transferList = isSab ? [] : [sab];
  parentPort.postMessage({ type: 'sab', kind, sab, ...extra }, transferList);
}

function emitProgress(step, fraction, detail) {
  parentPort.postMessage({ type: 'progress', step, fraction, detail });
}

// Per-worker aug progress aggregator. Each runAugsPacked event mutates
// `augState`; flushes are throttled to FLUSH_MS so the main thread
// renders at a sane rate even when 200-emit ticks rain in from N
// workers in parallel. iter-start and aug-done force an immediate
// flush so the developer sees state transitions without lag.
const AUG_FLUSH_MS = 100;
function makeAugReporter() {
  let state = null;            // { iter, cap, poolSize, augKinds, workers: Map }
  let lastFlushAt = 0;
  let pendingTimer = null;
  const flush = () => {
    if (!state) return;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    const workers = [];
    for (const [workerId, w] of state.workers) {
      workers.push({ workerId, augKind: w.augKind, emitted: w.emitted, status: w.status });
    }
    workers.sort((a, b) => a.workerId - b.workerId);
    parentPort.postMessage({
      type: 'aug-progress',
      iter: state.iter, cap: state.cap,
      poolSize: state.poolSize, augKinds: state.augKinds,
      workers,
    });
    lastFlushAt = Date.now();
  };
  const schedule = () => {
    if (pendingTimer) return;
    const since = Date.now() - lastFlushAt;
    if (since >= AUG_FLUSH_MS) flush();
    else pendingTimer = setTimeout(flush, AUG_FLUSH_MS - since);
  };
  return {
    handle(e) {
      if (e.phase === 'aug-iter-start') {
        state = {
          iter: e.iter, cap: e.cap,
          poolSize: e.poolSize, augKinds: e.augKinds.slice(),
          workers: new Map(),
        };
        flush();
      } else if (e.phase === 'aug-progress' || e.phase === 'aug-done') {
        if (!state) return;
        state.workers.set(e.workerId, {
          augKind: e.augKind,
          emitted: e.emitted,
          status: e.phase === 'aug-done' ? 'done' : 'running',
        });
        if (e.phase === 'aug-done') flush();
        else schedule();
      } else if (e.phase === 'aug-iter') {
        flush();
        emitProgress('base', null,
          `Augs iter ${e.iter} complete: ${e.total.toLocaleString()} new entries`);
      }
    },
  };
}

// Format a byte count like the encode/decode bar does ("1.2 / 5.4 MB
// processed"). Uses a non-breaking space between number and unit so a
// terminal/page wrap won't split the pair.
const NB = ' ';
function formatChars(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}${NB}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}${NB}KB`;
  return `${n.toLocaleString()}${NB}chars`;
}

function dictStats(dictJson, sabByteLength) {
  const totalBits = dictJson.words.reduce((s, w) => s + w.bits, 0);
  const maxBits = dictJson.words.reduce((m, w) => Math.max(m, w.bits), 0);
  return {
    wordCount: dictJson.words.length,
    typeCount: dictJson.types.length,
    avgBits: dictJson.words.length ? totalBits / dictJson.words.length : 0,
    maxBits,
    sabBytes: sabByteLength,
  };
}

async function handleBuild(msg) {
  const {
    selections, labels, storyStyle, useCorpus, sentenceMode, corpusFile,
    customCorpusText, customCorpusName,
    customTwlistEntries, customTwlistName,
    freqSelections,
    tieBreak,
    emojiIntoWords, wordsIntoEmoji,
    // Cover-transforms rewriter block (docs/cover-transforms.md). The
    // byos universal `{enabled, intensity, mode?}` per-field shape;
    // absent / empty / every-field-disabled means every rewriter is
    // off (the default, no behavior change).
    rewriter: rewriterFlags = null,
    // Cover-transforms reformatter block. Only voice contributes
    // dict singletons today (per-mode opener/closer/aside/etc.
    // type names that the encoder resolves at insertion time); the
    // pure-code reformatters (case / lineBreak / sentenceEnd) leave
    // this empty.
    reformatter: reformatterFlags = null,
  } = msg;
  // Forward the BYOS tie-break choice to both buildDictionary call
  // sites below. Default 'alpha-asc' preserves engine-default
  // behavior; the BYOS checkbox sends 'length-desc' when on.
  const dictTieBreak = tieBreak === 'length-desc' ? 'length-desc' : 'alpha-asc';

  // ---- Section 1 prep: load the redacted singles set ----
  // The custom-twlist producer seam below applies redactTwlistEntries
  // using these singles; sortDictAsync (a twlist consumer) loads its
  // own singles internally. Same set both places; loadResource caches
  // so the SAB is fetched once per worker lifetime.
  const redactedSingles = await getRedactedSingles();

  // ---- Section 1: load twlists, run augs, append voice + rewriter
  // singletons, load freq fixtures. Shared across all branches. ----
  emitProgress('base', 0, 'Loading TW-lists...');
  let combined = [];
  // Total step count includes the optional custom TW-list and the
  // freq fixtures so the progress bar fraction stays accurate.
  const haveCustomTw = Array.isArray(customTwlistEntries) && customTwlistEntries.length > 0;
  const freqSels = Array.isArray(freqSelections) ? freqSelections : [];
  // Freq picker drives weights for the active dict in both Vocabulary
  // Scope modes. When the corpus is the active dict (useCorpus=true),
  // ticking 'style' folds the corpus's own counts into the merge,
  // unticking it drops corpus counts entirely so external sources
  // alone weight the corpus dict. To reproduce the legacy "corpus
  // counts only" behavior, tick only [Style] frequencies.
  const wantStyleFreq = storyStyle !== 'flat' && freqSels.includes('style');
  const extFreqKeys = freqSels.filter(k => k !== 'style');
  const totalSteps =
    selections.length +
    (haveCustomTw ? 1 : 0) +
    extFreqKeys.length +
    1;
  let stepIdx = 0;
  for (let i = 0; i < selections.length; i++) {
    const key = selections[i];
    if (key === 'emoji16-curated-keywords') {
      // Loaded separately below as the curated-keyword filter for Aug
      // A/B/mix; entries don't fold into `combined`. Still counts as a
      // step so the progress bar fraction stays accurate.
      stepIdx++;
      continue;
    }
    if (!KNOWN_TWLIST_KEYS.has(key)) {
      throw new Error(`unknown base-dict selection "${key}"`);
    }
    const label = (labels && labels[key]) || key;
    // Pre-fetch ping so the slow fetch for big lists (impkimmo2026
    // ~3.4M entries) doesn't sit silently behind the previous
    // "Loaded ..." message. Fraction holds at the previous step so
    // the bar doesn't jump backward.
    emitProgress('base', stepIdx / totalSteps, `Loading ${label}...`);
    // Load the canonical twlist SAB (entries-SAB / NTEN format) and
    // unpack to [{type, word}, ...]. No TSV parse, the build-time
    // packer already did that work; here the cost is one fetch +
    // gunzip + Uint32Array walk. Big-list win: impkimmo2026 family
    // drops from ~seconds of parse to ~milliseconds of walk per
    // session start.
    const sab = await loadWithRow(key, key, 'twlist', { fixture: true });
    // Unpack yields every 50K so big twlists (impkimmo2026 family,
    // ~3.4M entries) don't go silent between the load-end row and the
    // next phase. Renders as its own short-lived row in the modal.
    const unpackRowId = `unpack:${key}`;
    emitLoadProgress('start', unpackRowId, `Unpacking ${label}`);
    const entries = await unpackEntriesAsync(wrapEntriesSAB(sab), {
      onProgress: (e) => {
        if (e.phase === 'merge-progress') {
          emitLoadProgress(
            'progress', unpackRowId,
            `Unpacking ${label}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()}`,
          );
        }
      },
    });
    emitLoadProgress('end', unpackRowId, null);
    combined = combined.concat(entries);
    stepIdx++;
    emitProgress('base', stepIdx / totalSteps,
      `Loaded ${label} (${entries.length.toLocaleString()} entries)`);
  }
  if (haveCustomTw) {
    // Custom twlist producer seam: apply redactTwlistEntries (same
    // function build-twlist-fixtures.js uses for bundled sources at
    // build time). Drops slur-matching entries and prepends the
    // marker. Defense-in-depth: sortDictAsync re-applies on the full
    // union below.
    const redacted = redactTwlistEntries(customTwlistEntries, redactedSingles);
    combined = combined.concat(redacted);
    stepIdx++;
    const label = customTwlistName ? `Custom (${customTwlistName})` : 'Custom';
    emitProgress('base', stepIdx / totalSteps,
      `Loaded ${label} (${redacted.length.toLocaleString()} entries)`);
  }
  if (combined.length === 0) {
    throw new Error('no base-dictionary entries selected');
  }
  // Augmentation pass: vowel + cross-modal emoji (Aug A / Aug B)
  // routed through the §18 fixed-point orchestrator. Mixed-phrase
  // Per-aug `{enabled, intensity}` shape (see js/src/byos.js validate-
  // EmojiAugField). Intensity is the repetition depth (0..MIX_MAX) of
  // emoji-cluster phrase variants layered on top of the single-token
  // cross-modal swap. Emoji augs are gated on `emoji16` being among
  // the selected sources (no point augmenting when no emoji entries
  // exist to walk). The CLDR keyword sidecar loads lazily, only when
  // an emoji aug is selected. Cross-aug duplicates in the combined
  // output are tolerated; sortDict downstream collapses them by word.
  const augA = emojiIntoWords && emojiIntoWords.enabled === true ? emojiIntoWords : null;
  const augB = wordsIntoEmoji && wordsIntoEmoji.enabled === true ? wordsIntoEmoji : null;
  const eiwMix = augA && Number.isInteger(augA.intensity) ? Math.max(0, augA.intensity) : 0;
  const wieMix = augB && Number.isInteger(augB.intensity) ? Math.max(0, augB.intensity) : 0;
  const wantsEmojiAug = (augA || augB) && selections.includes('emoji16');
  const selectedAugs = [];
  if (wantsEmojiAug) {
    if (augA) selectedAugs.push('eiw');
    if (augB) selectedAugs.push('wie');
  }
  if (selectedAugs.length > 0) {
    let cldr = null;
    let curatedKeywords = null;
    if (wantsEmojiAug) {
      emitProgress('base', null, 'Loading emoji CLDR keywords...');
      // Load the emoji-cldr SAB (NTCM) and unpack to the same
      // {emoji: [keyword, ...]} object the JSON form produced. No
      // JSON.parse on the hot path, the parse happened once at
      // build time via `sab pack emoji-cldr`.
      const cldrSab = await loadWithRow('emoji16 (cldr)', 'emoji16', 'emoji-cldr', { fixture: true });
      cldr = unpackCldrMapFromSAB(cldrSab);
      if (selections.includes(CURATED_KEYWORDS_KEY)) {
        emitProgress('base', null, 'Loading curated-keyword filter...');
        // Only the word column is needed (filter set). Load the
        // wlist (NTPS) form rather than the twlist (NTEN) form;
        // smaller payload, no entry iteration needed.
        const sab = await loadWithRow(CURATED_KEYWORDS_KEY, CURATED_KEYWORDS_KEY, 'wlist', { fixture: true });
        curatedKeywords = new Set(wrapPackedStrings(sab).iterate());
      }
    }
    const mixDescr = (eiwMix > 0 || wieMix > 0)
      ? `, mix=eiw:${eiwMix}/wie:${wieMix}` : '';
    emitProgress('base', null, `Running augs (${selectedAugs.join(', ')}${mixDescr})...`);
    const augReporter = makeAugReporter();
    // Hashed merged types: enabled unconditionally for the session-base
    // build path. Without it, all-dicts + flood overflows sab-pack's
    // u16 string-pool prefix (word "hand" hits ~190KB) and OOMs the
    // worker during the final sortDict (Map<word, Set<atomicType>>
    // grows past ~7GB). Hashing keeps merged-type strings to 11 chars
    // and short-circuits the iter-2 cross-feed amplification. No
    // hashMap is requested, the browser can't write fixtures, and a
    // future debug UI can postMessage the map back if needed.
    combined = await runAugsPacked(combined, selectedAugs, {
      cldr,
      curatedKeywords,
      eiwMix,
      wieMix,
      hashed: true,
      // Route aug-pipeline progress to two surfaces: t0-pack /
      // merge phases become per-row load-progress events (so the
      // big sync packs don't go silent in the modal); the original
      // aug-iter / aug-progress / aug-done events still drive the
      // augReporter aggregator for per-worker rows.
      onProgress: (e) => {
        switch (e.phase) {
          case 't0-pack-start':
            emitLoadProgress('start', 'aug-t0-pack', null);
            break;
          case 't0-pack-progress':
            emitLoadProgress(
              'progress', 'aug-t0-pack',
              `Packing aug input: ${e.i.toLocaleString()} / ${e.total.toLocaleString()}`,
            );
            break;
          case 't0-pack-end':
            emitLoadProgress('end', 'aug-t0-pack', null);
            break;
          case 'merge-start':
            emitLoadProgress('start', `aug-merge:${e.label || ''}`, null);
            break;
          case 'merge-progress':
            emitLoadProgress(
              'progress', `aug-merge:${e.label || ''}`,
              `Merging aug ${e.label || ''}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()}`,
            );
            break;
          case 'merge-end':
            emitLoadProgress('end', `aug-merge:${e.label || ''}`, null);
            break;
          case 'sort-build':
          case 'sort-merge':
          case 'sort-final':
          case 'sort-end':
            // aug-pipeline's pre-aug sortDictAsync flows through here
            // with sortKind='aug-presort'. Route to the same per-row
            // helper that the base / corpus sorts use.
            routeSortProgress('aug-presort', 'aug input', e);
            break;
          default:
            augReporter.handle(e);
        }
      },
    });
  }

  // Transform-singleton injection (docs/cover-transforms.md).
  //
  // CRITICAL ORDERING: this block MUST run AFTER runAugsPacked above.
  // If the rewriter / voice-reformatter `<prefix>_w_<word>` singletons
  // were already in `combined` when the augs ran, `emojiIntoWords`
  // would fan emoji + emoji-phrase entries across every atomic type
  // each keyword word carries (including the singleton types) and
  // pollute the 0-bit-per-slot bucket invariant those transforms rely
  // on for round-trip safety (see tmp/typos-bug-findings.md). Running
  // augs first means `wordTypes.get(keyword)` returns only the base /
  // emoji codebook tags, so the fan-out can't reach the singleton
  // types. Then we concat the singletons here: each `<prefix>_w_<word>`
  // atom appears exactly once on its target word, and sortDict gives
  // every target word a unique merged type → singleton bucket → 0 bits
  // per slot, as the transform's safety contract requires.
  //
  // Voice reformatter singletons. When byos.reformatter.voice is
  // enabled, load fixtures/reformatter-voice-<mode>.twlist.sab.gz and
  // append into combined so sortdct picks every opener / closer / etc.
  // word up as a 0-bit unique-type singleton. Kept in a separate
  // `voiceEntries` reference so the corpus-dict path (which otherwise
  // restricts to corpus vocab) can re-include them, voice words are
  // reformatter metadata, not corpus vocabulary.
  let voiceEntries = [];
  if (reformatterFlags && reformatterFlags.voice
      && reformatterFlags.voice.enabled === true
      && typeof reformatterFlags.voice.mode === 'string') {
    const mode = reformatterFlags.voice.mode;
    const key   = `reformatter-voice-${mode}`;
    const label = `Voice (${mode})`;
    emitProgress('base', null, `Loading ${label}...`);
    const sab = await loadWithRow(key, key, 'twlist', { fixture: true });
    const unpackRowId = `unpack:${key}`;
    emitLoadProgress('start', unpackRowId, `Unpacking ${label}`);
    voiceEntries = await unpackEntriesAsync(wrapEntriesSAB(sab), {
      onProgress: (e) => {
        if (e.phase === 'merge-progress') {
          emitLoadProgress(
            'progress', unpackRowId,
            `Unpacking ${label}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()}`,
          );
        }
      },
    });
    emitLoadProgress('end', unpackRowId, null);
    combined = combined.concat(voiceEntries);
    emitProgress('base', null,
      `Voice reformatter (${mode}): +${voiceEntries.length} singleton entries`);
  }

  // Cover-transforms rewriter injection. Each enabled rewriter
  // contributes its unique-twlist via the standard twlist resource
  // path (fixtures/rewriter-<name>.twlist.sab.gz, NTEN format).
  if (rewriterFlags) {
    let totalRewriterEntries = 0;
    for (const name of REWRITER_CHAIN) {
      const f = rewriterFlags[name];
      if (!f || f.enabled !== true || !(f.intensity > 0)) continue;
      if (!SHIPPED_REWRITERS.has(name)) {
        throw new Error(
          `rewriter "${name}" is not yet shipped (no rewriter-${name}.twlist.sab.gz fixture)`);
      }
      const key   = `rewriter-${name}`;
      const label = `Rewriter (${name})`;
      emitProgress('base', null, `Loading ${label}...`);
      const sab = await loadWithRow(key, key, 'twlist', { fixture: true });
      const unpackRowId = `unpack:${key}`;
      emitLoadProgress('start', unpackRowId, `Unpacking ${label}`);
      const entries = await unpackEntriesAsync(wrapEntriesSAB(sab), {
        onProgress: (e) => {
          if (e.phase === 'merge-progress') {
            emitLoadProgress(
              'progress', unpackRowId,
              `Unpacking ${label}: ${e.i.toLocaleString()} / ${e.total.toLocaleString()}`,
            );
          }
        },
      });
      emitLoadProgress('end', unpackRowId, null);
      combined = combined.concat(entries);
      totalRewriterEntries += entries.length;
    }
    if (totalRewriterEntries > 0) {
      emitProgress('base', null,
        `Cover-transforms rewriters: +${totalRewriterEntries} singleton entries`);
    }
  }

  // ---- Step 1b: load external freq fixtures (research-notes §11) ----
  const extFreqSources = [];
  for (const key of extFreqKeys) {
    if (!KNOWN_FREQ_KEYS.has(key)) {
      throw new Error(`unknown freq selection "${key}"`);
    }
    emitProgress('base', stepIdx / totalSteps,
      `Loading ${FREQ_LABELS[key]} frequencies...`);
    // Load the canonical freq SAB (NTFQ) and unpack to
    // {totalTokens, counts}. No TSV parse at runtime, the parse
    // happened once at build time via `sab pack freq`.
    const sab = await loadWithRow(key, key, 'freq', { fixture: true });
    const parsed = unpackFreqFromSAB(sab);
    extFreqSources.push(parsed);
    stepIdx++;
    emitProgress('base', stepIdx / totalSteps,
      `Loaded ${FREQ_LABELS[key]} frequencies (${parsed.counts.size.toLocaleString()} words)`);
  }

  // ---- Step 2 prep: load corpus text (needed when not flat, either
  // for the model table downstream or for the style-freq blend on the
  // base dict). Memoized so we don't re-fetch when both useCorpus and
  // wantStyleFreq want it. ----
  let sliced = null;
  let wordCounts = null;
  async function loadCorpusText() {
    if (sliced !== null) return sliced;
    if (storyStyle === 'flat') { sliced = ''; return sliced; }
    if (storyStyle === 'custom') {
      emitProgress('corpus', 0,
        `Using uploaded corpus${customCorpusName ? ` (${customCorpusName})` : ''}...`);
      sliced = customCorpusText || '';
    } else {
      emitProgress('corpus', 0, `Loading ${corpusFile}...`);
      sliced = await fetchText(new URL(corpusFile, FIXTURE_DIR));
    }
    return sliced;
  }
  async function tokenizeCorpus() {
    if (wordCounts !== null) return wordCounts;
    const text = await loadCorpusText();
    emitProgress('corpus', 0, 'Tokenizing corpus...');
    wordCounts = await listWordsWithCounts(text, {
      onProgress: ({ pos, total }) => {
        emitProgress(
          'corpus',
          total > 0 ? pos / total : null,
          `Tokenizing corpus... ${formatChars(pos)} / ${formatChars(total)} processed`,
        );
      },
    });
    return wordCounts;
  }

  // ---- Step 1c: build the freq Map ----
  // The picker's selections drive weights for whichever dict is active
  // at runtime, base in Vocabulary Scope=base mode, corpus dict in
  // Vocabulary Scope=corpus mode. We merge once and reuse for both
  // buildDictionary calls so the cache key (which already folds in
  // freqSelections) covers both. When wantStyleFreq is on, the corpus's
  // own counts join the merge as one source; when off, corpus counts
  // are not used at all.
  let freqMap = null;
  if (extFreqSources.length > 0 || wantStyleFreq) {
    const sources = [...extFreqSources];
    if (wantStyleFreq) {
      const wc = await tokenizeCorpus();
      sources.push(wordCountsToFreqSource(wc));
    }
    if (sources.length > 0) {
      freqMap = combineFrequencies(sources);
    }
  }

  // ============== FLAT (Random card) path ==============
  // No corpus, no model. Build the base dict from the full combined
  // union and post. The flat path can't use the type-filter
  // optimization because there's no model to constrain merged-type
  // membership against, every type is reachable by definition.
  if (storyStyle === 'flat') {
    emitProgress('base', null, `Sorting ${combined.length.toLocaleString()} entries...`);
    const baseMtw = await sortDictAsync(combined, {
      hashed: true,
      onProgress: (e) => routeSortProgress('base-sort', 'base dict', e),
    });
    emitProgress('base', null, 'Building Huffman codes...');
    const baseDictJson = await buildDictionaryAsync(baseMtw, {
      name: 'session-base',
      frequencies: freqMap,
      tieBreak: dictTieBreak,
      onProgress: (e) => routeBuildDictProgress('base-builddict', 'base dict', e),
    });
    emitProgress('base', null,
      `Packing ${baseDictJson.words.length.toLocaleString()} words into shared memory...`);
    const baseSab = await packDictToSABAsync(baseDictJson, {
      onProgress: (e) => routePackDictProgress('base-packdict', 'base dict', e),
    });
    postSab('base', baseSab, { stats: dictStats(baseDictJson, baseSab.byteLength) });
    parentPort.postMessage({ type: 'done' });
    return;
  }

  // ============== Section 2: corpus dict + model ==============
  // Built unconditionally on non-flat paths. The corpus dict's merged-
  // type set is exactly the set of merged types the model can emit, so
  // it doubles as the type-filter source on the useCorpus=false branch.
  // On useCorpus=true the corpus dict is also the active dict at encode
  // time.
  await loadCorpusText();
  const wc = await tokenizeCorpus();
  const vocab = new Set(wc.keys());
  emitProgress('corpus', null, `Restricting to ${vocab.size.toLocaleString()} vocab words...`);
  const restricted = await restrictToVocabAsync(combined, vocab, {
    onProgress: (e) => routeRestrictProgress('corpus-restrict', 'corpus vocab', e),
  });
  // Voice singletons are reformatter metadata, not corpus vocabulary;
  // restrictToVocab filtered them out. Re-append so the corpus dict
  // has the entries the runtime voice enhancer resolves via lookupWord.
  if (voiceEntries.length > 0) {
    restricted.push(...voiceEntries);
  }
  emitProgress('corpus', null, `Sorting ${restricted.length.toLocaleString()} entries...`);
  const corpusMtw = await sortDictAsync(restricted, {
    hashed: true,
    onProgress: (e) => routeSortProgress('corpus-sort', 'corpus dict', e),
  });
  emitProgress('corpus', null, 'Building Huffman codes...');
  // Corpus dict shares the same freqMap as the (optional) base dict,
  // the picker drives weights for both. To get the legacy "raw corpus
  // counts only" behavior, the user ticks only [Style] frequencies
  // in the picker, which makes wc the sole source of the merge.
  const corpusDictJson = await buildDictionaryAsync(corpusMtw, {
    name: `session-corpus-${storyStyle}`,
    frequencies: freqMap,
    tieBreak: dictTieBreak,
    onProgress: (e) => routeBuildDictProgress('corpus-builddict', 'corpus dict', e),
  });
  emitProgress('corpus', null,
    `Packing ${corpusDictJson.words.length.toLocaleString()} words into shared memory...`);
  const corpusSab = await packDictToSABAsync(corpusDictJson, {
    onProgress: (e) => routePackDictProgress('corpus-packdict', 'corpus dict', e),
  });

  emitProgress('model', 0, 'Building sentence model...');
  const corpusDict = wrapDictionaryFromSAB(corpusSab);
  const modelJson = await generateModelTableAsync(sliced, corpusDict, {
    name: `session-model-${storyStyle}`,
    dedupe: sentenceMode !== 'sequential',
    onProgress: ({ pos, total }) => {
      emitProgress(
        'model',
        total > 0 ? pos / total : null,
        `Building sentence model... ${formatChars(pos)} / ${formatChars(total)} processed`,
      );
    },
    // Route the dedupe-sort's per-pass events to a row so the modal
    // shows live progress through what used to be a 2-4 s silent
    // mergesort window on big corpora.
    sortOnProgress: (e) => routeMergesortProgress('model-sort', 'sentence model dedupe', e),
  });
  emitProgress('model', 1, `Packing ${modelJson.models.length.toLocaleString()} sentence models...`);
  const modelSab = await packModelTableToSABAsync(modelJson, {
    onProgress: (e) => routePackModelProgress('model-pack', 'sentence models', e),
  });
  const packedTable = wrapModelTableFromSAB(modelSab);

  // ============== Section 3: useCorpus=true branch ==============
  // Active dict is the corpus dict. Run the usability check now; throw
  // with corpus-specific advice if no model emission has bit-bearing
  // slots. Post 'corpus' + 'model' and exit, no base dict is built.
  if (useCorpus) {
    const usable = await tableHasUsableModelsAsync(packedTable, corpusDict, {
      onProgress: (e) => routeUsableProgress('model-usable', 'sentence model usability', e),
    });
    if (!usable) {
      throw new Error(
        'Your corpus is too short or too repetitive to build a usable ' +
        'encoding. Every word in it ends up in a category with no ' +
        'alternatives in the active dictionary, so there are no slots ' +
        'that can carry bits. Try a longer or more varied corpus.'
      );
    }
    postSab('corpus', corpusSab, { stats: dictStats(corpusDictJson, corpusSab.byteLength) });
    postSab('model', modelSab, { modelCount: modelJson.models.length });
    parentPort.postMessage({ type: 'done' });
    return;
  }

  // ============== Section 4: useCorpus=false branch ==============
  // Build the wider base dict, filtered to only the merged types the
  // model can reach. The corpus dict above is internal scaffolding,
  // its merged-type set seeds the filter, but it's never posted.
  const typeSet = new Set();
  for (const row of corpusMtw) typeSet.add(row.type);

  emitProgress('base', null, `Sorting ${combined.length.toLocaleString()} entries...`);
  const fullMtw = await sortDictAsync(combined, {
    hashed: true,
    onProgress: (e) => routeSortProgress('base-sort', 'base dict', e),
  });
  emitProgress('base', null,
    `Filtering ${fullMtw.length.toLocaleString()} entries to ${typeSet.size.toLocaleString()} model-reachable types...`);
  // Filter the full union to rows whose merged type the model can
  // emit, then union with corpusMtw. The union catches two cases
  // fullMtw can't cover on its own:
  //   - self-defined corpus words (restrictToVocab emits {type:w, word:w}
  //     for corpus tokens not in any twlist, these have no row in
  //     `combined`, so fullMtw can't have them).
  //   - voice singletons whose corpus-side merged type isolates the
  //     voice atomic type but whose fullMtw merge folds in the twlist
  //     types of the same word, different hashes, different rows.
  // corpusMtw rows always win on word collisions because the model was
  // built against the corpus dict's typeIndex, so the active dict must
  // resolve voice/self-defined words to those exact merged-type-hashes.
  const byWord = new Map();
  for (const row of fullMtw) if (typeSet.has(row.type)) byWord.set(row.word, row);
  for (const row of corpusMtw) byWord.set(row.word, row);
  const baseMtw = [...byWord.values()];
  emitProgress('base', null, 'Building Huffman codes...');
  const baseDictJson = await buildDictionaryAsync(baseMtw, {
    name: 'session-base',
    frequencies: freqMap,
    tieBreak: dictTieBreak,
    onProgress: (e) => routeBuildDictProgress('base-builddict', 'base dict', e),
  });
  emitProgress('base', null,
    `Packing ${baseDictJson.words.length.toLocaleString()} words into shared memory...`);
  const baseSab = await packDictToSABAsync(baseDictJson, {
    onProgress: (e) => routePackDictProgress('base-packdict', 'base dict', e),
  });
  const baseDict = wrapDictionaryFromSAB(baseSab);

  // Deferred usability check against the wider base dict. Singleton
  // types in the corpus dict can gain words from the rest of the
  // combined union here, so corpora that would fail this check against
  // the corpus dict may still pass against the base dict.
  const usable = await tableHasUsableModelsAsync(packedTable, baseDict, {
    onProgress: (e) => routeUsableProgress('model-usable', 'sentence model usability', e),
  });
  if (!usable) {
    throw new Error(
      'Your corpus is too short or too repetitive to build a usable ' +
      'encoding. Every word in it ends up in a category with no ' +
      'alternatives in the active dictionary, so there are no slots ' +
      'that can carry bits. Try a longer or more varied corpus.'
    );
  }

  postSab('base', baseSab, { stats: dictStats(baseDictJson, baseSab.byteLength) });
  postSab('model', modelSab, { modelCount: modelJson.models.length });
  parentPort.postMessage({ type: 'done' });
}

parentPort.onMessage(async (msg) => {
  try {
    if (msg?.type === 'build-session') return await handleBuild(msg);
    // Loader-proxy replies (`loadProgress`/`loadResult`/`loadError`)
    // arrive on the loader-proxy protocol, they carry an `action`
    // field, not a `type` field. resource-loader-client.js consumes
    // them via its own message listener; ignore them here so they
    // don't surface as "unknown message type" errors. The build-
    // session protocol's own message verb stays in the `type` field;
    // the two namespaces are distinct by design.
    if (msg?.action === 'loadProgress' || msg?.action === 'loadResult' || msg?.action === 'loadError') return;
    parentPort.postMessage({ type: 'error', error: `unknown message type ${msg?.type}` });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err?.message ?? String(err) });
  }
});

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// all imports + handler registration; createWorker() awaits this
// before resolving. Forgetting this line will hang createWorker().
parentPort.postMessage({ type: 'ready' });
