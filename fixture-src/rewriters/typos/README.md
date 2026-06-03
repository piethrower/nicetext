# typos rewriter, placeholder

Stub directory. The `typos` rewriter substitutes canonical words for
common typo variants (the → teh / het / eth, you → yuo, etc.).
Intended steganographic effect: cover reads as if a human typo'd,
plausible-by-default, zero bit cost (every variant is a 0-bit
unique-type singleton).

This directory is empty; the runtime stub lives at
`js/src/rewriter/typos.js` and returns `[]` from
`getRewriterUniqueTwlist()` with a no-op `apply()`. The byos.json
field `rewriter.typos` exists in the schema (default `false`).

Real implementation, when picked up:

- Curated typo dataset (per-canonical Set of variants).
- `fetch.js`: if the dataset is externally sourced.
- Build hook in `tools/build-rewriter-fixtures.js` to emit either
  `fixtures/typos.data.js` (baked JS, if entries < ~1K) or
  `fixtures/typos.lookup.sab.gz` (shared SAB, for larger datasets)
  per the storage threshold in `docs/cover-transforms.md`.
- `js/src/rewriter/typos.js`: `getRewriterUniqueTwlist()` returning
  one singleton per `(canonical, variant)` pair using the
  `typo_word_<canonical>_<variant>` type-naming convention, real
  `apply(phraseBuf)` mutating to a randomly-picked variant (RNG
  draw, not payload bits, so all variants round-trip identically).

Bidirectional capability is a future enhancement.

See `docs/cover-transforms.md` for the four-block architecture,
safety guidelines (typos must satisfy Guideline 1: 0-bit unique-type
WORD substitution), and the rewriter interface contract.
