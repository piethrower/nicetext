// Stress engine for the NiceText encode/decode pipeline.
//
// Synthesizes a random-bytes corpus, builds a dict + model from it
// using the in-process builder primitives (same code paths the
// production worker uses, minus the worker shell), then loops
// continuous sweeps of encode→decode round-trips at a ladder of
// secret sizes until an AbortSignal fires.
//
// Pure logic; no I/O. The caller (Node CLI or browser harness) owns
// progress reporting, forensics dump, and cancellation source.
//
// Browser-safe ESM. No Node deps.

import { mulberry32 } from '../../../js/src/random.js';
import { encode } from '../../../js/src/encode.js';
import { decode } from '../../../js/src/decode.js';
import { listWordsWithCounts } from '../../../js/src/builder/listword.js';
import { restrictToVocab } from '../../../js/src/builder/sources.js';
import { sortDict } from '../../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../../js/src/builder/dct2mstr.js';
import { generateModelTable } from '../../../js/src/builder/genmodel.js';
import { runAugsPacked } from '../../../js/src/builder/aug-pipeline.js';
import { loadDictionary } from '../../../js/src/dictionary.js';
import { loadModelTable, modelTableStream } from '../../../js/src/modeltable.js';

// Default base sources. Matches the developer's repro URL for the
// .deb-upload failure: 7 sources, no emoji. Augment with vowel only
// (no eiw/wie); restrictToVocab applied (mirrors voc=c). Keeps the
// stress dict shape close to production card BYOSes (Aesop etc.)
// so encodes mostly succeed and the harness catches subtle round-
// trip bugs rather than gross dict-fragmentation failures.
export const DEFAULT_SOURCES = [
  'claude2026', 'connectors', 'impf2p', 'impkimmo',
  'mit', 'num-form-preserved', 'rhyme',
];

// Fixture I/O lives in the callers: the browser worker and Playwright
// probe load SAB fixtures through the resource loader, the Node CLI
// through the same loader's node path. Shared loading + unpack logic
// lives in ./load-assets.js. The engine stays pure: callers hand it a
// fully-built `assets` object.

// Caller provides an `assets` object:
//   {
//     baseTwlists:   { sourceName: Array<{type, word}>, ... }
//     cldr:          parsed CLDR object (required when an emoji
//                    source is selected)
//   }
// Stays pure-ESM; no fs/zlib imports here so the engine can also
// run in a browser harness with fetch + DecompressionStream.

// Default sweep ladder (secret sizes in bytes).
export const DEFAULT_SIZES = [
  1, 64, 1024, 8192, 65536, 524288, 1048576, 4194304, 10485760,
];
export const DEFAULT_REPS = 2;
export const DEFAULT_CORPUS_BYTES = 1 * 1024 * 1024; // 1 MB

// Synthesize a random-bytes corpus deterministically. Decoded as
// utf-8 with replacement chars for invalid sequences, same shape
// a user pasting a binary file into the BYO corpus textarea would
// produce after the browser's text decode.
export function synthCorpus(bytes, seed) {
  const rng = mulberry32(seed);
  const arr = new Uint8Array(bytes);
  // mulberry32 returns a float in [0, 1); `f & 0xff` would coerce to
  // int32 (always 0). Use (rng() * 256) | 0 to actually fill 0..255.
  for (let i = 0; i < bytes; i++) arr[i] = (rng() * 256) | 0;
  return new TextDecoder('utf-8', { fatal: false }).decode(arr);
}

// Build a corpus by snipping random byte ranges from caller-loaded
// fixtures. Pure logic, no I/O, callers (Node CLI via fs+zlib,
// browser harness via fetch+DecompressionStream) own loading and
// pass in `fixtures` as an array of `{ name?: string, raw: Uint8Array,
// inflated: Uint8Array|null }` objects, one per source file. Each
// iteration picks a fixture, decides raw-vs-inflated 50/50 when both
// are available, picks a 256B..32KB chunk, and appends. The final
// byte stream is UTF-8 decoded with replacement so the result lexes
// the same way a user pasting a binary file into the corpus textarea
// would. Mirrors run.mjs's `corpusFromFixtureSnips` so the browser
// stress harness can produce the same regime as the CLI.
export function snipCorpusFromFixtures(fixtures, seed, totalBytes) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('stress: snipCorpusFromFixtures requires at least one fixture');
  }
  const rng = mulberry32(seed);
  const chunks = [];
  let total = 0;
  while (total < totalBytes) {
    const f = fixtures[Math.floor(rng() * fixtures.length)];
    const useInflated = f.inflated && rng() < 0.5;
    const src = useInflated ? f.inflated : f.raw;
    if (!src || src.length < 16) continue;
    const chunkLen = Math.min(src.length, 256 + Math.floor(rng() * (32 * 1024)));
    const start = Math.floor(rng() * (src.length - chunkLen));
    chunks.push(src.subarray(start, start + chunkLen));
    total += chunkLen;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    if (off + c.length > merged.length) {
      merged.set(c.subarray(0, merged.length - off), off);
      off = merged.length;
      break;
    }
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, off));
}

