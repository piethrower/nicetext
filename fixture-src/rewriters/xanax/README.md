# xanax rewriter

Cover-transform rewriter for per-emission a/an agreement correction.
Named for the calming effect of grammatically natural articles in
the cover text.

## What it does

When a sentence emits the article "a" or "an" followed by another
word, English orthography says "a" before consonants and "an" before
vowels. The rewriter watches the encoder's `phraseBuf`; when the
slot just before the most-recent emission holds an article and the
most-recent emission is a word, the rewriter mutates the article to
whichever form agrees with the next word's leading letter
(strict-orthographic rule: [aeiou] → "an", else "a").

Both articles are 0-bit unique-type singletons in the dict (`xanax_a`
holding `a`, `xanax_an` holding `an`), so swapping in cover does not
perturb the decoded bitstream. Phrase-fusion conflicts created or
destroyed by the swap are caught by the engine's natural per-push
`analyzePhraseBuf` rewind path; the rewriter does no phrase-fusion
check of its own.

## Layout

Runtime: `js/src/rewriter/xanax.js`
Architecture: `docs/cover-transforms.md` (rewriter category,
Guideline 1: 0-bit unique-type WORD substitution).

This directory holds the research and audit material:

- `research.md`: full a/an design research (three phases,
  methodology, all 8 findings, design recommendation, open
  decisions). Originally `docs/aan-agreement-research.md`.
- `lib.js`: shared scan / classify primitives used by the
  three CLIs below. Originally `tools/aan-lib.js`.
- `inspect.js`: single-text a/an inspector (stdin → JSON). Used
  for fixture curation, Eve baseline calibration, Eve detection
  input. Originally `tools/aan.js`.
- `derive-exceptions.js`: Phase 1 CMU classifier; produces
  exception sets (an-exceptions, a-exceptions) with frequency
  tiers and coverage curves. Originally `tools/aan-cmu.js`.
- `corpus-sweep.js`: Phase 2 + 3 corpus comparison (strict-ortho
  vs liberal-ortho vs cmu-phonology), seedable Gutenberg sampler,
  coverage-gap categorization, fallback-accuracy measurement.
  Originally `tools/aan-corpus-sweep.js`.

## Current capability

Strict-orthographic rule via `apply(phraseBuf)`. Examples:

- "a apple" → "an apple"
- "an cat" → "a cat"
- "a hour" → kept as "a hour" (strict-ortho treats h as consonant;
  the CMU-phonology refinement that would correctly emit "an hour"
  is research-locked but not yet implemented).

## Future arc

The CMU-driven extension uses exception wlists (`fixture-src/wlist/`)
produced by `derive-exceptions.js`, plus an encoder lookahead that
consults them before falling back to strict-ortho. See
`research.md` §"Encoder design recommendation" for the
implementation order.

## Round-trip safety

Guaranteed by 0-bit unique-type singleton structure. The dict has
`xanax_a` and `xanax_an` as two distinct types each containing
exactly one word; decoder reads either as 0 bits.
