# Eve, auto-recovery utility

Eve is what an eavesdropper sees. Given a suspected (and optionally some
partial knowledge) Eve tries to recover the secret without being told
the BYOS. She runs in node and in the browser, sharing one core. She
proposes BYOS-candidates rather than decoding to bytes herself:
clicking a row in the browser hands suspected+BYOS off to `nicetext.html`
for the real decode.

This document is the design plan. A separate build-plan section at the
end re-orders the work for clean commits.

## Hard boundary, Eve never modifies core engine behavior

Eve is a sidecar utility. The round-trip contract held by the core
engine (`gendict`, `genmodel`, `nicetext`, `scramble`, and their
shared modules `lexer.js`, `decode.js`, `encode.js`, `dictionary.js`,
`cover-pipeline.js`) is the project's most critical invariant. Eve
must not put that contract at risk.

Rules, in priority order:

1. **Use existing core functions as-is when they fit.** Phase I
   tokenization calls `tokenizeStream` from `lexer.js`. Phase II
   calls `autoStrip`, `loadDictionary`, `decode`. No re-implementation,
   no copy-paste, no edits to make them "Eve-friendly" first.

2. **A new optional parameter on a core function is allowed** only if
   the default value preserves old behavior byte-for-byte. Every
   existing call site stays untouched. Every existing core test
   (`tests/node/roundtrip.test.js`, `tests/node/cards-roundtrip.test.js`,
   etc.) passes without modification. If a core test needs an update
   to accommodate the change, the change is in the wrong place.

3. **A sibling module under `js/src/eve/`** (e.g., `eve-lexer.js`)
   is the route when the option shape can't express the difference
   cleanly. The sibling may import the core module and wrap it; it
   does not edit it.

4. **Forbidden:** any change that alters what `gendict`, `genmodel`,
   `nicetext`, or `scramble` produce on identical inputs.

This boundary is why Eve can ship safely alongside an actively-
evolving engine, and why the developer approved Phase I.

## What Eve is not

- Not a cryptanalysis tool. If the secret is randomly encrypted, Eve
  has nothing to offer beyond enumerating candidates.
- Not a dictionary cracker. She does not try to invent BYOS knobs the
  developer did not give her; she searches over known BYOS shapes.
- Not 100%. Even for plaintext secrets, the answer is "ranked
  candidates," not a single guarantee.

## Inputs

Mandatory:

- `suspected`, the suspected NiceText string (raw bytes or text).

Optional, in increasing-knowledge order:

- `customCorpus`, bytes of a custom corpus the developer thinks may
  have been used.
- `customTwlist`, same for a custom TW-list.
- `byosHint`, a partial BYOS the developer thinks the sender used (or
  was told). Eve treats it as one signal among many; the sender may
  have lied about a knob to mislead.
- `recognizer`, a named pattern (gzip, PNG, PDF, SALTED__, printable
  text, UTF-8 text) or a developer-supplied head-byte pattern. Phase
  II only.

## Two phases

Eve has two cleanly-separable phases. Phase I is a complete utility on
its own and ships first.

### Phase I, suspected analysis (no decode)

Phase I never touches the decoder. It reads the raw suspected and emits a
per-knob verdict: for each BYOS parameter, is the suspected consistent
with that knob being on? Output is a checklist plus a running count of
how many BYOS combinations remain alive after the eliminations.

Honest outcome: many knobs end up as "unknown," and that is fine. The
goal is to shrink the search space cheaply before any decoding happens.

### Phase II, recognize and enumerate

Phase II adds head-byte recognizers and an enumeration engine. For the
combinations still alive after Phase I (and respecting BYOS schema
constraints), Eve loads or builds the dict, runs `decode` to first N
output bytes or EOF, and applies recognizers. Output is a ranked list
of candidates: each row carries a BYOS proposal, EOF status, head
bytes, recognizer verdict.

## Phase I, per-knob verdicts via strategy groups

Phase I produces a `byos-eve.json`: a `{likely | unlikely | unknown}`
verdict per BYOS knob. The meta-rule starts every knob `unknown` and
rules promote it; contradictions surface rather than silently resolve.

**Vocabulary.**

- **Suspected** is the input text to Eve. It may or may not be a
  real NiceText cover. Engine-side "cover" stays unchanged.