// Build dict + model in-process from a corpus string. Stress shape:
// every configured base source is folded in WITHOUT restrictToVocab
// (matching "Words from Story + Sources" mode plus the emoji flood
// preset). Aug pipeline runs in-process (useWorkers:false) with
// vowel + eiw + wie + mix=7. precleanCorpus runs inside
// listWordsWithCounts and generateModelTable already.
//
// opts.onProgress (optional) is called with { detail } strings at
// every major build phase boundary, plus per-tick during the two
// long phases (aug pipeline and model-table generation). Numbers
// inside `detail` are formatted with thousands separators so the
// UI doesn't have to re-format them.
function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
export async function buildArtifactsFromCorpus(corpus, assets, opts = {}) {
  const {
    sources = DEFAULT_SOURCES,
    emojiFlood = false,
    restrict = true,
    onProgress = null,
  } = opts;
  const detail = (s) => { if (onProgress) onProgress({ detail: s }); };

  detail(`listing words in corpus (${fmtN(corpus.length)} chars)...`);
  const counts = await listWordsWithCounts(corpus);
  if (counts.size === 0) {
    throw new Error('stress: corpus has no extractable words');
  }
  detail(`indexed ${fmtN(counts.size)} unique words; gathering base TW-lists...`);
  const baseTwlist = [];
  for (const s of sources) {
    const entries = assets.baseTwlists?.[s];
    if (!entries) throw new Error(`stress: missing assets.baseTwlists['${s}']`);
    for (const e of entries) baseTwlist.push(e);
  }
  detail(`base TW-list pooled: ${fmtN(baseTwlist.length)} entries across ${sources.length} sources`);

  // Emoji flood: emoji16 sources fold into baseTwlist; eiw/wie/mix=7
  // are the cross-modal emoji augs. (The standalone vowel aug was
  // retired with the cover-transforms arc; a/an handling is now a
  // runtime lookahead, so the aug pipeline only knows eiw/wie.)
  const selectedAugs = [];
  if (emojiFlood) selectedAugs.push('eiw', 'wie');
  const augOpts = {
    useWorkers: false,
    poolSize: 1,
    onProgress: (e) => {
      if (e.phase === 'aug-progress') {
        detail(`augmenting iter ${e.iter}, ${e.augKind}: ${fmtN(e.emitted)} entries emitted`);
      } else if (e.phase === 'aug-iter') {
        detail(`augmentation iter ${e.iter} done: ${fmtN(e.total)} entries total`);
      }
    },
  };
  if (emojiFlood) {
    if (!assets.cldr) throw new Error('stress: emoji-flood selected but assets.cldr missing');
    augOpts.cldr = assets.cldr;
    augOpts.mix = 7;
    if (assets.curatedKeywords) augOpts.curatedKeywords = assets.curatedKeywords;
  }
  detail(`running aug pipeline (${selectedAugs.join(', ')}${emojiFlood ? ', mix=7' : ''})...`);
  const augmented = await runAugsPacked(baseTwlist, selectedAugs, augOpts);
  detail(`aug pipeline done: ${fmtN(augmented.length || augmented.size || 0)} augmented entries`);

  // restrict=true → mirror useCorpus=true / voc=c (default).
  // restrict=false → mirror useCorpus=false / voc=b (full base
  // vocab, no corpus-restriction). The latter produces a much
  // larger dict and is the heavier stress mode.
  let twlist;
  if (restrict) {
    detail('restricting augmented vocabulary to corpus words...');
    const vocab = new Set(counts.keys());
    twlist = restrictToVocab(augmented, vocab);
  } else {
    twlist = augmented;
  }
  const restricted = twlist;

  detail('sorting and merging types...');
  const mtw = await sortDict(restricted, { hashed: true });
  detail('building dictionary structure...');
  const dictJson = buildDictionary(mtw, {
    name: 'stress-corpus',
    frequencies: counts,
    tieBreak: 'alpha-asc',
  });
  const dict = loadDictionary(dictJson);
  detail(`dictionary built: ${fmtN(dict.header?.wordCount ?? 0)} words`);

  detail('generating sentence model from corpus...');
  const modelJson = await generateModelTable(corpus, dict, {
    name: 'stress',
    dedupe: true,
    onProgress: (e) => {
      detail(`generating sentence model: ${fmtN(e.pos)} / ${fmtN(e.total)} tokens`);
    },
  });
  const table = loadModelTable(modelJson);
  detail('sentence model loaded; entering sweep loop.');

  return { dict, table };
}

