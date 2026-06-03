// js/src/rewriter/typos.js -- runtime for the typos cover-transform
// rewriter.
//
// Architecture: see `docs/cover-transforms.md`. Sources:
// fixture-src/rewriters/typos/pairs.tsv.gz (28,042 single-word
// {typo, canonical} pairs, MIT-licensed, derived from
// client9/misspell).
//
// Two responsibilities:
//
// 1. The build pipeline (tools/build-rewriter-fixtures.js) emits a
//    shared unique-twlist SAB at fixtures/rewriter-typos.twlist.sab.gz
//    with one 0-bit singleton per unique word appearing on either
//    side of the pair set (~36K entries). Each word's type is
//    `typos_w_<word>`, unique per word; sortdct merges the singleton
//    with any other-source types the same word picks up, but no
//    other word shares the exact type signature, so the merged type
//    stays singleton (0 bits per slot). Swapping canonical <-> typo
//    mid-cover is therefore transparent to the decoder's bit recovery.
//
// 2. apply(phraseBuf) is provided by the shared lookup-swap factory
//    in _lookup-swap.js. The runtime contract is identical to british
//    (and any future pure-lookup rewriter): read just-pushed WORD,
//    look it up in the apply-time NTRW Map, gate on intensity +
//    variant-pick coins, mutate with surface-case preservation.
//
// Modes:
//   forward  (introduce typos). Map<canonical, Set<typos>>
//   reverse  (correct typos)  . Map<typo, {canonical}>
// Both modes flow through the same apply(); jobs.js loads the mode-
// specific NTRW fixture (fixtures/typos-{forward,reverse}.rewriter
// .sab.gz) before encode runs.

import { createLookupSwapRewriter } from './_lookup-swap.js';

const _ = createLookupSwapRewriter();

export const apply                       = _.apply;
export const setRewriterData             = _.setRewriterData;
export const setRewriterIntensity        = _.setRewriterIntensity;
export const setRewriterRandom           = _.setRewriterRandom;
export const _resetRewriterDataForTests  = _._resetRewriterDataForTests;
