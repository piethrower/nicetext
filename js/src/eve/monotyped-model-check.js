// MonoTypedModelCheck: Eve detector that walks the suspected's
// monotyped model (MM) against each card's monotyped model. One
// detector, three verdict knobs:
//   story.style.<name>: coveredHits/totalSuspected rate (per card).
//   story.sentence:     top card's matchDepth/totalSuspected rate
//                       (random vs sequential).
//   phrases:            top card's variant-only vs raw rate
//                       (phrase-augment signal).
//
// The monotyped model (MM) is the output of genmodel(text, metaDict)
// where metaDict maps every word to one type (MONO_TYPE = 'g').
// Punctuation, EOS, and case markers survive verbatim; the typed
// word slots collapse to a single placeholder. Per corpus or per
// suspected, the data is one packed NTMM SAB carrying the MM unique
// pool + ordered index AND a collapsed monotyped model (CMM) pool
// where every run of consecutive 'g' parts has been collapsed to a
// single 'g'. The CMM is the canonical representative of the phrase-
// augment equivalence class; match-by-CMM is the phrase-augment-
// tolerant predicate (no per-sentence variant enumeration required).
//
// Algorithm:
//   1. genMonotypedModel(suspected) -> suspected NTMM view S.
//   2. Per card c: NTMM view C (precomputed fixture, loaded once).
//   3. While iterating S.at(i):
//      3a. Sequential lock-step (alive cards only): scan C.at(j..)
//          looking for S.at(i). First pass: exact MM equality.
//          Second pass: CMM equality (S.cmmAtOrdered(i) ===
//          C.cmmAtOrdered(p)). Either pass advances j; exact bumps
//          exactSeqMatches, CMM-only bumps phraseSeqMatches. Miss
//          freezes the card.
//      3b. Non-sequential membership: rawHits++ if C.hasSorted(MM);
//          coveredHits++ if C.cmmHasSorted(CMM); anyVariantHits =
//          coveredHits - rawHits is the phrase-augment-only count.
//          Two binary searches per suspected sentence.
//   4. Aggregate per-card stats into the three knob verdicts.
//
// Progressive: yields between batches so the UI / cancel can
// interrupt. Card-side fixtures are loaded once per session.
//
// Type-blind by construction (engine tenet: aug passes operate on
// type->values graphs, never type-string introspection).
//
// genmodel is called as-is via its resolveWord option. Engine
// boundary preserved.
//
// Browser-safe ESM. No Node deps.

import { generateModelTable } from '../builder/genmodel.js';
import { createVerdictState, applyRule } from './verdict-state.js';
import { packMonotypedModel, wrapMonotypedModel, MONO_TYPE } from './monotyped-model-sab.js';

// Turn one model entry's tokens into one monotyped-sentence string.
// Numbers (type-slot indexes) collapse to MONO_TYPE ('g'); strings
// (punct/EOS literals/case markers) stay verbatim. Joined by '|'
// for a deterministic representation.
//
// `casefree` true strips the three case-marker puncts ('Cap',
// 'CAPSLOCKON', 'capslockoff') from the token stream before joining,
// producing a representation that's invariant under any case
// reformatter. Eve uses this when comparing a case-reformatted cover
// against a reference corpus.
const CASE_MARKER_PUNCTS = new Set(['Cap', 'CAPSLOCKON', 'capslockoff']);
function monotypeSentenceTokens(tokens, casefree = false) {
  const parts = [];
  for (const t of tokens) {
    if (typeof t === 'number') { parts.push(MONO_TYPE); continue; }
    if (casefree && CASE_MARKER_PUNCTS.has(t)) continue;
    parts.push(t);
  }
  return parts.join('|');
}

