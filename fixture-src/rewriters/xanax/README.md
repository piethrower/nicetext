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

## Capability

Two-tier agreement rule via `apply(phraseBuf)`:

1. CMU-phonology exception sets, loaded from
   `fixtures/rewriter-xanax.data.js`. Silent-h words
   (`XANAX_TAKES_AN_DESPITE_CONSONANT_LETTER`: hour, honest, honor)
   force "an"; vowel-letter-onset consonant words
   (`XANAX_TAKES_A_DESPITE_VOWEL_LETTER`: united, one, European) force
   "a".
2. Strict-orthographic fallback for everything else (the ~99% case):
   leading letter in [aeiou] gives "an", else "a".

Examples:

- "a apple" → "an apple" (strict-ortho)
- "an cat" → "a cat" (strict-ortho)
- "a hour" → "an hour" (CMU exception set, silent h)
- "a united" → "a united" (CMU exception set, consonant onset)

The exception sets are produced offline by `derive-exceptions.js`
(Phase 1 CMU classifier) and `corpus-sweep.js` (Phase 2/3 accuracy
measurement). See `research.md` §"Encoder design" for the derivation.

## Round-trip safety

Guaranteed by 0-bit unique-type singleton structure. The dict has
`xanax_a` and `xanax_an` as two distinct types each containing
exactly one word; decoder reads either as 0 bits.
