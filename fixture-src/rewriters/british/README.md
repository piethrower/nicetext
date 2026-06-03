# british rewriter, placeholder

Stub directory. The `british` rewriter substitutes American
spellings for British ones (color → colour, organize → organise,
etc.). Intended steganographic effect: cover reads as
British-English authored.

This directory is empty; the runtime stub lives at
`js/src/rewriter/british.js` and returns `[]` from
`getRewriterUniqueTwlist()` with a no-op `apply()`. The byos.json
field `rewriter.british` exists in the schema (default `false`).

Real implementation, when picked up:

- `pairs.json` or similar: American-British spelling pairs
  (hundreds of entries per `docs/cover-transforms.md`).
- `fetch.js`: if pairs are externally sourced; may be omitted if
  curated in-repo.
- Build hook in `tools/build-rewriter-fixtures.js` to emit
  `fixtures/british.data.js` as `Map<american, british>`.
- `js/src/rewriter/british.js`: real `getRewriterUniqueTwlist()`
  returning one singleton per British variant, real
  `apply(phraseBuf)` with the substitution logic.

Bidirectional capability is a future enhancement: the field type
may upgrade from boolean to `"none" | "introduce" | "remove"`.

See `docs/cover-transforms.md` for the four-block architecture,
safety guidelines (british must satisfy Guideline 1: 0-bit
unique-type WORD substitution), and the rewriter interface contract.