- A **detector** is one test against any available information
  (the suspected, fixture wlists, fixture model shapes, etc.). It
  produces evidence, not a verdict.
- A **rule** is a piece of verdict logic that reads one or more
  detector outputs and, when its condition fires, promotes a
  knob's verdict with a named attribution.
- A **verdict** is the per-knob state (`likely` / `unlikely` /
  `unknown`).

Detectors funnel through the shared
`js/src/eve/verdict-state.js / createVerdictState` + `applyRule`
machinery for attribution and contradiction detection. One detector
may inform several knobs; one knob may consume several detectors.

Detectors group into five strategies. Strategies 1–4 are active;
strategy 5 is deferred. Knobs that no current strategy can decide
emit an honest `unknown` stub with named-rule attribution
explaining why.

Schema constraints (e.g., `mixedPhrases > 0` requires
`emojiIntoWords` or `wordsIntoEmoji`) are applied only when
combinations are counted, not when checks run.

### Strategy 1: preclean-format check

Covers `isNiceText`.

Run `autoStrip` + `precleanCorpus` on a slice of the bare
suspected. If preclean changes the bytes, the suspected almost
certainly was not produced by NiceText: dict entries enter the
engine post-preclean and `precleanCorpus` is idempotent on its
outputs (`precleanCorpus.js:9`).

Asymmetric: `unlikely` is a strong negative (~0.9 confidence);
`likely` is a weak positive (~0.5, plenty of non-NiceText text is
also preclean-stable). Stays `unknown` when the slice is too
small for a confident verdict.

Implementation: `js/src/eve/preclean-check.js / runIsNiceTextCheck`.

### Strategy 2: suspected-wlist vs twlist-wlists comparison

Covers `sources.<name>` per twlist, `customCorpus`, `customTwlist`,
`story.vocabulary='corpus' with <stem>` per fixture corpus,
`augment.emojiIntoWords` (as the `sources.cldr-emoji-names`
source once recast), plus the candidate twlist combination
enumeration that drives the alive-combinations count.

Operates on **wlists** (each twlist source ships a sibling `.wlist`
fixture; type information is not needed for membership analysis,
so the comparison is cheaper than scanning the typed twlist). Two
flavors:

- **Per-source membership.** Does any suspected WORD appear in a
  source's wlist? Positive on first hit → `likely`. After K
  (default 50k) suspected words with zero hits → `unlikely`.
  Until then `unknown`. Custom corpus / custom TW-list reuse the
  same factory with different verdict knob names. The corpus
  pseudo-TW-list axis (`story.vocabulary='corpus' with <stem>`)
  asks the inverse: does every unique suspected word appear in
  fixture corpus X's vocab? If yes, X is a `likely` candidate
  for that knob.

- **Candidate twlist combination enumeration.** Build the
  matchingtwlists table (per unique suspected word, which sources
  contain it). The set of distinct matchingtwlists groups whose
  union covers 100% of non-must-literal suspected words
  enumerates the plausible source-combinations encoded into
  byos-eve.json. **Must-literals** (words in NO wlist) are
  identified there; they cannot have come from any wlist and so
  must have come from the sentence model's `^word^`
  quoted-literal entries.

Implementation: `js/src/eve/checks.js / createSourceCheck`,
`createCustomCorpusCheck`, `createCustomTwlistCheck`;
`js/src/eve/vocab-check.js / runVocabCheck` (matchingtwlist
table + candidate enumeration); `js/src/eve/job-handlers.js /
runCorpusVocabCheckJob` for the corpus pseudo-TW-list axis.

Possible future optimization (not built): a precomputed JSON
fixture listing strict-subset relationships between wlists, to
reduce the candidate-enumeration search space. Does not prune
combinations (`{a,b,c}`, `{a,c}`, `{b,c}` all stay alive even if
`a ⊂ b`); only the enumeration walk shrinks.

### Strategy 3: suspected emoji-glyph inspection

Covers `augment.wordsIntoEmoji` and `augment.mixedPhrases`.
Unicode-class regex over the suspected, not a wlist comparison.

- `augment.wordsIntoEmoji`: any emoji glyph
  (`Extended_Pictographic` or `Regional_Indicator`) in
  suspected → `likely` on first hit. After full scan with zero
  hits → `unlikely`.