// Generate the monotyped model of a text (fixture corpus or
// suspected) into one packed NTMM SAB. The single function is the
// only path for fixture corpora at build time AND the suspected at
// runtime, so any tokenization quirk (greedy EOS, case markers,
// quoted-literal fallback) applies symmetrically by construction.
//
// Pipeline:
//   1. generateModelTable(text, metaDict, { resolveWord: () => 'g',
//      dedupe: false }) - dedupe=false preserves sentence order.
//   2. Monotype each model entry's tokens into one MM string.
//   3. packMonotypedModel(orderedSentences) builds the MM unique
//      pool + ordered index + CMM unique pool + per-unique-MM CMM
//      index into one SAB.
//
// Inputs:
//   text          the raw text (fixture corpus or suspected).
//   opts.shared   true -> SharedArrayBuffer (runtime, cross-worker).
//                 Default false -> ArrayBuffer (build-time, gz to disk).
//   opts.casefree true -> strip case-marker puncts ({Cap}, {CAPSLOCKON},
//                 {capslockoff}) before monotyping. The resulting MM is
//                 invariant under any case reformatter, so Eve can
//                 compare a case-reformatted cover against an
//                 unreformatted corpus without spurious mismatches.
//
// Output:
//   { sab, count, uniqueCount, cmmUniqueCount }
//   The SAB is the NTMM packed form. Consumers wrap with
//   wrapMonotypedModel to get positional .at(i), binary-search
//   .hasSorted(s), CMM lookups, and cross-sab match helpers.
export async function genMonotypedModel(text, opts = {}) {
  const shared = opts.shared === true;
  const casefree = opts.casefree === true;
  const metaDict = { phraseIndex: new Map(), maxPhraseLen: 0 };
  const table = await generateModelTable(text, metaDict, {
    resolveWord: () => MONO_TYPE,
    dedupe: false,
  });
  const ordered = table.models.map(m => monotypeSentenceTokens(m.tokens, casefree));
  const sab = packMonotypedModel(ordered, { shared });
  const view = wrapMonotypedModel(sab);
  return {
    sab,
    count: view.orderedCount,
    uniqueCount: view.uniqueCount,
    cmmUniqueCount: view.cmmUniqueCount,
  };
}

