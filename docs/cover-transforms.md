# Cover Transforms

The set of operations that transform the encoder's output on its way to
becoming the final cover artifact. Four categories, ordered from
innermost to outermost in the encoding pipeline:

1. **Rewriter**, per-emission word-level mutations during encoding.
2. **Reformatter**, model-layer enhancers (model -> model) applied
   between `stream.next()` and the encoder's consumption loop.
3. **Envelope**, wraps the cover in a semantic container that looks
   like a real human message (fake email, fake letter, fake source
   file).
4. **Wrapper**, byte-level transport encodings stacked over the
   envelope output (gzip, base64, uuencode).

The four categories share a safety contract (round-trip preservation)
but operate at different layers, run in a fixed order, and have
different implementation requirements. This doc defines all of them.

## OG intent

In the original 1995-2001 C++ NiceText, "post-processor" meant a single
class of operation: a pure surface transform applied to the generated
cover after encoding finished, with no engine knowledge. Three
canonical safe-by-design categories were available to a dict-blind
post-processor:

1. Replacing any whitespace with any other whitespace.
2. Changing case anywhere in the cover.
3. Adding, removing, or substituting punctuation.

OG models attached punctuation to each sentence-model node and emitted
it deterministically (`MTCsentenceNode.punctuation` in
`OG-NiceText-C++/nicetext-1.0/gendict/`), so punct was non-bit-bearing
by construction. Whitespace was lexer-insignificant beyond word
boundaries. Case was case-folded at dict lookup.

A fourth category (substituting a 0-bit unique-type word with another
0-bit unique-type word) is theoretically safe but **requires dict
knowledge** to identify which WORDs are 0-bit unique-type. Dict-blind
OG post-processors had no way to access that information. The category
only becomes viable with rewriters (see below), which run inside the
encoder and have full dict access.

## What changed

Modern NiceText introduces features that constrain the OG bar:

- **Phrases.** The lexer's `phraseFuse` matches multi-WORD sequences
  against the dict's `phraseIndex`. Any surface change that crosses a
  phrase boundary can create or destroy a fusion, which would change
  the decoder's token count and break bit accounting.
- **Emoji as WORDs.** Emoji clusters lex as WORD tokens
  (`js/src/lexer.js:179`) and carry bits per their dict-type
  membership. The WORD population that Guideline 1 governs now
  includes emoji.
- **Model-side punctuation.** Punct in modern models is still
  emitted deterministically per node (`buildSampler` in
  `js/src/modeltable.js` uses `random()`, not payload bits, for model
  selection), so punct remains non-bit-bearing at the bit level.
  Phrase-fusion interactions are the surviving constraint.

These features don't add new categories but do add caveats to the
existing four, captured in the guidelines below.

## Rewriter vs formatter

Two of the four categories are content transforms with very different
implementation contracts. Envelopes and wrappers are structural
operations covered separately.

- **Formatters** are dict-blind. They operate on the final cover
  string with no access to the engine, dict, byos, or phrase index.
  They must comply with the safety guidelines at face value, or break
  round-trip silently. Examples: case, lineBreak.
- **Rewriters** are implemented inside the encoder. They mutate the
  encoder's `phraseBuf`, with full access to the dict and the
  engine's `analyzePhraseBuf` infrastructure. They can use that
  privileged knowledge to dodge edge cases (e.g., phrase-fusion
  conflicts) that formatters cannot see. Examples: xanax, typos,
  british, voice.

Concrete example for the distinction: `xanax` is a rewriter. If the
same logic were attempted as a formatter, the formatter sees the
surface "a okay" and incorrectly rewrites to "an okay" because it
can't see the encoder's phrase buffer telling it that "a ok" was
emitted as a single phrase token, not as separate WORDs. The
rewriter form reads `xanax_last_word` from the phrase buffer and
correctly sees `neither`, so no swap fires.

Guideline 1 (0-bit unique-type word substitution) is therefore
rewriter-only: dict-blind formatters cannot identify which WORDs
are 0-bit unique-type, so they cannot safely apply transformations
under Guideline 1. Guidelines 2, 3, and 4 are safe for both.

