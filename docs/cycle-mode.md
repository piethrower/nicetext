# Cycle Mode: Engineering Design Thoughts

Implementation-side reasoning from the 2026-05-02 design conversation.
Not a build plan; a record of what was decided, what was ruled out,
and the open questions.

## Operational shape (settled)

Cycle Count `C` is a single page-level integer set somewhere in
`nicetext.html`. Style is locked for the whole chain (developer's call
during the discussion). Conceal direction:

```
secret(1) → conceal → cover(2) → gzip → secret(2)
secret(2) → conceal → cover(3) → gzip → secret(3)
...
secret(C) → conceal → cover(C+1)              [final, no gzip]
```

`cover(C+1)` is what the developer shares. `C` conceals total, `C-1`
gzips. Reveal is the symmetric mirror: text in, decompress between
cycles, original `secret(1)` out at the end.

Compression is browser-native `CompressionStream` /
`DecompressionStream`. Zero deps, off-main-thread, fully streaming.
No worker stage needed for it.

The page also surfaces a per-cycle expansion-rate chart: byte counts
of `secret(n)` and `cover(n)` for each `n`, captured by tapping
`TransformStream` byte counters on each pipe edge in the parent.

## Streaming and worker topology (settled)

The engine is fully streaming end-to-end. Confirmed in code:

- `js/src/encode.js` "ReadableStream<Uint8Array> via streamWrap …
  WritableStream<Uint8Array>. No drain, no whole-payload buffering."
- `js/src/decode.js` mirror path.
- `js/src/stream.js` `streamWrap` over `AsyncBitReader`.
- `js/src/lexer.js` streaming tokenizer.
- `js/src/worker/jobs.js` `encodeJob` / `decodeJob` accept a
  `ReadableStream<Uint8Array>` and return a
  `Promise<ReadableStream<Uint8Array>>`.
- `js/src/worker/streams.js` MessagePort-backed Readable / Writable
  pairs with lazy pull-based backpressure across the worker boundary.
- `js/pipeline.js` already uses this for production save-as-stream
  egress.

So cycle mode is a `pipeThrough` graph. Worker count scales naturally:

- **`workers ≥ cycles`**: full chain in flight, one persistent
  conceal worker per cycle, gzip stages between them, all live
  concurrently. Backpressure propagates from final consumer to seed.
  Intermediates live only in TransformStream backpressure buffers
  (~64 KB each). No disk involvement.
- **`workers < cycles`**: split into batches of size `workers`, OPFS
  spill between batches. Each batch is its own `pipeThrough` graph;
  the boundary file is the only persisted intermediate.
- **`workers == 1`**: degenerate case of the above, OPFS file
  between every adjacent cycle pair.

Concurrency cap mirrors the existing pipeline:
`navigator.hardwareConcurrency - 1`, floored to 1. Same code path
either way, only the batch size changes.

The earlier "3C-1 workers" framing was wrong. Pipelining doesn't need
a worker per stage-in-the-chain, it needs a worker per
stage-in-flight-concurrently. Conceal is the only worker stage;
gzip is in-stream via CompressionStream.

## Memory blowup

Each cycle: conceal expands ~50 to 80x against the input bytes, then
gzip pulls cover text back ~3 to 5x. Net cycle-over-cycle growth
~15 to 25x. Later cycles' inputs are increasingly random-looking
(gzip output of gzip output stops compressing), so the multiplier
trends toward conceal's raw expansion. A 1 KB seed at C=10 is
GB-territory.

UX consequence: cycle output exceeds any sensible textarea size
quickly. Same threshold-then-offer-pipeline-or-textarea decision as
existing large-secret encodes today
(`shouldUsePipeline(files, 'encode')` in `js/pipeline.js`). On the
reveal side, the existing `T_COVER_BYTES = 1 MB` threshold already
covers the "developer pasted in a huge multi-cycle cover" case. No
new thresholds, no new UI category, just reuse.

## OPFS hygiene plan

OPFS is the right primitive for intermediate buffering when
`workers < cycles`, but it does NOT auto-clear and would leak files
under rule 27 without explicit hygiene.