// Per-card single-pass matcher. Walks the suspected's monotyped
// model and, for each suspected[i]:
//   (a) Sequential lock-step: scan card's ordered side from position
//       j up to j+FORCE_DYNAMIC_SKIP_BUDGET looking for a match.
//       First pass: exact MM equality (cardView.at(p) === cs).
//       Second pass (only if exact missed): CMM equality
//       (cardView.cmmAtOrdered(p) === csCmm). EITHER pass advancing
//       counts as a match: exact bumps exactSeqMatches, CMM-only
//       bumps phraseSeqMatches. Miss kills sequentialAlive.
//   (b) Non-sequential membership: rawHit if suspected[i]'s MM is in
//       card's MM unique pool (cardView.hasSorted). coveredHit if
//       suspected[i]'s CMM is in card's CMM unique pool
//       (cardView.cmmHasSorted). anyVariantHit = coveredHit AND NOT
//       rawHit, the phrase-augment-only fraction. Two binary searches
//       per suspected sentence, no per-sentence variant enumeration.
//
// Inputs:
//   suspectedView  wrapMonotypedModel view of the suspected.
//   card           { name, view } where view is wrapMonotypedModel
//                  of the card's corpus precompute.
//   opts           { batchSize, onProgress, forceDynamicSkipBudget }
//
// Output: { name, j, matchDepth, sequentialAlive, exactSeqMatches,
//           phraseSeqMatches, rawHits, anyVariantHits, coveredHits }.
export async function runMonotypedModelCheckPerCard(suspectedView, card, opts = {}) {
  const batchSize = opts.batchSize ?? 4096;
  const onProgress = opts.onProgress ?? null;
  const FORCE_DYNAMIC_SKIP_BUDGET = opts.forceDynamicSkipBudget ?? 256;

  const s = {
    name: card.name,
    j: 0,
    matchDepth: 0,
    sequentialAlive: true,
    exactSeqMatches: 0,
    phraseSeqMatches: 0,
    rawHits: 0,
    anyVariantHits: 0,
    coveredHits: 0,
  };

  const cardView = card.view;
  const orderedCount = cardView.orderedCount;
  const totalSuspected = suspectedView.orderedCount;

  for (let i = 0; i < totalSuspected; i++) {
    const cs = suspectedView.at(i);

    if (s.sequentialAlive) {
      let found = -1;
      let foundViaVariant = false;
      const limit = Math.min(s.j + FORCE_DYNAMIC_SKIP_BUDGET + 1, orderedCount);
      for (let p = s.j; p < limit; p++) {
        if (cardView.at(p) === cs) { found = p; break; }
      }
      if (found === -1) {
        const csCmm = suspectedView.cmmAtOrdered(i);
        for (let p = s.j; p < limit; p++) {
          if (cardView.cmmAtOrdered(p) === csCmm) {
            found = p; foundViaVariant = true; break;
          }
        }
      }
      if (found !== -1) {
        if (foundViaVariant) s.phraseSeqMatches++;
        else s.exactSeqMatches++;
        s.j = found + 1;
        s.matchDepth = s.exactSeqMatches + s.phraseSeqMatches;
      } else {
        s.sequentialAlive = false;
      }
    }

    const rawHit = cardView.hasSorted(cs);
    if (rawHit) s.rawHits++;
    const coveredHit = rawHit || cardView.cmmHasSorted(suspectedView.cmmAtOrdered(i));
    if (coveredHit) s.coveredHits++;
    if (coveredHit && !rawHit) s.anyVariantHits++;

    // Emit progress every iteration; the outer throttle in
    // job-handlers.js (throttleProgress, 1s window) keeps the
    // postMessage rate down. Gating on `% batchSize` here is what
    // caused the "locked up" UI on suspecteds below batchSize sentences
    // (most real-world suspecteds): the row label was set once on
    // worker-busy and never refreshed because the modulo never
    // triggered. Macrotask yield stays gated at batchSize so engine
    // responsiveness is unchanged.
    if (onProgress) {
      try {
        await onProgress({ processed: i + 1, total: totalSuspected });
      } catch {}
    }
    if ((i + 1) % batchSize === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return s;
}

// Aggregate per-card stats into the verdict envelope. Pure
// derivation; no compute over the suspected beyond the already-built
// stats. Caller passes the assembled per-card stats array (any
// order) and the total suspected-shape count.
export function aggregateMonotypedModelVerdicts(perCardStats, totalSuspected, opts = {}) {
  const minShapes = opts.minShapes ?? 20;
  const likelyThreshold = opts.likelyThreshold ?? 0.5;
  const unlikelyThreshold = opts.unlikelyThreshold ?? 0.05;
  const sequentialLikelyThreshold = opts.sequentialLikelyThreshold ?? 0.8;
  const sequentialUnlikelyThreshold = opts.sequentialUnlikelyThreshold ?? 0.2;

  const stats = perCardStats;
  const verdicts = [];

  for (const s of stats) {
    const knob = `story.style.${s.name}`;
    const state = createVerdictState(knob);
    const data = {
      rawHits: s.rawHits,
      anyVariantHits: s.anyVariantHits,
      coveredHits: s.coveredHits,
      totalSuspected,
      matchDepth: s.matchDepth,
      exactSeqMatches: s.exactSeqMatches,
      phraseSeqMatches: s.phraseSeqMatches,
    };
    if (totalSuspected < minShapes) {
      verdicts.push(packMonotypedModelVerdict(state, {
        confidence: 0.3,
        why: `only ${totalSuspected} suspected sentences, need ${minShapes}+`,
        data: { ...s, totalSuspected },
      }));
      continue;
    }
    const rate = s.coveredHits / totalSuspected;
    const directRate = s.rawHits / totalSuspected;
    const why = `${s.rawHits} raw + ${s.anyVariantHits} variant / ${totalSuspected} (covered ${rate.toFixed(2)})`;
    if (rate >= likelyThreshold) {
      applyRule(state, {
        rule: 'style-shape-coverage-above-likely',
        verdict: 'likely',
        confidence: Math.min(0.9, rate),
        why,
      });
    } else if (rate <= unlikelyThreshold) {
      applyRule(state, {
        rule: 'style-shape-coverage-below-unlikely',
        verdict: 'unlikely',
        confidence: 0.7,
        why,
      });
    }
    // Else: stays 'unknown'. Between-thresholds is honest abstention.
    verdicts.push(packMonotypedModelVerdict(state, {
      confidence: 0.4,
      why: state.why || `${why} (between thresholds)`,
      data: { ...data, rate, directRate },
    }));
  }

  if (totalSuspected >= minShapes) {
    const ranked = [...stats].sort((a, b) => b.coveredHits - a.coveredHits);
    const top = ranked[0];
    const topDirectRate = top.rawHits / totalSuspected;
    const topVariantOnlyRate = (top.coveredHits - top.rawHits) / totalSuspected;

    // phrases verdict.
    {
      const state = createVerdictState('phrases');
      const data = { top: top.name, directRate: topDirectRate, variantOnlyRate: topVariantOnlyRate };
      if (topDirectRate >= likelyThreshold) {
        applyRule(state, {
          rule: 'top-card-raw-rate-high-no-phrases-needed',
          verdict: 'unlikely',
          confidence: 0.7,
          why: `top card ${top.name} raw rate ${topDirectRate.toFixed(2)}; no phrase compression needed`,
        });
      } else if (topVariantOnlyRate > topDirectRate && top.anyVariantHits > 0) {
        applyRule(state, {
          rule: 'top-card-variant-rate-exceeds-raw',
          verdict: 'likely',
          confidence: 0.65,
          why: `top card ${top.name} fits via phrase variants (variant-only ${topVariantOnlyRate.toFixed(2)} > raw ${topDirectRate.toFixed(2)})`,
        });
      }
      // Else: stays 'unknown'.
      verdicts.push(packMonotypedModelVerdict(state, {
        confidence: 0.4,
        why: state.why || `top card ${top.name} signal too weak to decide phrases`,
        data,
      }));
    }

    // story.sentence verdict.
    {
      const state = createVerdictState('story.sentence');
      const seqRate = top.matchDepth / totalSuspected;
      const baseData = { top: top.name, matchDepth: top.matchDepth, totalSuspected, seqRate };
      if (seqRate >= sequentialLikelyThreshold) {
        applyRule(state, {
          rule: 'sequential-skip-ahead-likely',
          verdict: 'likely',
          confidence: 0.8,
          why: `top card ${top.name} skip-ahead matchDepth ${top.matchDepth}/${totalSuspected} (rate ${seqRate.toFixed(2)}); mode looks sequential`,
        });
        verdicts.push(packMonotypedModelVerdict(state, { data: { ...baseData, mode: 'sequential' } }));
      } else if (seqRate <= sequentialUnlikelyThreshold) {
        applyRule(state, {
          rule: 'sequential-skip-ahead-unlikely',
          verdict: 'unlikely',
          confidence: 0.7,
          why: `top card ${top.name} skip-ahead matchDepth ${top.matchDepth}/${totalSuspected} (rate ${seqRate.toFixed(2)}); mode looks random`,
        });
        verdicts.push(packMonotypedModelVerdict(state, { data: { ...baseData, mode: 'random' } }));
      } else {
        verdicts.push(packMonotypedModelVerdict(state, {
          confidence: 0.4,
          why: `top card ${top.name} skip-ahead matchDepth ${top.matchDepth}/${totalSuspected} (rate ${seqRate.toFixed(2)}, between thresholds)`,
          data: baseData,
        }));
      }
    }
  }

  return { verdicts, totalSuspected, perCard: stats };
}

// Convenience: one-shot wrapper that runs genMonotypedModel,
// runMonotypedModelCheckPerCard per card sequentially, and
// aggregateMonotypedModelVerdicts. Used by tests. The orchestrator's
// multi-worker path calls the three primitives directly via the
// `build-suspected-monotyped-model` and `monotyped-model-check-card`
// jobs.
//
// `cards` accepts two shapes:
//   { name, corpusText }              (raw corpus; SAB built inline)
//   { name, sab }                     (pre-packed NTMM SAB; e.g.,
//                                      from a fixture)
export async function runMonotypedModelCheck(suspectedText, cards, opts = {}) {
  const suspected = await genMonotypedModel(suspectedText);
  const suspectedView = wrapMonotypedModel(suspected.sab);
  const perCardStats = [];
  for (const card of cards) {
    let sab = card.sab;
    if (!sab) {
      sab = (await genMonotypedModel(card.corpusText)).sab;
    }
    const matCard = { name: card.name, view: wrapMonotypedModel(sab) };
    perCardStats.push(await runMonotypedModelCheckPerCard(suspectedView, matCard, opts));
  }
  return aggregateMonotypedModelVerdicts(perCardStats, suspected.count, opts);
}

// Pack a VerdictState into the standard verdict envelope used by
// the worker. Fallback fields fill in for the 'unknown' case where
// no rule applied (abstention is honest, not a verdict).
function packMonotypedModelVerdict(state, fallback = {}) {
  return {
    knob: state.knob,
    verdict: state.verdict,
    confidence: state.verdict === 'unknown' ? (fallback.confidence ?? 0) : state.confidence,
    why: state.why || fallback.why || '',
    done: true,
    data: fallback.data,
    rule: state.rule,
    contradiction: state.contradiction,
    history: state.history,
  };
}