## Safety guidelines

The four safety guidelines that bind any cover-transform. Each is
phrased as "what is safe" and "what is unsafe" so formatter authors
and rewriter implementations can verify the same contract.

### Guideline 1: 0-bit unique-type words

Payload bits are recovered from each WORD by looking up its type in
the dict and reading the word's index within that type's word list. A
type with exactly one member encodes log_2(1) = 0 bits per slot, so a
WORD in such a unique type contributes nothing to the bitstream. The
hinge: 0-bit unique-type WORDs are the only WORDs whose presence,
absence, or identity in isolation is transparent to round-trip.
Adjacency to neighbors is a separate concern: the lexer's phrase fuser
matches multi-WORD sequences against the dict's phrase index, so any
add, remove, or swap of a 0-bit unique-type WORD can create or destroy
a phrase-fusion match in the surrounding sequence.

**Safe transformations:**
- Replace, remove, or insert a 0-bit unique-type WORD where the WORD
  sequence around the change matches no phrase entry in the dict
  either before or after.

**Unsafe transformations:**
- Replace, remove, or insert a 0-bit unique-type WORD where the change
  creates or destroys a phrase-fusion match in the surrounding
  sequence.

**Built-in mitigations:**
- **xanax**: replaces `a` / `an` at article positions. Each
  replacement mutates the encoder's `phraseBuf` entry and the engine's
  per-push `analyzePhraseBuf` catches any phrase-fusion conflict via
  its existing rewind path. No xanax-specific check required.

### Guideline 2: whitespace

Whitespace in the cover does not carry bits. The phrase-fusion
constraint hinges on a single odd-one-out case: one bare space
character between two WORDs is the *only* whitespace shape that the
lexer doesn't tokenize. Every other whitespace shape (two or more
bare spaces, any tab, any newline, any carriage return, any form
feed, any vertical tab, alone or in any combination) becomes a
WHITESPACE token and acts as a phrase-fusion barrier. So the rule
isn't about character count or whitespace kind; it's about which
side of that "exactly one bare space" line a transformation lands on.

**Safe transformations:**
- Replace any tokenized-whitespace shape between two WORDs with any
  other tokenized-whitespace shape (`\t` to `\n`, `\n` to `\n\n`,
  `  ` to `\t`, etc.).

**Unsafe transformations:**
- Anything that crosses the "exactly one bare space" line. Replacing
  one bare space with two or more bare spaces (or with any tab,
  newline, or other whitespace) adds a barrier where there wasn't
  one. Replacing two-or-more bare spaces (or any tab or newline) down
  to one bare space removes a barrier that was there. Either flip
  changes phrase-fuser behavior and breaks round-trip.

**Built-in mitigations:**
- **lineBreak (formatter)**: `"expand"` replaces every `\n` with
  `\n\n`. Both `\n` and `\n\n` tokenize as WHITESPACE, so the barrier
  is preserved across the swap.

### Guideline 3: case

Case is normalized away at every lookup the decoder performs: dicts
are stored lowercase
(`memory/project_dicts_are_lowercase.md`); phrase-index lookup is via
`.toLowerCase()` (`js/src/lexer.js:375, 432, 481`); decoder dict
lookup is via `.toLowerCase()` (`js/src/decode.js:68`); WORD_RE's
`\p{Script=Latin}` matches both cases. Format tokens like `{Cap}` and
`{CAPSLOCKON}` only re-case at render time; the cased characters they
produce are normalized back at lookup. So any case transformation
across Latin-script WORDs preserves round-trip.

**Safe transformations:**
- Any case change to any Latin-script WORD or sequence of WORDs
  (allCaps, allLowercase, titleCase, sentenceCase, mid-word changes,
  mixed or random case).

**Unsafe transformations:**
- None for Latin-script WORDs. Non-Latin script in the cover rides
  through as catch-all PUNCT regardless of case and is unaffected.

**Built-in mitigations:**
- **case (formatter)**: enum across the four canonical case styles.
  All apply globally and round-trip via the dict's lowercase
  normalization.