Persistence facts:

- Per-origin sandbox. Not visible to other origins, not in the normal
  filesystem, not in file pickers.
- Persists across page reload, tab close, and browser restart by
  default.
- Subject to browser eviction under storage pressure (LRU). Safari
  also evicts after about 7 days without engagement. Eviction is a
  probabilistic safety net, not a hygiene guarantee.
- Cleared by the developer's "Clear site data" gesture.
- Files live on disk in cleartext (the browser does not encrypt at
  rest; only inherits whatever full-disk encryption the OS provides).

Cycle intermediates are generated cover stories, so they fall under
rule 27 (no persistence of secrets or generated stories). The plan if
the implementation goes OPFS:

1. Fixed temp directory, e.g. `/.cycle-tmp/`, so cleanup is targeted.
2. Delete each intermediate file the moment the next cycle has fully
   consumed it (close-after-read hook on the writable side).
3. Page-load sweep of `.cycle-tmp/` deletes anything found, catches
   prior-tab-killed-mid-cycle remnants.
4. `pagehide` handler attempts a final sweep. Best effort, not
   guaranteed on crash or tab-kill, hence step 3.

Honest caveats:

- OPFS is "less persistent than localStorage" but not zero-persistence.
  A motivated forensic look at the disk between a crash and the next
  page load could find leftover bytes.
- DevTools (Application, Storage) can list OPFS contents during the
  run.

## Failure modes

- **Wrong cycle count on reveal**: same family as wrong dict / wrong
  style. Too few cycles leaves the developer with an intermediate
  gzip-compressed payload as their "secret" (junk). Too many cycles,
  one of the inner DecompressionStream stages throws because the
  bytes at that level are not a gzip stream. Wrap that error so the
  surface message is "couldn't decompress at cycle k" rather than
  the raw exception. Five-line friendly-error wrapper, not an
  architectural concern.
- **OPFS quota pressure** during a long chain: same recovery as any
  pipeline-mode quota failure, treat as a fatal error and clean up
  partial files via the page-load sweep.

## Open question

Rule 27 vs OPFS: do we accept OPFS-with-hygiene, or insist on
memory-only with a hard cycle-count ceiling? Memory-only is more
honest about the no-persistence promise but caps cycle count at
something small (probably C ≤ 3 or 4 given the expansion math).

## Ruled out

These came up during the conversation and were rejected. Recorded
here so a future session does not re-litigate them.

### Hide the real secret at iteration k by appending it after the chain noise

Idea: forward-iterate `conceal + gzip` from a zero-length seed. At
iteration `k`, append the developer's real ciphertext to the chain's
gzip output. Continue iterating to `N`. Recipient peels back, finds
the appended payload at level `k`. The "key" is `(k, N)`.

Why rejected:

- gzip framing leaks the seam. gzip output ends with a defined
  trailer (CRC32 + ISIZE). Anything appended after sits at a
  detectable offset; even plain `gunzip` reports trailing garbage.
- Mitigation would require an unframed entropy coder or a stream
  cipher applied over the gzip output to randomize the seam. Both
  add complexity for a feature that, given the project's public
  posture (research / educational, dictionaries are public), does
  not buy meaningful additional confidentiality.
- The "key" is just an iteration count, search space is tiny,
  uninteresting cryptographically.

### Universal-coverage dictionary so reveal works on arbitrary text

Idea: design a dict / style pair where reveal is total, defined on
any input text. Then iterate reveal as a compression chain that
naturally terminates at zero bytes.

Why rejected:

- Existing dicts have ~tens of thousands of words tuned for English.
  Random-bytes-as-UTF-8 produces tokens with essentially zero match
  rate against any real-English dict. Reveal walls in one step on a
  random source, not gracefully.
- Huffman + sentence-model weights only kick in after the dict
  lookup succeeds. They cannot soften an OOV failure that happens
  upstream of them.
- Building a universal dict (every codepoint sequence representable,
  with escape rules, plus a permissive sentence model) is a research
  project of its own and would produce poor-quality cover text.

This doc covers engineering only.
