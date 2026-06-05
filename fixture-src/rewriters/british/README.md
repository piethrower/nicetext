# british rewriter

Cover-transform rewriter that swaps spellings between American and
British English (color to colour, organize to organise, etc.).
Intended steganographic effect: the cover reads as if authored in the
other dialect.

## What it does

Two modes share one `apply()`:

- `us-uk` (Britishize: US to UK). `Map<american-word, Set<british>>`.
- `uk-us` (Americanize: UK to US). `Map<british-word, Set<american>>`.

The runtime (`js/src/rewriter/british.js`) is mode-agnostic: it
delegates to the shared lookup-swap factory in
`js/src/rewriter/_lookup-swap.js`, reading the just-pushed WORD,
gating on intensity plus a variant-pick coin, and mutating with
surface-case preservation. `jobs.js` loads the mode-specific NTRW
fixture (`fixtures/british-{us-uk,uk-us}.rewriter.sab.gz`) before
encode runs. The byos surface is `rewriter.british`, an
`{ enabled, intensity, mode }` object.

## This directory

- `pairs.tsv.gz`: 3,096 `(source, target, direction)` rows derived
  from `client9/misspell`'s DictAmerican + DictBritish blocks
  (MIT-licensed).
- `fetch.js`: regenerates `pairs.tsv.gz` from the upstream source.
- `LICENSE`: the client9/misspell MIT license for the pair data.

## Round-trip safety

The build pipeline (`tools/build-rewriter-fixtures.js`) emits one
shared twlist, `fixtures/rewriter-british.twlist.sab.gz`, holding a
single 0-bit singleton per unique word across both directions, typed
`british_w_<word>`. sortdct's merge keeps each entry singleton even
when another twlist source contributes the same word under a
different type name, so swapping a spelling mid-cover is transparent
to the decoder's bit recovery. There is no `getRewriterUniqueTwlist()`
on the runtime side; every rewriter's unique twlist lives in its
`rewriter-<name>.twlist.sab.gz` fixture.

See `docs/cover-transforms.md` for the four-block architecture and
the rewriter safety guidelines.