### Guideline 4: punctuation

Punctuation in the cover does not carry bits. No dict entry contains
punctuation (the twlist build pipeline runs every entry through the
lexer and rejects embedded punct via
`js/src/builder/sources.js:22-23`); punct in the cover is emitted
deterministically by the sentence model and never consulted by the
decoder for bit recovery. The phrase-fusion constraint hinges on the
same word-adjacency rule as Guideline 2: any PUNCT token between two
WORDs acts as a barrier the fuser cannot cross.

**Safe transformations:**
- Replace any punct between two WORDs with any other punct, or change
  punct counts in the gap, as long as at least one tokenized barrier
  (punct or tokenized whitespace) remains between the WORDs.

**Unsafe transformations:**
- Anything that flips whether two adjacent WORDs have any tokenized
  barrier between them. Inserting punct between two WORDs that
  previously had only a single bare space adds a barrier where there
  wasn't one. Removing the only barrier between two WORDs (leaving
  only a single bare space) removes a barrier that was there. Either
  flip changes phrase-fuser behavior and breaks round-trip.

**Built-in mitigations:**
- None at present. No first-wave formatter touches punctuation
  (ellipsisNormalize, typewriterSpacing, quoteStyle, periodToSemicolon
  were all considered and dropped during architecture design).

## byos.json blocks

Four top-level blocks. Field shapes are locked.

### Universal field shape

Both `rewriter` and `reformatter` (the block formerly called
`formatter`) carry the same per-field shape:

```
{ "enabled": boolean, "intensity": int 0..100, "mode"?: string }
```

- `enabled` gates everything. When false, sortdct skips the field's
  twlist injection, the encoder never calls apply(), and the byosID
  omits the field entirely. UI may persist intensity + mode across
  toggles for sticky values.
- `intensity` is the "replacement probability %" for the
  per-emission coin flip. 0 disables the field as if `enabled:false`.
- `mode` is required when the field has a mode catalogue AND
  `enabled` is true; for unimodal fields (xanax) it is
  rejected.

byosID encoding is `<shortcode>=<intensity>[:<modeShort>]`:

| field        | shortcode | mode short codes                         |
| ------------ | --------- | ---------------------------------------- |
| `xanax`      | `xa`      |, (unimodal)                             |
| `british`    | `br`      | `u` (us-uk), `k` (uk-us)                 |
| `typos`      | `ty`      | `f` (forward), `r` (reverse)             |
| `voice`      | `vc`      | `pi` (pirate)                            |
| `case`       | `cs`      | `ac` `al` `tc` `sc` (more in next arc)   |
| `lineBreak`  | `lb`      | `ex` (expand), `co` (collapse)           |

### rewriter

Four fields, ordered top-to-bottom by per-emission run order:

```
"rewriter": {
  "british": { "enabled": false, "intensity":  0, "mode": "us-uk" },
  "typos":   { "enabled": true,  "intensity": 75, "mode": "forward" },
  "voice":   { "enabled": true,  "intensity": 50, "mode": "pirate" },
  "xanax":   { "enabled": true,  "intensity": 100 }
}
```

### reformatter

Two fields today (`case`, `lineBreak`). The expanded catalogue (case
`randomCaps` / `sentenceStartLower`, `sentenceEnd`, `voice`) lands
alongside the model-layer enhancer implementation in a later commit.

```
"reformatter": {
  "lineBreak": { "enabled": true, "intensity": 100, "mode": "expand" },
  "case":      { "enabled": true, "intensity": 100, "mode": "titleCase" }
}
```

- `lineBreak.mode`: `"expand"` (every `\n` to `\n\n`) or `"collapse"`
  (`\n\n` to `\n`).
- `case.mode`: `"allCaps" | "allLowercase" | "titleCase" |
  "sentenceCase"` (more modes in the next arc commit).

### envelope

Single semantic container, parameterized:

```
"envelope": {
  "type":           "eml",
  "fileNamePrefix": "message",
  "subject":        "Note"
}
```

