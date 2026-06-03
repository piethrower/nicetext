// js/src/reformatter/index.js: model-stream wrapper that runs every
// enabled reformatter (`voice` -> `lineBreak` -> `sentenceEnd` ->
// `case`) over each model the underlying stream produces. Each
// enhancer is a pure `model -> model` function; chain composition is
// just left-to-right reduction.
//
// Chain order matters: `case` runs LAST so the surface-case transform
// (allCaps, titleCase, …) observes content inserted by `voice` and
// any earlier enhancer. The other three are commutative, voice
// inserts new content, lineBreak modifies whitespace, sentenceEnd
// swaps periods, none of them race.
//
// Usage from encode.js:
//
//   const enhancedStream = wrapModelStreamWithReformatters(
//     modelStream, byos.reformatter, rng);
//   ...
//   const model = enhancedStream.next({ forceDynamic });
//
// When `byos.reformatter` is absent or every field is disabled, the
// wrapper short-circuits and returns the input stream as-is, zero
// per-model cost.

import * as caseRf        from './case.js';
import * as lineBreakRf   from './lineBreak.js';
import * as sentenceEndRf from './sentenceEnd.js';
import * as voiceRf       from './voice.js';

const REFORMATTER_CHAIN = [
  ['voice',       voiceRf],
  ['lineBreak',   lineBreakRf],
  ['sentenceEnd', sentenceEndRf],
  ['case',        caseRf],
];

function isActive(field) {
  return field
    && typeof field === 'object'
    && field.enabled === true
    && Number.isInteger(field.intensity)
    && field.intensity > 0;
}

// Per-encode setup for reformatters that need apply-time data
// (today: voice). For each enabled reformatter, dispatch:
//   setRewriterData(reformatterData[name])  when both module exposes
//                                           the setter and data was
//                                           supplied; else null.
//   setRewriterIntensity(cfg.intensity)     when module exposes it.
//   setRewriterRandom(rng)                  when module exposes it.
//   setRewriterDict(dict)                   for reformatters whose
//                                           apply-time data
//                                           references the active
//                                           dict (voice resolves
//                                           word -> typeIndex).
// Modules without a setter are skipped silently. Identical surface
// to the rewriter-chain dispatch in encode.js so each module's wiring
// is uniform.
export function dispatchReformatterSetup(reformatter, reformatterData, rng, dict) {
  if (!reformatter || typeof reformatter !== 'object') return;
  for (const [name, mod] of REFORMATTER_CHAIN) {
    const cfg = reformatter[name];
    if (!cfg || cfg.enabled !== true) continue;
    if (typeof mod.setRewriterData === 'function') {
      const data = reformatterData && reformatterData[name] ? reformatterData[name] : null;
      mod.setRewriterData(data);
    }
    if (typeof mod.setRewriterIntensity === 'function'
        && Number.isInteger(cfg.intensity)) {
      mod.setRewriterIntensity(cfg.intensity);
    }
    if (typeof mod.setRewriterRandom === 'function') {
      mod.setRewriterRandom(rng);
    }
    if (typeof mod.setRewriterDict === 'function') {
      mod.setRewriterDict(dict || null);
    }
  }
}

export function wrapModelStreamWithReformatters(stream, reformatter, rng) {
  if (!reformatter || typeof reformatter !== 'object') return stream;
  const active = REFORMATTER_CHAIN.filter(([name]) => isActive(reformatter[name]));
  if (active.length === 0) return stream;
  return {
    next(opts) {
      let model = stream.next(opts);
      for (const [name, mod] of active) {
        const cfg = reformatter[name];
        model = mod.enhance(model, { mode: cfg.mode, intensity: cfg.intensity, rng });
      }
      return model;
    },
  };
}