- `augment.mixedPhrases`: longest emoji-glyph run inside one
  WORD-token cluster. The lexer collapses adjacent emoji into a
  single WORD token, so the relevant signal is the glyph count
  inside one cluster. A longest run of L rules out any
  `mixedPhrases > L`. The observed `max` is carried in the
  verdict's data field; the combination counter uses it as an
  upper bound without needing a verdict promotion.

Implementation: `js/src/eve/checks.js / createWordsIntoEmojiCheck`,
`createMixedPhrasesCheck`.

### Strategy 4: MonoTypedModelCheck

Covers `story.style.<card>`, `phrases`, `story.sentence`
(random / sequential).

Build a meta-dict mapping every word to one type
(`MONO_TYPE = 'g'`). Run `genmodel(text, metaDict)` on both the
suspected and each fixture corpus. The output is a **monotyped
model (MM)**: pure structural sentence templates like
`{Cap}|g|g|.` with punct, EOS, and case markers preserved and
word slots collapsed to one placeholder.

A second representation is derived from each MM by replacing every
run of consecutive `g` parts with a single `g`. This is the
**collapsed monotyped model (CMM)**: the canonical representative
of the phrase-augment equivalence class. Two MMs share a CMM iff
they share the same skeleton (non-`g` parts at the same run
positions) and have the same number of `g`-runs, regardless of
each run's length. Match-by-CMM is the phrase-augment-tolerant
predicate; no per-sentence variant enumeration required.

Per corpus, both representations live in one precomputed
fixture-build-time file: `fixtures/<stem>.monotyped-model.sab.gz`
(NTMM v2 format, see `js/src/eve/monotyped-model-sab.js`). The SAB
carries (a) the MM unique sorted pool (binary-searchable via
`.hasSorted(s)`), (b) the MM corpus-order positional index
(`.at(i)`), (c) the CMM unique sorted pool
(`.cmmHasSorted(s)`, `.cmmUniqueAt(p)`), and (d) a per-unique-MM
u32 index into the CMM pool (`.cmmIndexOfUnique(j)`,
`.cmmIndexOfOrdered(i)`, `.cmmAtOrdered(i)`). The suspected goes
through the same `genMonotypedModel` pipeline at session-runtime;
symmetry by construction.

Per (suspected, card) pair: walk the suspected's ordered side; for
each suspected[i] run sequential lock-step plus non-sequential
membership. Sequential lock-step scans card's ordered side from
position j up to j+256 looking first for an exact MM match
(`cardView.at(p) === cs`); on miss, a second pass looks for a CMM
match (`cardView.cmmAtOrdered(p) === csCmm`). Either kind of match
advances j; exact bumps `exactSeqMatches`, CMM-only bumps
`phraseSeqMatches`. Miss freezes the card from further sequential
checks. Non-sequential membership is two binary searches:
`cardView.hasSorted(cs)` and
`cardView.cmmHasSorted(suspectedView.cmmAtOrdered(i))`.
`rawHits++` on exact MM hit; `coveredHits++` on CMM hit;
`anyVariantHits = coveredHits - rawHits` is the phrase-augment-
only count. `story.sentence`'s random-vs-sequential verdict
derives from the top card's `matchDepth / totalSuspected` rate.
`phrases` derives from the top card's variant-only-vs-raw rate.

The CMM-based predicate replaces the earlier
`O(2^(K-1))`-per-suspected-sentence variant enumeration with a
single canonical lookup per sentence, on both sides. Measured
speedup against the previous variant enumeration: ~140-210× per
card (probe: `tests/node/tmp/probe-monotyped-cost-v2.mjs`).

Type-blind by construction (engine tenet: aug passes operate on
type→values graphs, never type-string introspection).

Implementation: `js/src/eve/monotyped-model-check.js /
genMonotypedModel`, `runMonotypedModelCheckPerCard`,
`aggregateMonotypedModelVerdicts`.

### Strategy 6: redacted-wlist negative detector (deferred)

A presence-of-slurs check against the shipped redacted wlist
(fixtures/redacted.wlist.sab.gz). Because NiceText redacts every
listed word/phrase from corpora and twlists at build time AND at
runtime (genmodel/listword via phraseFuse, twlist seams via
redactTwlistEntries, see redaction.js), a true NiceText-generated
cover CANNOT contain any of those words.

