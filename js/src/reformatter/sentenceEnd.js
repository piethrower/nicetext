// js/src/reformatter/sentenceEnd.js: model-layer sentence-end reformatter.
//
// Swaps `.` for `?` (uptalk) or `!` (excitement) inside `^...^`
// quoted-literal puncts. genmodel.js wraps every EOS in `^...^`
// (preserving the terminator + trailing whitespace byte-for-byte),
// so this targets sentence-terminal periods specifically, bare
// mid-sentence periods (e.g. `Dr.`, `etc.`) stored as raw `.` puncts
// pass through untouched.
//
// Modes:
//   uptalk      `.` to `?`
//   excitement  `.` to `!`
//
// Intensity drives the per-EOS coin flip (probability % that any
// given sentence-terminal period swaps). The non-secret RNG is
// supplied per encode by the engine so cover output stays
// deterministic across runs with the same seed.

const REPLACE = { uptalk: '?', excitement: '!' };

export function enhance(model, opts) {
  const mode = opts.mode;
  if (!mode) return model;
  const replacement = REPLACE[mode];
  if (!replacement) {
    throw new Error(`reformatter/sentenceEnd: unknown mode ${JSON.stringify(mode)}`);
  }
  const intensity = Number.isInteger(opts.intensity) ? opts.intensity : 0;
  if (intensity <= 0) return model;
  return model.map(it => {
    if (it.kind !== 'punct') return it;
    const v = it.value;
    if (v.length < 2 || v[0] !== '^' || v[v.length - 1] !== '^') return it;
    const inner = v.slice(1, -1);
    if (!inner.includes('.')) return it;
    if (intensity < 100) {
      if (!opts.rng) return it;
      if (opts.rng() * 100 >= intensity) return it;
    }
    return { ...it, value: '^' + inner.replace(/\./g, replacement) + '^' };
  });
}
