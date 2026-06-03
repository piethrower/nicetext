// Eve job handlers. Step 2 of the multi-worker scheduler arc.
//
// One pure-compute function per job kind the scheduler will
// dispatch. Each handler wraps the existing engine routine and
// returns a typed result. No fetch, no `new Worker`, no DOM. The
// orchestrator (Step 3) wires these into a worker shell on the
// browser side and a node CLI on the node side; tests invoke them
// directly with in-memory inputs.
//
// Why this shape: handler input/output is the contract. As long as
// the contract holds, the underlying engine routines can be
// refactored (e.g., split runStyleAndSentenceCheck into "build
// suspected shapes once, then per-card matcher") without the scheduler
// needing to know.
//
// Browser-safe ESM, zero deps.

import { tokenize as eveTokenize } from '../lexer.js';
import { runPhase1 } from './core.js';
import {
  createWordsIntoEmojiCheck,
  createEmojiIntoWordsCheck,
  createMixedPhrasesCheck,
  createSourceCheck,
  createCustomCorpusCheck,
  createCustomTwlistCheck,
} from './checks.js';
import { runIsNiceTextCheck } from './preclean-check.js';
import { runVocabCheck } from './vocab-check.js';
import {
  genMonotypedModel,
  runMonotypedModelCheckPerCard,
} from './monotyped-model-check.js';
import { createVerdictState, applyRule } from './verdict-state.js';
import { wrapPackedStrings } from './packed-strings-sab.js';
import { wrapMonotypedModel } from './monotyped-model-sab.js';

// Time-throttle a `progress(label)` callback so heavy inner loops
// firing hot don't flood the worker postMessage channel. First call
// always fires; subsequent calls within `intervalMs` are dropped.
// Returns null if the caller didn't pass a progress cb (handlers
// then skip the inner onProgress wiring entirely).
function throttleProgress(progress, intervalMs = 1000) {
  if (!progress) return null;
  let last = 0;
  return (label) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    progress(label);
  };
}

// Token-level scan: augment.{wordsIntoEmoji, emojiIntoWords,
// maxEmojiCluster} verdicts in one pass over the suspected. Caller passes
// a suspected slice (post-autoStrip; orchestrator owns slicing).
//
// `extras` carries optional developer-supplied detectors (CLI flags
// --twlist=name=path / --custom-corpus=path / --custom-twlist=path
// or the equivalent BYOS upload UI). Each entry is one of:
//   { kind: 'source',       name, words }   -> sources.<name>
//   { kind: 'customCorpus',       words }   -> customCorpus
//   { kind: 'customTwlist',       words }   -> customTwlist
// `words` is an Array<string> (lowercased; structured-clone-friendly).
// The detector functions themselves can't cross postMessage; we
// reconstruct them here from the serializable spec.
//
//   payload: { suspectedText, extras?, signal? }
//   result:  { verdicts: Array<verdict-row>, tokenCount }
export async function runSuspectedTokenScanJob({ suspectedText, extras = [], signal = null }, progress = null) {
  const detectors = [
    createWordsIntoEmojiCheck(),
    createEmojiIntoWordsCheck(),
    createMixedPhrasesCheck(),
  ];
  for (const e of extras) {
    const set = new Set(e.words);
    if (e.kind === 'source') {
      detectors.push(createSourceCheck(e.name, set));
    } else if (e.kind === 'customCorpus') {
      detectors.push(createCustomCorpusCheck(set));
    } else if (e.kind === 'customTwlist') {
      detectors.push(createCustomTwlistCheck(set));
    } else {
      throw new Error(`runSuspectedTokenScanJob: unknown extras kind "${e.kind}"`);
    }
  }
  const throttled = throttleProgress(progress);
  const result = await runPhase1(eveTokenize(suspectedText), detectors, {
    signal,
    onProgress: throttled
      ? ({ tokenCount, activeCount, totalCount }) => throttled(
          `suspected-token-scan: ${tokenCount.toLocaleString()} tokens scanned (${activeCount}/${totalCount} detectors still active)`
        )
      : null,
  });
  return { verdicts: result.verdicts, tokenCount: result.tokenCount };
}

// isNiceText: autoStrip + preclean idempotency on a suspected slice.
//
//   payload: { suspectedText, sliceBytes?, observations? }
//   result:  single verdict-row (knob: 'isNiceText')
export async function runIsNiceTextJob({ suspectedText, sliceBytes, observations }) {
  const opts = {};
  if (typeof sliceBytes === 'number') opts.sliceBytes = sliceBytes;
  if (observations) opts.observations = observations;
  return await runIsNiceTextCheck(suspectedText, opts);
}