Eve runs the suspected through `getRedactedMatcher()` (the same
matcher the engine uses) plus the lexer's phraseFuse pass. Any
match means the suspected is NOT NiceText-origin. The verdict
contributes a HIGH-CONFIDENCE NO to the overall NiceText-likelihood
score for that suspected.

False-positive risk: a custom-corpus user who loaded their own
redacted wlist (or none) could produce a cover that surfaces words
the SHIPPED redacted wlist contains. Eve has no way to know which
list the encoder used, so this strategy weights toward
"non-NiceText-detector" rather than "non-NiceText-proof". Useful
as one signal in the ensemble.

Status: deferred until strategies 1–4 are complete and the
redaction pipeline has shipped. Costs one `getRedactedMatcher()`
load + one `phraseFuse` pass over the suspected, cheap.

### Strategy 5: precomputed knob-relevance fixture (deferred)

For knobs whose effect on encoder output can be probed
deterministically by encoding a canonical payload through two
byos specs that differ only in the target knob. If the outputs
are byte-identical, the knob is dead for that byos family and
can be dropped from byos-eve.json enumeration entirely.

The probe is computed at fixture-build time (not runtime), stored
as a JSON fixture, and consulted at session time. Eve never runs
the encoder during a session. Eliminates a class of `unknown`
verdicts cheaply.

Status: deferred until strategies 1–4 are complete and we have
data on which residual `unknown` knobs would benefit. Initial
candidate: `tieBreak`. Possibly extends to some
`frequencies.<name>` axes.

### Honest stubs

Knobs no current strategy can decide emit a verdict row of
`unknown` with named-rule attribution explaining why.

- `frequencies.<name>`: Zipf-shape correlation against frequency
  tables is noisy; deferred pending strategy 5.
- `tieBreak`: deferred pending strategy 5.
- `augment.vowel`: being retired in favor of the CMU-driven
  a/an-agreement strategy (`fixture-src/rewriters/xanax/research.md`);
  no detector planned.

### Knob → strategy map

| Knob | Strategy | Verdict source |
|---|---|---|
| `isNiceText` | 1 preclean-format | `preclean-check.js / runIsNiceTextCheck` |
| `augment.wordsIntoEmoji` | 3 emoji-glyph | `checks.js / createWordsIntoEmojiCheck` |
| `augment.emojiIntoWords` | 2 wlist comparison (CLDR-emoji-names source) | `checks.js / createSourceCheck` once recast |
| `augment.mixedPhrases` | 3 emoji-glyph | `checks.js / createMixedPhrasesCheck` |
| `augment.vowel` | stub | retiring |
| `sources.<name>` | 2 wlist comparison | `checks.js / createSourceCheck` + vocab-check |
| `customCorpus` | 2 wlist comparison | `checks.js / createCustomCorpusCheck` |
| `customTwlist` | 2 wlist comparison | `checks.js / createCustomTwlistCheck` |
| `story.vocabulary='corpus' with <stem>` | 2 wlist comparison | `job-handlers.js / runCorpusVocabCheckJob` |
| `story.style.<card>` | 4 sentence-model | `style-check.js / aggregateStyleVerdicts` |
| `phrases` | 4 sentence-model (CMM sub-strategy) | same |
| `story.sentence` (random/sequential) | 4 sentence-model | same |
| `frequencies.<name>` | stub (strategy 5 candidate) | none |
| `tieBreak` | stub (strategy 5 candidate) | none |

### Streaming architecture for Phase I

Suspecteds may be very large (multi-MB, plausibly 100MB+). The detector
engine reads the suspected once, fans tokens out to all active detectors,
and lets each detector drop out as soon as it has enough evidence.

**Detector contract.** Each per-knob check implements:

- `consume(token)` for token-level detectors, or `consume(chunk)` for
  byte-level detectors.
- `verdict()` returning `{verdict, confidence, why, done}`.
- `done` flips true when the detector has enough evidence to stop
  receiving input.

**Engine.** One streaming pass:

1. Tee the suspected ReadableStream into a token stream (via
   `tokenizeStream` from `lexer.js`) and a raw-chunk stream.
