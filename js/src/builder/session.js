// Parent-side orchestrator for the session-base-dictionary feature on
// nicetext.html. Spawns a session-build worker, receives one to three
// SABs (session-base-dict, optional session-corpus-dict, optional
// session-model-table), pre-populates the resourceCache in
// `worker/jobs.js` under synthetic `pageLifeSpan:` keys, and returns
// the path tokens encodeJob/decodeJob will consume on the next click.
//
// See docs/session-base-dictionary.md.
//
// Browser-only. The fixtures it relies on are HTTP resources; this
// path never runs under node test runners.

import { createWorker } from '../worker/spawn.js';
import { _registerResource } from '../worker/jobs.js';
import { attachLoaderProxy } from '../resource-loader.js';
import { getCorpusFile } from '../byos.js';
import cardsRegistry from '../../../fixtures/cards.data.js';

const BUILD_WORKER_URL = new URL('../worker/build-session-worker.js', import.meta.url);

// Story Style id → corpus fixture filename (already includes .gz suffix).
// Derived from the byos registry: every non-flat card with a build.corpus
// contributes one entry. Single source of truth lives in tools/byos/*.byos.json
// → fixtures/cards.data.js → here. Adding a new card is byos.json + bake.
export const STORY_CORPUS = (() => {
  const m = {};
  for (const card of cardsRegistry) {
    if (!card.story || card.story.style === 'flat') continue;
    const f = getCorpusFile(card);
    if (f) m[card.story.style] = f;
  }
  return m;
})();