// Per-TW-list coverage + must-literals. Structural result; the
// caller (orchestrator) turns this into per-source verdict-rows
// via the same rules eve-worker.js uses today
// (zero-twlist-coverage, etc.).
//
//   payload: { suspectedText, wlistsByKey: Map<twlistName, wlist-SAB> }
//   result:  whatever runVocabCheck returns (totalUnique,
//            uniqueWords: perTwlistCoverage, mustLiterals,
//            candidateCombinations: table, twlistNames)
//
// wlistsByKey values are wlist SAB refs (packed-strings-SAB / NTPS),
// one per twlist source. Wrap each on entry into a `.has(word)` view
// so the existing runVocabCheck API is preserved. The keys are still
// twlist source names ('mit', 'rhyme', etc.), what's keyed is the
// twlist's identity; what's stored is its wordlist projection.
export function runVocabCheckJob({ suspectedText, wlistsByKey }, progress = null) {
  const wrapped = new Map();
  for (const [name, sab] of wlistsByKey) {
    const view = wrapPackedStrings(sab);
    wrapped.set(name, { has: (w) => view.hasSorted(w) });
  }
  return runVocabCheck(suspectedText, wrapped, {
    onProgress: throttleProgress(progress),
  });
}

// Per-corpus subset test for story.vocabulary='corpus'. One job
// per corpus; can run in parallel across cards.
//
//   payload: { suspectedUniqueWords: Set<word>, vocabSab: SAB,
//              corpusName }
//   result:  verdict-row (knob: `story.vocabulary.<corpus>`),
//            attribution via applyRule like the inline path.
//
// vocabSab is the SAB ref produced by load-corpus-precompute
// (packed-strings-sab format, sorted-unique).
export function runCorpusVocabCheckJob({ suspectedUniqueWords, vocabSab, corpusName }) {
  // Null vocab means the corpus precompute failed; treat as
  // empty (no words match -> all suspected words are missing).
  const view = vocabSab ? wrapPackedStrings(vocabSab) : null;
  let missing = 0;
  for (const w of suspectedUniqueWords) {
    if (!view || !view.hasSorted(w)) missing++;
  }
  const allPresent = missing === 0;

  const state = createVerdictState(`story.vocabulary.${corpusName}`);
  if (allPresent) {
    applyRule(state, {
      rule: 'corpus-vocab-superset',
      verdict: 'likely',
      confidence: 0.7,
      why: 'subset of corpus_vocab(X)',
    });
  } else {
    applyRule(state, {
      rule: 'corpus-vocab-missing-words',
      verdict: 'unlikely',
      confidence: 0.8,
      why: `${missing} suspected word(s) not in ${corpusName}.corpus_vocab`,
    });
  }
  return {
    knob: state.knob,
    verdict: state.verdict,
    confidence: state.confidence,
    why: state.why,
    done: true,
    rule: state.rule,
    contradiction: state.contradiction,
    history: state.history,
    data: { missing, totalUnique: suspectedUniqueWords.size, allPresent },
  };
}

// Build the suspected's monotyped-model SAB once. Same path fixture
// corpora use at build time; symmetry by construction. The resulting
// SharedArrayBuffer crosses worker boundaries by reference (no
// structured-clone of N strings per consumer).
//
//   payload: { suspectedText }
//   result:  { monotypedModelSab, totalSuspected }
export async function runBuildSuspectedMonotypedModelJob({ suspectedText }) {
  const built = await genMonotypedModel(suspectedText, { shared: true });
  return {
    monotypedModelSab: built.sab,
    totalSuspected: built.count,
  };
}

// Per-card MonoTypedModelCheck matcher. One job per card; runs in
// parallel across the worker pool. Wraps the suspected's and the
// card's monotyped-model SABs as views (no Map allocation; membership
// uses .hasSorted binary search). Returns the per-card stats the
// orchestrator aggregates.
//
//   payload: {
//     suspectedMonotypedModelSab,
//     card: { name, monotypedModelSab },
//     opts?
//   }
//   result:  per-card stats (see runMonotypedModelCheckPerCard).
export async function runMonotypedModelCheckCardJob({ suspectedMonotypedModelSab, card, opts = {} }, progress = null) {
  const throttled = throttleProgress(progress);
  const suspectedView = wrapMonotypedModel(suspectedMonotypedModelSab);
  const materialized = {
    name: card.name,
    view: wrapMonotypedModel(card.monotypedModelSab),
  };
  return await runMonotypedModelCheckPerCard(suspectedView, materialized, {
    ...opts,
    onProgress: throttled
      ? ({ processed, total }) => throttled(
          `monotyped-model-check-card ${card.name}: scanned ${processed.toLocaleString()}/${total.toLocaleString()} suspected sentences`
        )
      : null,
  });
}
