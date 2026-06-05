# typos rewriter

Cover-transform rewriter that swaps between canonical words and common
typo variants (the to teh, you to yuo, etc.). Intended steganographic
effect: the cover reads as if a human typo'd, plausible by default,
zero bit cost (every variant is a 0-bit unique-type singleton).

## What it does

Two modes share one `apply()`:

- `forward` (introduce typos). `Map<canonical, Set<typos>>`.
- `reverse` (correct typos). `Map<typo, { canonical }>`.

The runtime (`js/src/rewriter/typos.js`) delegates to the shared
lookup-swap factory in `js/src/rewriter/_lookup-swap.js`, reading the
just-pushed WORD, gating on intensity plus a variant-pick coin, and
mutating with surface-case preservation. `jobs.js` loads the
mode-specific NTRW fixture (`fixtures/typos-{forward,reverse}.rewriter.sab.gz`)
before encode runs. The byos surface is `rewriter.typos`, an
`{ enabled, intensity, mode }` object.

## This directory

- `pairs.tsv.gz`: 28,042 single-word `{typo, canonical}` pairs derived
  from `client9/misspell` (MIT-licensed).
- `fetch.js`: regenerates `pairs.tsv.gz` from the upstream source.
- `LICENSE`: the client9/misspell MIT license for the pair data.

## Round-trip safety

The build pipeline (`tools/build-rewriter-fixtures.js`) emits one
shared twlist, `fixtures/rewriter-typos.twlist.sab.gz` (~36K entries),
holding a single 0-bit singleton per unique word appearing on either
side of the pair set, typed `typos_w_<word>`. sortdct merges the
singleton with any other-source types the same word picks up, but no
other word shares the exact type signature, so the merged type stays
singleton (0 bits per slot). Swapping canonical and typo mid-cover is
therefore transparent to the decoder's bit recovery. There is no
`getRewriterUniqueTwlist()` on the runtime side; every rewriter's
unique twlist lives in its `rewriter-<name>.twlist.sab.gz` fixture.

See `docs/cover-transforms.md` for the four-block architecture and
the rewriter safety guidelines.