// Stable hash of the build inputs for cache keys + SAB key naming.
function hashInputs(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Keep a parent-side cache so flipping inputs that match a prior build
// returns the same SAB-backed paths without rebuilding. Lives only as
// long as the page (no persistence, by design, see rule 27).
const sessionCache = new Map();

// Build (or reuse) a session-base-dictionary plus the optional
// session-corpus-dictionary and session-model-table. Returns
// `{ dictPath, modelPath?, mode, dictLabel, styleLabel, baseStats,
//   corpusStats? }`. The path tokens are synthetic `pageLifeSpan:`
// keys that the engine resourceCache resolves to in-memory SABs.
export async function buildSessionArtifacts(spec) {
  const {
    selections,           // Set<string>: subset of { impf2p, impkimmo, mit, num-form-preserved, num-form-interchangeable, num-roman, rhyme, claude2026, connectors, moby-pos, moby-thesaurus, wordnet, wordnet-synonyms }
    selectionLabels,      // { [key]: humanLabel }, owned by app.js chip catalogue, used by worker for the per-source progress line
    storyStyle,           // 'flat' | 'custom' | one of STORY_CORPUS keys
    sentenceMode,         // 'random' | 'sequential'  (ignored if flat)
    useCorpus,            // boolean (ignored if flat)
    storyLabel,           // human label for status text
    customCorpusText,     // string | null, populated only when storyStyle === 'custom'
    customCorpusName,     // string | null, uploaded filename (cache key + display)
    customTwlistEntries,  // Array<{type, word}> | null, uploaded TW-list folded in alongside fixtures
    customTwlistName,     // string | null, uploaded filename (display only)
    customTwlistHash,     // string | null, content-hash prefix (cache key only)
    freqSelections,       // Array<string> | null, subset of {norvig,google,gutenberg,style} or null when picker hidden (useCorpus=true)
    tieBreak,             // 'alpha-asc' | 'length-desc'. BYOS "Prefer shorter words" checkbox; defaults to 'alpha-asc' when undefined
    emojiIntoWords,       // {enabled, intensity} | undefined. Aug A; intensity is repetition depth 0..MIX_MAX
    wordsIntoEmoji,       // {enabled, intensity} | undefined. Aug B; intensity is repetition depth 0..MIX_MAX
    rewriter,             // byos universal {enabled, intensity, mode?} per-field shape, cover-transforms rewriter block (docs/cover-transforms.md)
    reformatter,          // byos universal per-field shape, only voice contributes session-dict singletons today
    signal,
    onProgress,
    onAugProgress,        // optional ({iter, cap, poolSize, augKinds, workers:[...]})
    onLoadProgress,       // optional ({phase:'start'|'progress'|'end', id, label})
  } = spec;
  // Default the engine knob to its current behavior when the BYOS UI
  // hasn't shipped a value (older callers, or the recipe-replay path).
  const dictTieBreak = tieBreak === 'length-desc' ? 'length-desc' : 'alpha-asc';

  const sortedSelections = [...selections].sort();
  // Custom-twlist content is part of the base-dict identity; hashing
  // its hash prefix into baseKey means re-clicking Build with the
  // same selections+TW reuses the cached SAB, but a different TW
  // file (or a cleared/added Custom checkbox) rebuilds.
  const twId = customTwlistEntries && customTwlistEntries.length
    ? `tw:${customTwlistHash || hashInputs(customTwlistEntries)}`
    : null;
  // freqSelections is part of base-dict identity, flipping a freq
  // checkbox changes the Huffman codes, so the cached SAB must be
  // rebuilt. 'style' carries the corpus identity too (the corpus's
  // own counts ride the merge), so storyStyle is folded in alongside
  // when style is requested.
  const sortedFreqSels = Array.isArray(freqSelections) ? [...freqSelections].sort() : null;
  const freqId = sortedFreqSels && sortedFreqSels.length
    ? (sortedFreqSels.includes('style')
        ? `f:${sortedFreqSels.join(',')}@${storyStyle}`
        : `f:${sortedFreqSels.join(',')}`)
    : null;
  // tieBreak is part of base-dict identity, flipping it changes every
  // type's bit assignments, so the cached SAB must rebuild. Folded in
  // alongside selections / rewriter / twId / freqId.
  // Per-aug fingerprint: enable + intensity. Both feed the base-dict
  // hash so flipping either rebuilds the cached SAB.
  const augA = emojiIntoWords && emojiIntoWords.enabled === true ? emojiIntoWords : null;
  const augB = wordsIntoEmoji && wordsIntoEmoji.enabled === true ? wordsIntoEmoji : null;
  const augFingerprint = {
    eiw: augA ? (Number.isInteger(augA.intensity) ? Math.max(0, augA.intensity) : 0) : false,
    wie: augB ? (Number.isInteger(augB.intensity) ? Math.max(0, augB.intensity) : 0) : false,
  };
  // Cover-transforms rewriter block also feeds base-dict identity:
  // sortdct's singleton injection adds entries when enabled, so a
  // different rewriter set produces a different dict. Reformatter
  // does NOT, it's a model-layer enhancer with no dict footprint.
  const rewriterFingerprint = rewriter && typeof rewriter === 'object'
    ? Object.keys(rewriter).sort()
        .filter(k => rewriter[k]?.enabled === true && rewriter[k].intensity > 0)
        .join(',')
    : '';
  // Voice singletons land in the session dict via sortdct, so two
  // voice modes produce different dicts and must hash to different
  // base keys. Pure-code reformatters (case / lineBreak / sentenceEnd)
  // are encode-time, never touch the dict; omitted from the
  // fingerprint.
  const voiceFingerprint = reformatter
      && reformatter.voice
      && reformatter.voice.enabled === true
      && typeof reformatter.voice.mode === 'string'
    ? `voice:${reformatter.voice.mode}`
    : '';
  const baseKey = hashInputs({ s: sortedSelections, tw: twId, f: freqId, t: dictTieBreak, ea: augFingerprint, rw: rewriterFingerprint, vc: voiceFingerprint });
  // For Custom, the corpus identity is the file's contents (not its
  // filename) so re-uploading the same content hits cache and a
  // different file with the same name rebuilds. For built-in corpora,
  // identity is the storyStyle id.
  const corpusIdent = storyStyle === 'custom'
    ? `custom:${hashInputs(customCorpusText || '')}`
    : storyStyle;
  const corpusKey = storyStyle === 'flat'
    ? null
    : hashInputs({ b: baseKey, c: corpusIdent });
  const modelKey = storyStyle === 'flat'
    ? null
    : hashInputs({ b: baseKey, c: corpusIdent, u: !!useCorpus, m: sentenceMode });

  const cacheKey = JSON.stringify({ baseKey, corpusKey, modelKey, useCorpus, sentenceMode, storyStyle });
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    onProgress?.({ step: 'done', detail: 'Using previously built artifacts.', fraction: 1 });
    return cached;
  }

  if (signal?.aborted) throw makeAbort();

  const w = await createWorker(BUILD_WORKER_URL);
  // Wire main-thread resource-loader proxy: any loadResource call
  // inside build-session-worker.js routes its request up to main
  // here, hits the shared cache (or loads via the resource-worker
  // pool), and sends the SAB back through structured clone.
  const detachLoaderProxy = attachLoaderProxy(w);
  // The worker posts exactly one of base / corpus as the active dict:
  //   - flat (Random card): base
  //   - non-flat + useCorpus=true:  corpus (base is never built)
  //   - non-flat + useCorpus=false: base   (corpus is internal-only)
  // Keys are nulled out for the unposted side so we don't pre-allocate
  // resourceCache slots that never receive a SAB.
  const willPostBase   = storyStyle === 'flat' || !useCorpus;
  const willPostCorpus = storyStyle !== 'flat' && useCorpus;
  const baseSabKey   = willPostBase   ? `pageLifeSpan:base/${baseKey}`     : null;
  const corpusSabKey = willPostCorpus ? `pageLifeSpan:corpus/${corpusKey}` : null;
  const modelSabKey  = modelKey       ? `pageLifeSpan:model/${modelKey}`   : null;

  const result = {
    dictPath: corpusSabKey || baseSabKey,
    modelPath: modelSabKey,
    grammarPath: undefined,
    mode: sentenceMode,
    dictLabel: storyStyle === 'flat'
      ? 'Session base dictionary'
      : (useCorpus ? `Session corpus dictionary (${storyLabel})` : 'Session base dictionary'),
    styleLabel: storyStyle === 'flat'
      ? 'Flat: random words from session dictionary'
      : `${storyLabel}: ${sentenceMode === 'sequential' ? 'replay' : 'random pick'} from session model`,
    baseStats: null,
    corpusStats: null,
  };

  let abortListener = null;
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      };
      w.onmessage = ({ data }) => {
        if (data?.type === 'progress') {
          onProgress?.({ step: data.step, fraction: data.fraction, detail: data.detail });
          return;
        }
        if (data?.type === 'aug-progress') {
          onAugProgress?.({
            iter: data.iter, cap: data.cap,
            poolSize: data.poolSize, augKinds: data.augKinds,
            workers: data.workers,
          });
          return;
        }
        if (data?.type === 'load-progress') {
          onLoadProgress?.({ phase: data.phase, id: data.id, label: data.label });
          return;
        }
        if (data?.type === 'sab') {
          // The active dict (whether base or corpus) is registered
          // under kind='dict' at the engine boundary, encode/decode
          // doesn't distinguish. baseSabKey / corpusSabKey are nulled
          // out for the side the worker doesn't post.
          if (data.kind === 'base') {
            if (baseSabKey) _registerResource(baseSabKey, 'dict', data.sab);
            result.baseStats = data.stats;
          } else if (data.kind === 'corpus') {
            if (corpusSabKey) _registerResource(corpusSabKey, 'dict', data.sab);
            result.corpusStats = data.stats;
          } else if (data.kind === 'model') {
            if (modelSabKey) _registerResource(modelSabKey, 'model', data.sab);
          }
          return;
        }
        if (data?.type === 'done') {
          cleanup();
          resolve();
          return;
        }
        if (data?.type === 'error') {
          cleanup();
          reject(new Error(data.error));
        }
      };
      w.onerror = (err) => { cleanup(); reject(err); };

      if (signal) {
        abortListener = () => { cleanup(); reject(makeAbort()); };
        signal.addEventListener('abort', abortListener);
      }

      w.postMessage({
        type: 'build-session',
        selections: sortedSelections,
        labels: selectionLabels || {},
        storyStyle,
        useCorpus: !!useCorpus,
        sentenceMode,
        corpusFile: (storyStyle === 'flat' || storyStyle === 'custom')
          ? null : STORY_CORPUS[storyStyle],
        customCorpusText: storyStyle === 'custom' ? (customCorpusText || '') : null,
        customCorpusName: storyStyle === 'custom' ? customCorpusName : null,
        customTwlistEntries: customTwlistEntries || null,
        customTwlistName: customTwlistName || null,
        freqSelections: sortedFreqSels,
        tieBreak: dictTieBreak,
        emojiIntoWords: augA ? { enabled: true, intensity: augFingerprint.eiw } : null,
        wordsIntoEmoji: augB ? { enabled: true, intensity: augFingerprint.wie } : null,
        rewriter:    rewriter    || null,
        reformatter: reformatter || null,
      });
    });
  } finally {
    try { detachLoaderProxy(); } catch {}
    try { await w.terminate(); } catch {}
  }

  sessionCache.set(cacheKey, result);
  return result;
}

function makeAbort() {
  if (typeof DOMException !== 'undefined') return new DOMException('aborted', 'AbortError');
  const e = new Error('aborted'); e.name = 'AbortError'; return e;
}