2. For each token, dispatch to all not-yet-done token detectors. For
   each chunk, dispatch to all not-yet-done chunk detectors.
3. Done detectors drop out of the dispatch set.
4. When all detectors are done, or the suspected ends, or a budget trips,
   emit the table.

**Two detector classes, two stopping behaviors:**

- **Positive-evidence detectors.** One concrete observation decides
  the verdict (e.g., "saw an emoji glyph", "saw a CLDR emoji-name
  token"). Mark `done` on first hit. Most augment-on checks finish
  in microseconds on real suspecteds.
- **Negative-evidence detectors.** Cannot decide `unlikely` until
  they have seen enough suspected to be confident absence is real (e.g.,
  "no distinctive TW-list token in K tokens"). Default budget K
  (initially 50,000 tokens), tunable per detector. Below K, verdict
  stays `unknown`. At K with zero hits, verdict becomes `unlikely`.

**Progressive sampling falls out for free.** Engine yields to the UI
every Y tokens with current verdicts, so the developer can cancel
("seen enough") before the sweep finishes. The engine can also extend
K for stubborn `unknown` detectors on request, without re-reading
material that has already been streamed.

**Memory.** Detector state is O(1) or O(distinctive-vocabulary-size),
never O(suspected). The suspected itself is never buffered as a whole.

**Byte-level vs token-level.** Most detectors live on the token
stream. A few (emoji-glyph detection over arbitrary Unicode,
vowel-augment glyph patterns) want raw chunk bytes. The engine teed
the upstream once so both consumer classes share the single read.

Phase I output, both CLI and browser:

- A checklist row per knob: verdict, confidence, one-line reason.
- A running combination count, updated as the developer pins or
  un-pins knobs manually.
- A manual override per knob: pin to "must be X," pin to "ignore this
  check," or leave on the check's verdict. This is how the developer
  uses outside knowledge to narrow further or override a wrong vote.

## Phase II, recognize and enumerate

Pipeline once Phase I has produced a surviving-combinations shortlist:

1. **Unwrap.** Run `autoStrip` from `cover-pipeline.js`. Successful
   peel is a weak positive signal ("looks like NiceText"). The bare
   suspected is what enumeration operates on.

2. **Premade-card replay.** Iterate the 21 cards in `cards.data.js`
   that survive Phase I. For each, load the prebuilt dict from
   `fixtures/`, run `decode`, record EOF status, first N output bytes,
   bytes total, recognizer verdict.

3. **Enumerate the residue.** For surviving combinations beyond the
   premade cards, build (or fetch cached) dict per byosID, run
   `decode`, record same outcomes. Worker pool, progress, cancel.

4. **Output.** Browser: ranked table, virtualized scroll, row click
   opens `nicetext.html` with suspected+BYOS prefilled. Node: stdout
   summary plus optional `--out-dir=path` (NDJSON stream or per-file).

### Decoder failure mode (the constraint that shapes everything)

Critical finding from `js/src/decode.js`: unknown words are silently
skipped (line 70: `if (entry && entry.bits !== 0) bw.writeBits(...)`).
There is no fast-fail on "this word isn't in the dict." A wrong BYOS
walks the suspected to completion, emitting whatever bits it can read, and
only stops when:

- it sees four consecutive 0xAA bytes in the bit-stream (EOF marker), or
- the suspected is exhausted, or
- a malformed escape sequence is encountered (rare).

This means brute force cannot rely on cheap rejection. Every attempt
runs to completion or near-completion. **Mitigation:** the 4-byte EOF
marker is itself the strongest single signal: random bits hit four
0xAA in a row roughly 1 in 4 billion. "Decoder reached EOF cleanly"
filters out nearly all wrong BYOS attempts. The file-magic recognizer
is a second filter on top.

### Recognizers

Built-in starter set, all over head-bytes:

| Name | Head pattern |
|---|---|
| `salted` | `Salted__` (8 ASCII bytes, openssl enc default) |
| `gzip` | `1f 8b` |
| `png` | `89 50 4e 47 0d 0a 1a 0a` |
| `pdf` | `25 50 44 46 2d` (`%PDF-`) |
| `jpeg` | `ff d8 ff` |
| `zip` | `50 4b 03 04` |
| `utf8` | first N bytes valid UTF-8, at least 90% printable |
| `printable-ascii` | at least 95% ASCII printable, no control bytes except `\n\r\t` |

Plus a developer-supplied free-form pattern: hex prefix or text
prefix. No regex engine in v1.

### Modes

- `--mode=phase1` (Phase I only). Suspected analysis, combination count,
  no decoding. The default once Phase I lands.
- `--mode=premade`. Phase I plus step 2 of Phase II (premade cards).
- `--mode=brute`. Phase I plus full Phase II enumeration. Requires
  `--confirm` and prints estimated cost before starting.
- `--mode=head-only`. Orthogonal flag: decodes only enough for first
  N output bytes instead of full decode. On by default in Phase II.

## Browser output shape

The Eve page is a table:

- Phase I view: one row per BYOS knob, columns for verdict, reason,
  override. A counter at the top shows how many combinations remain
  alive given current verdicts and overrides.
- Phase II view: one row per BYOS-candidate, columns for BYOS preview
  (chip), EOF status, head-bytes (first 16 in hex+ASCII), recognizer
  hit, action.
- Virtualized scroll. Phase II rows sorted: recognizer hits first,
  EOF-found-without-hit next, no-EOF last.
- Row action in Phase II: "Open in NiceText," navigates to
  `nicetext.html` with suspected and BYOS encoded into the URL (small
  BYOS) or via session/postMessage handoff (large BYOS with embedded
  custom corpus). Mechanism deferred to implementation.

The suspected is not a secret, so no persistence-rule conflict. Recovered
head-bytes stay in page memory and are not written to localStorage,
cookies, or IndexedDB.

## Node output shape

Stdout (Phase I):

```
Eve Phase I (suspected N tokens, M chars unwrapped)
  augment.wordsIntoEmoji   likely    (12 emoji glyphs in suspected)
  augment.emojiIntoWords   unknown   (no curated emoji-keyword tokens, but base overlap is high)
  augment.mixedPhrases     <= 3      (longest emoji-run = 3)
  augment.vowel            unlikely  (no vowel-augment tokens detected)
  sources.impf2p           likely    (84 distinctive tokens hit)
  sources.emoji16          likely    (...)
  ...
  story.style              likely=aesop,frankenstein  unlikely=texting-teen,wizoz
  ...
Combinations alive: 1248
```

Stdout (Phase II, with recognizers):

```
Eve Phase II premade-card replay (1248 alive after Phase I, 21 cards survive)
  ✓ aesop          EOF=yes  head="Salted__\x12\x34..."  [salted hit]
  - frankenstein   EOF=no   recovered 0 bytes
  ...
21 candidates / 1 hit
```

With `--out-dir=path`, dumps `{byosID}.json` per candidate (or one
NDJSON stream with `--ndjson`).

## Threading

- node: `worker_threads`. Pool sized to `os.cpus().length`. Each
  worker runs the same per-BYOS decode-and-recognize routine. Job
  queue drained until cancel or empty.
- browser: `Worker`. Pool sized to `navigator.hardwareConcurrency` or
  4. Same per-BYOS routine, same shared core in `js/src/eve/core.js`.
- Cancellation: shared atomic via `SharedArrayBuffer` (already in
  use elsewhere for COI-gated paths) or `postMessage` flag check
  between jobs. Per-attempt is short enough that between-jobs
  cancellation is sufficient.

Phase I is single-threaded; the cost is in cheap suspected scans and does
not need a pool.

## File layout

Following the stress-pattern:

- `js/src/eve/core.js`, pure browser-safe ESM. Exports `runPhase1` and
  `runPhase2`. Owns the per-knob check registry, the recognizer set,
  and the per-BYOS decode routine.
- `js/src/eve/checks.js`, per-knob check functions.
- `js/src/eve/recognizers.js`, head-byte sniffers.
- `tools/eve/run-pool.mjs`, node CLI. Argv parsing, worker pool,
  `--out-dir` writer, stdout formatting.
- `tools/eve/worker.mjs`, worker entry, calls into `core.js`.
- `eve.html`, browser page. Drag/drop suspected, inputs for custom
  corpus / TW-list / recognizer, two views (Phase I and Phase II),
  progress, cancel.
- `js/eve.js`, browser-side page glue.
- `tests/node/eve.test.js`, round-trip: encode a known secret with
  known BYOS, run Eve over the suspected, assert Phase I narrows
  correctly and Phase II finds the correct BYOS with a recognizer hit.
- `tests/node/tmp/eve-*.mjs`, scratch probes during development.

## Build plan, execution order

Phase I is largely landed: strategies 1, 2, 3, and 4 are wired
(strategy 4 with a `matchDepth` shortcut for `story.sentence`
pending the strict random/sequential variant comparison),
strategy 5 is deferred. Phase II is the remaining front and
follows the queue below.

### Phase II commits

1. **Recognizers.** Land `js/src/eve/recognizers.js` with the
   starter set. No decode yet, just the surface. Unit-test against
   known head-byte fixtures.

2. **Premade-card replay (node, single-threaded).** Iterate
   surviving premade cards, load prebuilt dict, run `decode`,
   apply recognizer. Print results. Test: encode plaintext
   `Salted__...` with card X, Eve flags salted.

3. **Enumeration engine (node, single-threaded).** Implement
   `--mode=brute`: iterate surviving non-premade combinations,
   build dict per byosID, run decode + recognizer. `--confirm`
   gate. `--out-dir` writer. Test: small synthetic search space,
   Eve finds the planted BYOS.

4. **Worker pool, browser Phase II.** Add `Worker` pool to the
   Eve worker for Phase II decode. Progress and cancel UI.

5. **Recognizer customization UI.** Free-form head-byte pattern
   input in the browser. Saved to URL hash for shareability.

6. **Polish.** Docs, link from `index.html` nav, screenshots,
   tagline copy.

## Open questions for the developer

- Suspected handoff mechanism for the "Open in NiceText" click: existing
  URL-param plumbing, sessionStorage, or postMessage? Defer until
  commit 9, decide by grepping then.
- Default browser mode after Phase I lands: Phase I view by default,
  or Phase II view if suspected obviously looks like NiceText.
- `--out-dir` writer: per-file `{byosID}.json` (easy to inspect) or
  one NDJSON stream (easy to grep). Lean NDJSON, `--per-file` as opt-in.

## Tab placement (Phase I)

Eve's UI is a tab inside `nicetext.html`, labeled "Eavesdropper"
(the role; Eve is the persona). The tab description explains
the framing: this is what an eavesdropper named Eve might do to
figure out which BYOS parameters were used to generate the
loaded suspected.

Reasons for tab-not-separate-page:

- Suspected loading (paste / load / autoStrip / unwrap) is already
  in `nicetext.html`. Eve just observes the loaded suspected.
- The panel template fits: title, description, toolbar (Go /
  Cancel), narrative log in the action area, stats footer
  (combo count, must-literal count, loop progress).
- When Eve identifies a likely BYOS, "Apply to Encode" or
  "Apply to Decode" flips the active tab and prefills the BYOS
  panel. No cross-page state transfer, no localStorage needed.
- Receiver mental model: Conceal, Reveal, Eavesdropper as three
  views on the same loaded suspected.

The Go button is disabled when the suspected story tab has no
content. Eve has nothing to analyze without a loaded suspected, so
the action is gated on suspected presence.

Phase II placement (where the recognize + enumerate machinery
lives) is deferred. It might extend the Eavesdropper tab, become
its own tab, or move to a separate `eve.html` tool depending on
how the recognizer / brute-force surface evolves.

### Cover Story tab tracks preclean state

For Eve's `isNiceText` detector (autoStrip + precleanCorpus
idempotency) to give a meaningful signal, she needs to know
whether preclean changed the suspected during load. The Cover Story
tab keeps ONE precleaned suspected in RAM (avoiding a doubled memory
footprint for multi-MB / 100MB suspecteds); Eve reads a side-channel
flag (`precleanChangedBytes` plus before/after lengths) cached by
the most recent `precleanCorpus` call -- which is the Cover Story
tab's load step.

