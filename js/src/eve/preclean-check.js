// Eve isNiceText detector. Two paths:
//
//   1. Wrapper-residue short-circuit (only when Cover-Story
//      observations are present). If detectedLayers.length >
//      appliedLayers.length, the suspected bytes still carry
//      unstripped wrapper layers, they cannot be the bare cover a
//      NiceText engine emits. Strong 'unlikely' verdict; no preclean
//      pass needed.
//
//   2. Preclean idempotency (always runs when no wrapper residue
//      signal). autoStrip the suspected, run precleanCorpus on a
//      slice of the bare bytes, compare byte-for-byte.
//
// Reasoning for path 2:
//   Dict entries enter the engine post-preclean (corpus is precleaned
//   before genmodel and listword see it), and precleanCorpus is
//   idempotent on its outputs (loops until no change, see
//   precleanCorpus.js:9). So bytes a real NiceText engine emits
//   should already be preclean-stable. If preclean changes the bare
//   suspected, the suspected almost certainly was not produced by NiceText.
//
// Asymmetric signal:
//   verdict 'unlikely'  is a strong negative (~0.9 confidence).
//   verdict 'likely'    is a weak positive  (~0.5 confidence): plenty
//                        of non-NiceText text is also preclean-stable.
//   verdict 'unknown'   when the slice has too few bytes to be
//                        confident either way.
//
// Like every other knob, supports manual override ("ignore this
// check") via the standard Phase I override mechanism.
//
// Browser-safe ESM. No Node deps. Uses autoStrip and precleanCorpus
// as-is (engine boundary preserved).

import { autoStrip } from '../cover-pipeline.js';
import { precleanCorpus } from '../builder/precleanCorpus.js';
import { createVerdictState, applyRule } from './verdict-state.js';

const DEFAULT_SLICE_BYTES = 65536;
const MIN_BYTES_FOR_CONFIDENT_VERDICT = 256;

export async function runIsNiceTextCheck(rawText, opts = {}) {
  const sliceBytes = opts.sliceBytes ?? DEFAULT_SLICE_BYTES;
  const minBytes = opts.minBytes ?? MIN_BYTES_FOR_CONFIDENT_VERDICT;
  const observations = opts.observations || null;

  // Path 1: wrapper-residue short-circuit. Uses Cover-Story-side
  // observations (what was detected by autoStrip on the raw input
  // vs what the developer chose to peel). If layers were detected
  // but not all peeled, the bytes Eve sees still carry wrappers,
  // not a candidate for a bare NiceText cover.
  if (observations
    && Array.isArray(observations.detectedLayers)
    && Array.isArray(observations.appliedLayers)
    && observations.detectedLayers.length > observations.appliedLayers.length) {
    const detected = observations.detectedLayers;
    const applied = observations.appliedLayers;
    const residue = detected.slice(applied.length);
    const state = createVerdictState('isNiceText');
    applyRule(state, {
      rule: 'unstripped-wrapper-residue',
      verdict: 'unlikely',
      confidence: 0.95,
      why: `suspected still wrapped by ${residue.length} layer(s) [${residue.join(', ')}]; ` +
           `Cover Story detected ${detected.length} [${detected.join(', ')}], peeled ${applied.length} [${applied.join(', ') || '<none>'}]`,
    });
    return finalizeState(state);
  }

  // autoStrip needs a ReadableStream<Uint8Array>. Build one from the
  // raw text via TextEncoder. autoStrip returns either the original
  // stream (no wrapper detected) or a stripped output stream.
  const inputBytes = new TextEncoder().encode(rawText);
  const input = new ReadableStream({
    start(c) { if (inputBytes.length) c.enqueue(inputBytes); c.close(); },
  });
  const stripped = await autoStrip(input);

  // Read up to sliceBytes from the stripped stream.
  const reader = stripped.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < sliceBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
    try { await stripped.cancel(); } catch {}
  }

  // Concatenate up to sliceBytes.
  const collected = new Uint8Array(Math.min(total, sliceBytes));
  let off = 0;
  for (const c of chunks) {
    const room = collected.length - off;
    if (room <= 0) break;
    const slice = c.length > room ? c.subarray(0, room) : c;
    collected.set(slice, off);
    off += slice.length;
  }

  const bareText = new TextDecoder('utf-8', { fatal: false }).decode(collected);

  const state = createVerdictState('isNiceText');

  if (bareText.length < minBytes) {
    // No rule fires; verdict stays 'unknown'. Slice-too-small is an
    // honest abstention, not a verdict.
    return finalizeState(state, {
      confidence: 0.3,
      why: `slice too small for confident verdict (${bareText.length} chars, min ${minBytes})`,
    });
  }

  const precleaned = precleanCorpus(bareText);
  if (precleaned === bareText) {
    applyRule(state, {
      rule: 'preclean-idempotent',
      verdict: 'likely',
      confidence: 0.5,
      why: `preclean idempotent on ${bareText.length}-char slice`,
    });
  } else {
    applyRule(state, {
      rule: 'preclean-changed-bytes',
      verdict: 'unlikely',
      confidence: 0.9,
      why: `preclean changed bytes (${bareText.length} -> ${precleaned.length} chars on slice)`,
    });
  }
  return finalizeState(state);
}

// Pack the verdict-state into the {knob, verdict, ...} envelope the
// worker expects, including the attribution fields (`rule`,
// `contradiction`, `history`).
function finalizeState(state, fallback = {}) {
  return {
    knob: state.knob,
    verdict: state.verdict,
    confidence: state.verdict === 'unknown' ? (fallback.confidence ?? 0) : state.confidence,
    why: state.why || fallback.why || '',
    done: true,
    rule: state.rule,
    contradiction: state.contradiction,
    history: state.history,
  };
}