// ---- stream + bytes helpers ----

export function bytesToStream(bytes) {
  return new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  });
}
function stringToStream(s) {
  return bytesToStream(new TextEncoder().encode(s));
}
export function captureBytesSink() {
  const chunks = [];
  const writable = new WritableStream({ write(c) { chunks.push(c); } });
  return {
    writable,
    result() {
      let n = 0;
      for (const c of chunks) n += c.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    resultAsString() {
      const dec = new TextDecoder();
      let s = '';
      for (const c of chunks) s += dec.decode(c, { stream: true });
      s += dec.decode();
      return s;
    },
  };
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// One round-trip: encode→cover→decode→recovered. Returns a status
// object suitable for the failure-event channel; never throws.
// `onTick` (optional) receives the live counters that encode/decode
// already expose via their internal onProgress callbacks, every
// YIELD_EVERY iterations on each side. Shape:
//   { phase: 'encode', modelsProcessed, bitsRead }
//   { phase: 'decode', wordsProcessed }
// runStress wraps these as outer { kind: 'tick', ... } events so the
// UI can repaint at its own cadence without polling the engine.
async function runOneRoundTrip(secret, dict, table, rng, onTick) {
  const stream = modelTableStream(table, { dict, mode: 'random', random: rng });
  let cover = null;
  let recovered = null;
  let error = null;
  let phase = 'encode';
  // Sinks hoisted so the catch block can still read what landed
  // before the throw (validate-failure path: cover bytes already
  // got written before the encoder threw, preserve them).
  const sink = captureBytesSink();
  const dsink = captureBytesSink();
  try {
    await encode(bytesToStream(secret), sink.writable, dict, {
      modelStream: stream,
      validate: true,
      onProgress: onTick
        ? (e) => onTick({ phase: 'encode', modelsProcessed: e.modelsProcessed, bitsRead: e.bitsRead })
        : undefined,
    });
    cover = sink.resultAsString();
    phase = 'decode';
    await decode(stringToStream(cover), dsink.writable, dict, {
      onProgress: onTick
        ? (e) => onTick({ phase: 'decode', wordsProcessed: e.wordsProcessed })
        : undefined,
    });
    recovered = dsink.result();
    phase = 'compare';
    if (!bytesEqual(secret, recovered)) {
      return {
        ok: false,
        phase,
        cover, recovered,
        error: new Error(
          `byte mismatch at offset ${firstDiff(secret, recovered)} ` +
          `(source ${secret.length} bytes, recovered ${recovered.length} bytes)`
        ),
      };
    }
    return { ok: true, phase, cover, recovered };
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    // Salvage whatever each sink accumulated before the throw.
    try { if (cover === null) cover = sink.resultAsString(); } catch {}
    try { if (recovered === null) recovered = dsink.result(); } catch {}
    return { ok: false, phase, cover, recovered, error };
  }
}

// Random secret bytes from the given rng.
function makeSecret(rng, size) {
  const a = new Uint8Array(size);
  for (let i = 0; i < size; i++) a[i] = (rng() * 256) | 0;
  return a;
}

// Main loop. Runs sweeps in order over the size ladder. Each
// (size, rep) is one round-trip. Between every round-trip we honor
// signal.aborted for prompt cancellation, plus the configurable
// stop conditions (maxSweeps reached at sweep-end, maxDurationMs
// exceeded between round-trips). Default config (both Infinity)
// loops forever, the prior runStressForever behavior. onProgress
// events:
//
//   { kind: 'setup',           detail }
//   { kind: 'sweep-start',     sweep }
//   { kind: 'roundtrip',       sweep, size, rep, ok, phase, ms }
//   { kind: 'failure',         sweep, size, rep, phase, source, cover, recovered, error }
//   { kind: 'sweep-end',       sweep, totals }
//   { kind: 'cancelled',       totals, reason }
//
// `reason` ∈ { 'signal', 'sweeps', 'duration', 'completed' },
// 'completed' is only reachable when maxSweeps is finite and the
// configured run finished without being aborted.
// totals: { runs, pass, fail, byPhase: {encode, decode, compare, ...} }
export async function runStress(opts = {}) {
  const {
    onProgress = () => {},
    signal = null,
    sizes = DEFAULT_SIZES,
    reps = DEFAULT_REPS,
    rngSeed = 0xDEADBEEF,
    corpus,             // string, caller-provided (file load, snipped, random, etc.)
    assets,             // { baseTwlists, cldr, curatedKeywords }, caller-loaded fixture data
    sources = DEFAULT_SOURCES,
    emojiFlood = false,
    restrict = true,
    maxSweeps = Infinity,
    maxDurationMs = Infinity,
  } = opts;
  if (typeof corpus !== 'string' || corpus.length === 0) {
    throw new Error('stress: opts.corpus must be a non-empty string');
  }
  if (!assets || !assets.baseTwlists) {
    throw new Error('stress: opts.assets.baseTwlists missing');
  }

  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  // Returns null if the run should continue, otherwise the cancel
  // reason. Signal beats sweeps/duration so a user Ctrl-C reports
  // honestly even if it lands on the same tick as a bound.
  const shouldStop = () => {
    if (signal && signal.aborted) return 'signal';
    if (elapsedMs() >= maxDurationMs) return 'duration';
    return null;
  };

  onProgress({ kind: 'setup', detail: `corpus is ${Number(corpus.length).toLocaleString('en-US')} chars; building dict + model...` });
  {
    const r = shouldStop();
    if (r) { onProgress({ kind: 'cancelled', totals: emptyTotals(), reason: r }); return; }
  }
  const { dict, table } = await buildArtifactsFromCorpus(corpus, assets, {
    sources, emojiFlood, restrict,
    onProgress: (e) => onProgress({ kind: 'setup', detail: e.detail }),
  });

  const totals = emptyTotals();
  const rng = mulberry32(rngSeed);
  let sweep = 0;
  let stopReason = null;
  while (sweep < maxSweeps && !(stopReason = shouldStop())) {
    sweep++;
    onProgress({ kind: 'sweep-start', sweep });
    for (const size of sizes) {
      if ((stopReason = shouldStop())) break;
      for (let rep = 0; rep < reps; rep++) {
        if ((stopReason = shouldStop())) break;
        const secret = makeSecret(rng, size);
        const t0 = Date.now();
        const result = await runOneRoundTrip(secret, dict, table, rng, (tick) => {
          onProgress({ kind: 'tick', sweep, size, rep, ...tick });
        });
        const ms = Date.now() - t0;
        totals.runs++;
        if (result.ok) totals.pass++;
        else {
          totals.fail++;
          totals.byPhase[result.phase] = (totals.byPhase[result.phase] || 0) + 1;
        }
        onProgress({ kind: 'roundtrip', sweep, size, rep, ok: result.ok, phase: result.phase, ms });
        if (!result.ok) {
          onProgress({
            kind: 'failure',
            sweep, size, rep, phase: result.phase,
            source: secret,
            cover: result.cover,
            recovered: result.recovered,
            error: result.error,
          });
        }
      }
    }
    onProgress({ kind: 'sweep-end', sweep, totals: { ...totals, byPhase: { ...totals.byPhase } } });
  }
  // Loop exit: stopReason set by shouldStop(), or maxSweeps reached.
  if (!stopReason) stopReason = sweep >= maxSweeps ? 'sweeps' : 'completed';
  onProgress({ kind: 'cancelled', totals: { ...totals, byPhase: { ...totals.byPhase } }, reason: stopReason });
}

function emptyTotals() {
  return { runs: 0, pass: 0, fail: 0, byPhase: {} };
}