- `type`: 16 existing envelope types from `js/src/envelopes.js`
  (eml, html, htmlActive, markdown, pdf, nroff, xml, python,
  javascript, cpp, java, perl, php, ruby, bash, go) plus `"none"`.
- `fileNamePrefix`: base name; wrappers and the envelope add their
  extensions (`.txt`, `.gz`, `.b64`, `.uue`).
- `subject`: only used by envelope types that surface it (eml, html,
  markdown, pdf). Inert for the rest.

### wrapper

Ordered byte-level encoding stack:

```
"wrapper": {
  "layers": ["gzip", "base64"]
}
```

- `layers`: ordered array, innermost first (matches existing
  `js/src/cover-pipeline.js` convention). Up to 5 layers per current
  nicetext convention. Each entry is a wrapper-type string: `"gzip"`,
  `"base64"`, `"uuencode"`.

UI display convention: "Layer 1 = outermost (what the recipient sees
first), Layer 2 = next inner, ...". JSON convention: first in array =
innermost. UI reverses for display.

## Pipeline

### Conceal (encode)

```
model stream
  -> reformatter chain (model -> model enhancers, in block order)
       case -> lineBreak -> sentenceEnd
  -> encoder
  -> rewriter chain (per-emission, in block order)
       british -> typos -> voice -> xanax
  -> envelope (wrap in semantic container)
  -> wrapper stack (byte-encoding layers, innermost first)
  -> final output
```

### Reveal (decode)

Strict inverse of conceal, but the only categories with explicit
strip logic are envelopes and wrappers. Rewriters and reformatters
require no decode hooks: all rewriter variants are 0-bit unique-type
singletons that look up to the same 0 bits regardless of which
variant was emitted; case is normalized at dict lookup; lineBreak is
invisible at lookup.

```
final output
  -> wrapper stack strip (outermost first, peel inward)
  -> envelope strip
  -> standard decode (dict-blind)
```

## Implementation contracts

### Rewriter interface

Each rewriter exposes two methods:

- `getRewriterUniqueTwlist() -> [{type, word}, ...]`
  Returns the 0-bit unique-type singleton entries that sortdct injects
  into the dict when this rewriter is enabled. Consumed by the unified
  sortdct injection pass. Small for some rewriters (xanax: 2 entries),
  larger for others (typos: one entry per canonical-variant pair).

- `apply(phraseBuf, ...) -> void`
  Per-emission entry point. Mutates the encoder's `phraseBuf` according
  to the rewriter's logic. Phrase-fusion conflicts are caught by the
  engine's natural per-push `analyzePhraseBuf` rewind path; the
  rewriter doesn't need its own check.

Internal runtime data (lookup maps, exception sets, trigger lists) is
implementation detail per rewriter. The shape varies: xanax holds two
`Set<string>` exception sets and a strict-ortho rule; typos / british /
voice hold a `Map<canonical, variant(s)>` derived from their own dict-
injection twlist.

### Storage strategy

Threshold for choosing between baked JS and SAB fixtures: roughly 1K
entries.

- **Baked JS** (small): xanax exception sets (~700), british
  (hundreds), voice (~30 per mode). Live in `fixtures/<rewriter>.data.js` as
  exported `const Set` / `const Map`. Initialized once at module
  import.
- **Shared SAB** (large): typos is the only candidate likely to cross
  the threshold depending on dataset size. If multiple rewriters
  cross the threshold and share the lookup shape
  (`Map<canonical, Set<variant>>`), they share one SAB format:
  `fixtures/<rewriter>.lookup.sab.gz` with both forward and reverse
  lookup support.

The choice is per-rewriter and abstracted behind the `apply()` method.
The encoder doesn't know which backend each rewriter uses.

### Module locations

JS-side homes for the four categories:

- **Rewriters:** `js/src/rewriter/<name>.js` (one file per rewriter,
  parallels `js/src/builder/`, `js/src/eve/`, `js/src/worker/`
  subdir convention; each module exports `getRewriterUniqueTwlist`
  and `apply`).
