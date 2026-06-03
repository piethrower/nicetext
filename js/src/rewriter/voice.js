// js/src/rewriter/voice.js -- runtime for the voice cover-transform
// rewriter.
//
// Architecture: see `docs/cover-transforms.md`. Sources:
// fixture-src/rewriters/voice/<mode>/pairs.tsv.gz (`canonical\treplacement`
// per line, single-token-safe). Each mode ships its own NTRW fixture
// `fixtures/voice-<mode>.rewriter.sab.gz`; one shared singleton twlist
// `fixtures/rewriter-voice.twlist.sab.gz` carries the union of words
// across all modes (same shape as `rewriter-british.twlist.sab.gz`).
// The twlist's type-per-word is `voice_w_<word>`, unique across the
// pair universe so sortdct's merge keeps every word singleton (0-bit
// slot) even when the per-mode reformatter twlist contributes the same
// word under a different type name.
//
// Two byos fields coexist independently:
//   byos.reformatter.voice : model-layer inserts (opener/closer/aside/
//                              sprinkle), handled by reformatter/voice.js
//   byos.rewriter.voice    : phraseBuf-layer canonical → variant swap,
//                              handled here
// The two never share state or dispatch. A user can enable one without
// the other; modes may differ between layers.
//
// Modes (multimodal):
//   pirate (today). Future: valleygirl, surfer, flapper, cockney,
//   brooklynese, neutral, cat, dog, each ships when its pairs.tsv.gz
//   is hand-authored and the byos.js REWRITER_MODES.voice set grows.
// jobs.js loads `fixtures/voice-<mode>.rewriter.sab.gz` before encode
// runs; the runtime apply() is mode-agnostic, it just consults
// whatever Map setRewriterData() handed it.

import { createLookupSwapRewriter } from './_lookup-swap.js';

const _ = createLookupSwapRewriter();

export const apply                       = _.apply;
export const setRewriterData             = _.setRewriterData;
export const setRewriterIntensity        = _.setRewriterIntensity;
export const setRewriterRandom           = _.setRewriterRandom;
export const _resetRewriterDataForTests  = _._resetRewriterDataForTests;