`precleanCorpus` itself can expose its last-call result as
module-level state (or via an explicit return shape). Either way
the raw suspected doesn't need to be retained.

### Custom corpus / custom TW-list uploads reuse Custom Style

When the developer wants Eve to consider a custom corpus or
custom TW-list (developer-supplied as an addition to the shipped
fixtures), the existing "Story Style | Custom" tab already has
the upload UI. Eve's Eavesdropper tab points the developer
there: "to add a custom corpus or TW-list, switch to Story Style
and upload it; come back here and re-run Go." No new upload
plumbing needed. The Custom-tab upload feeds the shared cache
that the Eavesdropper tab reads from.

## Eve UI design contracts

These contracts govern eve.html (and the CLI's narrative output by
the same shape). They lock in choices that came out of the bullet-
walkthrough conversation; future Eve work should follow them
unless explicitly re-decided.

### Narrative log, real-time

eve.html is a streaming log of Eve's reasoning as the analysis
progresses. Not a static table. Each test step appends a row to
the running log with:

- Section banner for the current progressive-sampling loop
  ("Progressive Loop 1: first 1k chars").
- English description of what the test is checking, in plain
  language the developer can read without remembering the code.
- A CLI-style call signature showing the underlying invocation
  (e.g., `extractCorpusVocab(fixtures/shakespeare.txt.gz) ⊇
  cover_unique_words?`). When the developer asks "why did this
  show up as likely at 80%?", the answer is right there.
