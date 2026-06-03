// js/src/reformatter/case.js: model-layer case reformatter.
//
// Architecture: see `docs/cover-transforms.md`. Reformatters mutate
// the sentence model the encoder is about to consume (a flat array
// of `{kind:'type',...}` or `{kind:'punct', value}` items). The
// engine consumes the enhanced model uniformly, so any injected
// state-only punct (`Cap`, `CAPSLOCKON`, `capslockoff`) and any
// re-cased token round-trips via the dict's lowercase normalization.
//
// The function is pure: returns a new array, never mutates input.
//
// Modes:
//   allCaps            strip case state, prefix `CAPSLOCKON`
//   allLowercase       strip case state
//   titleCase          strip case state, prefix each type slot with `Cap`
//   sentenceCase       strip case state, prefix first type slot with `Cap`
//   randomCaps         strip case state, randomly prefix type slots
//   sentenceStartLower drop the leading `Cap` that precedes the first
//                      type slot, leave subsequent `Cap` tokens in place
//                      (proper-noun capitalization survives)
//
// Intensity is a per-type-slot coin flip across every mode. At
// intensity 100 the transform always fires (current pre-intensity
// behavior for the deterministic modes); below 100 each applicable
// type slot independently passes the coin or skips. Matches the
// rewriter convention.

const CASE_PUNCTS = new Set(['Cap', 'CAPSLOCKON', 'capslockoff']);

function isType(it)  { return it.kind === 'type'; }
function isCase(it)  { return it.kind === 'punct' && CASE_PUNCTS.has(it.value); }

function stripCase(model) {
  return model.filter(it => !isCase(it));
}

// Per-call probability gate. Returns true when the transform should
// fire for the current unit. intensity == 100 (or rng absent at <100)
// always-fires; intensity == 0 never-fires.
function passesCoin(intensity, rng) {
  if (intensity >= 100) return true;
  if (intensity <= 0) return false;
  if (!rng) return true; // defensive: no RNG, always fire
  return rng() * 100 < intensity;
}

export function enhance(model, opts) {
  const mode = opts.mode;
  if (!mode) return model;
  const intensity = Number.isInteger(opts.intensity) ? opts.intensity : 100;
  const rng = opts.rng || null;
  if (intensity <= 0) return model;

  if (mode === 'allLowercase') {
    // Per-type-slot coin: keep an explicit `Cap` only when the coin
    // fails. Always strip CAPSLOCKON/capslockoff so the overall
    // shouting state never leaks past a coin failure.
    const out = [];
    for (const it of model) {
      if (it.kind === 'punct' && (it.value === 'CAPSLOCKON' || it.value === 'capslockoff')) continue;
      if (it.kind === 'punct' && it.value === 'Cap') {
        if (!passesCoin(intensity, rng)) out.push(it);
        continue;
      }
      out.push(it);
    }
    return out;
  }

  if (mode === 'allCaps') {
    // Wrap each type slot that passes the coin in
    // CAPSLOCKON/capslockoff. Skipped slots keep their original case
    // state (so subgroups of unaffected text stay readable).
    const out = [];
    for (const it of model) {
      if (it.kind === 'punct' && (it.value === 'CAPSLOCKON' || it.value === 'capslockoff' || it.value === 'Cap')) {
        // Drop the source case markers; the new transform replaces
        // them per-slot below.
        continue;
      }
      if (isType(it) && passesCoin(intensity, rng)) {
        out.push({ kind: 'punct', value: 'CAPSLOCKON' }, it, { kind: 'punct', value: 'capslockoff' });
        continue;
      }
      out.push(it);
    }
    return out;
  }

  if (mode === 'titleCase') {
    const out = [];
    for (const it of stripCase(model)) {
      if (isType(it) && passesCoin(intensity, rng)) {
        out.push({ kind: 'punct', value: 'Cap' });
      }
      out.push(it);
    }
    return out;
  }

  if (mode === 'sentenceCase') {
    const stripped = stripCase(model);
    const out = [];
    let capInserted = false;
    for (const it of stripped) {
      if (!capInserted && isType(it)) {
        if (passesCoin(intensity, rng)) {
          out.push({ kind: 'punct', value: 'Cap' });
        }
        capInserted = true;
      }
      out.push(it);
    }
    return out;
  }

  if (mode === 'randomCaps') {
    // Independent of the global coin: each type slot rolls. Kept as
    // the original p-based gate so existing fixture tests stay
    // stable.
    const p = Math.max(0, Math.min(1, intensity / 100));
    const stripped = stripCase(model);
    const out = [];
    for (const it of stripped) {
      if (isType(it) && rng && rng() < p) {
        out.push({ kind: 'punct', value: 'Cap' });
      }
      out.push(it);
    }
    return out;
  }

  if (mode === 'sentenceStartLower') {
    const out = [];
    let droppedLeadingCap = false;
    let seenType = false;
    for (const it of model) {
      if (!droppedLeadingCap && !seenType
          && it.kind === 'punct' && it.value === 'Cap'
          && passesCoin(intensity, rng)) {
        droppedLeadingCap = true;
        continue;
      }
      if (isType(it)) seenType = true;
      out.push(it);
    }
    return out;
  }
  throw new Error(`reformatter/case: unknown mode ${JSON.stringify(mode)}`);
}