- **Reformatters:** `js/src/reformatter/<name>.js` (one file per
  reformatter; each exports `enhance(model, opts) -> model`).
  `js/src/reformatter/index.js` exports
  `wrapModelStreamWithReformatters(stream, byos.reformatter, rng)`
  which the encoder calls before consuming models.
- **Envelopes:** `js/src/envelopes.js`.
- **Wrappers:** `js/src/wrappers.js`.

### Source materials and build pipeline

Per-rewriter, source data lives at `fixture-src/rewriters/<rewriter>/`
(parallel to `fixture-src/twlist/`, `fixture-src/wlist/`, etc.):

- `fixture-src/rewriters/xanax/`: CMU-derived a/an exception
  research, classification library, inspect + corpus-sweep CLIs,
  research doc, builder fetch hook.
- `fixture-src/rewriters/typos/`: curated typo dataset, refresh tool.
- `fixture-src/rewriters/british/`: American-British spelling pairs.
- `fixture-src/rewriters/voice/`: per-mode canonical→variant pairs (pirate today).

Formatters have no source data (pure-JS surface transforms); no
`fixture-src/formatters/` dir exists.

Build pipeline: a single categorical `tools/build-rewriter-fixtures.js`
walks each enabled rewriter's `fixture-src/rewriters/<name>/` and
emits the appropriate artifact (`fixtures/<rewriter>.data.js` for
baked JS, or `fixtures/<rewriter>.lookup.sab.gz` for SAB). The
shape parallels existing `tools/build-twlist-fixtures.js` /
`tools/build-freq-fixtures.js`.

## Eve impact

Most cover-transforms are zero-cost for Eve analysis. The one
structural concern is the `case` reformatter: when active, Eve sees a
case-flattened cover and needs a case-flattened reference model to
match against. The build pipeline emits a `casefree-monotyped-model`
variant per card (derived from the regular monotyped-model in the
same build pass by stripping `{Cap}` / `{CAPSLOCKON}` /
`{capslockoff}` tokens). Eve picks the casefree variant when
`byos.reformatter.case.enabled` is true.

If multiple normalizing formatters compose (case + future
normalizers), one consolidated "normalized-monotyped-model" variant
per card is cleaner than a combinatorial set. Eve normalizes the cover
(lowercase + single-space + ...) before comparing against the
normalized reference.

Per-rewriter Eve detectors (likely / unlikely verdicts for each
enabled rewriter) are future work; each will follow the same pattern
as the xanax detector designed in
`fixture-src/rewriters/xanax/research.md`.

## Extension procedure

To add a new cover-transform:

1. Decide the category (rewriter / formatter / envelope / wrapper).
2. Identify the safety guidelines it must satisfy.
3. For a rewriter: implement `getRewriterUniqueTwlist()` and `apply()`;
   wire into the rewriter chain at the correct run-order position.
4. For a formatter: implement as a pure surface-string transform; wire
   into the formatter chain at the correct run-order position.
5. For an envelope: add a new `<type>ApplyTransform` /
   `<type>StripTransform` pair in `js/src/envelopes.js`; add the
   new type to the envelope enum.
6. For a wrapper: add a new wrapper-type to
   `js/src/wrappers.js`; add to the layers enum.
7. Add a "Built-in mitigations" entry to the relevant guideline(s) in
   this doc, naming the new transform and how it satisfies the
   guideline.
8. If the new transform is case-flattening or otherwise affects Eve
   analysis, add the corresponding model-variant fixture to the build
   pipeline.

## See also

- `fixture-src/rewriters/xanax/research.md`: the xanax CMU-driven
  a/an agreement research, phrase-fusion collision measurements, and
  apb-integration design rationale.
- `docs/architecture-sab.md`: SAB binary formats.
- `docs/builders.md`: dict and twlist build pipeline.
- `js/src/lexer.js`: phrase fuser and `analyzePhraseBuf`
  call sites.
- `js/src/encode.js`: `analyzePhraseBuf`, `phraseBuf`, the rewind
  path rewriters depend on.