- Raw result statistics (counts, percentages, actual missing
  words when small enough).
- The rule that fired (named so the developer can locate it in
  code / docs).
- The resulting verdict.

The final state below the log is the per-knob verdict summary
with override controls; Phase II reads it.

### Verdict meta-rule

Every knob Eve tracks starts at `unknown`. Rules apply in
priority order; each rule can promote a verdict to `likely` or
`unlikely`.

- `unknown -> likely` or `unknown -> unlikely`: normal, quiet.
- `likely <-> unlikely`, `likely -> unknown`, `unlikely -> unknown`:
  loud. Surface in the UI as a contradiction or pullback. This
  signals rule priority or threshold calibration may be off, and
  the developer should review.

Each verdict carries the identifier of the rule that set it so
the UI can render "knob X is likely because rule R fired."

Applies universally: TW-list sources, corpus pseudo-twlists,
story.style cards, augment knobs, story.sentence, phrases,
isNiceText, etc.

### Progressive sampling + session cache

Eve runs progressive loops: first 1k suspected bytes, then expand
(10k, 100k, ..., full). After each loop the verdict log shows
how many knobs are still unknown; the next loop runs only if
unknowns remain or the developer asks for more.

Corpus-side data structures are session-cached:

- Preclean'd corpus text per fixture.
- `extractCorpusVocab(corpus)` per fixture (the corpus pseudo-
  TW-list).
