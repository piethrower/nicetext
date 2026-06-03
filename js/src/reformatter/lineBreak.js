// js/src/reformatter/lineBreak.js: model-layer lineBreak reformatter.
//
// Mutates whitespace inside `^...^` quoted-literal puncts (the form
// genmodel uses to preserve corpus whitespace and EOS terminators
// byte-for-byte). Other punct shapes (`Cap`, single-char inline
// directives like `n`) are left untouched.
//
// Modes:
//   expand    every `\n` to `\n\n` (per-newline coin flip)
//   collapse  every `\n\n+` to `\n` (per-run coin flip)
//
// Intensity is a per-newline (or per-run) coin: at intensity 100 the
// transform always fires; below 100 each candidate independently
// passes the coin or stays as-is.

function mutateLiteralWhitespaceCoin(model, transform) {
  return model.map(it => {
    if (it.kind !== 'punct') return it;
    const v = it.value;
    if (v.length < 2 || v[0] !== '^' || v[v.length - 1] !== '^') return it;
    const inner = v.slice(1, -1);
    if (!inner.includes('\n')) return it;
    return { ...it, value: '^' + transform(inner) + '^' };
  });
}

export function enhance(model, opts) {
  const mode = opts.mode;
  if (!mode) return model;
  const intensity = Number.isInteger(opts.intensity) ? opts.intensity : 100;
  if (intensity <= 0) return model;
  const rng = opts.rng || null;
  const fire = () => {
    if (intensity >= 100) return true;
    if (!rng) return true;
    return rng() * 100 < intensity;
  };

  if (mode === 'expand') {
    return mutateLiteralWhitespaceCoin(model, s =>
      s.replace(/\n/g, () => (fire() ? '\n\n' : '\n')));
  }
  if (mode === 'collapse') {
    return mutateLiteralWhitespaceCoin(model, s =>
      s.replace(/\n\n+/g, (run) => (fire() ? '\n' : run)));
  }
  throw new Error(`reformatter/lineBreak: unknown mode ${JSON.stringify(mode)}`);
}