- TW-list `Set<word>` per source.
- `buildCardIndexFromCorpus(corpus)` per fixture (ordered shapes
  + freq map for style matching).

Suspected side recomputed each loop (the suspected scope grows). Corpus
side built once, reused across loops. First loop pays the
corpus-side cost; subsequent loops are fast.

Session-scoped only in v1. IndexedDB persistence across page
reloads is a future option if first-load latency becomes painful.

## Rules of engagement (appendix)

Re-read these before each step of implementation.

- Zero external dependencies. Node built-ins plus web platform only.
- Developer drives. Stop and re-plan if findings change the design.
- No em dashes. Periods, commas, colons, parentheses.
- Callbacks, not polling.
- "the developer" not "the user" in docs and code.
- Commit equals commit plus push.
- WSL: HTTP server, not `file://`.
- Test cadence: node smoke first, browser page second, full
  integration last.
- Scratch in `./tmp/` or `tests/node/tmp/`, never absolute paths.
- User-supplied content into the DOM via `textContent` only; CSP
  meta tag mandatory on `eve.html`.
- No persistence of secrets, recovered payloads, or candidate
  head-bytes to localStorage, cookies, or IndexedDB.
- Name the enclosing function and module before any diff in chat
  (e.g., "Edit lands in `runPhase1` (file `js/src/eve/core.js`)").
- Brevity: one-line summary first, expand on request.
- Type strings are opaque. Aug passes operate on type-to-values
  graphs, not type-string parsing.
- Never block creative recognizer patterns. Defense lives
  receiver-side. Eve eats whatever the developer hands her.
- Reuse shared code. Two callers of the same plumbing means extract
  before the second caller is written.
