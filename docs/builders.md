# Builders

Build-time tooling that turns raw corpora and word lists into the JSON
artifacts the runtime engine consumes. All build-time tools live under
`tools/` (Node CLIs) plus shared algorithm helpers in
`js/src/builder/`. Companion to:

- `docs/architecture-overview.md`: engine module surface
- `docs/architecture-sab.md`: runtime SAB binary formats
- `docs/fixture-src.md`: what raw corpora are checked in

## Dictionary JSON schema (current = v2)

```json
{
  "version": 2,
  "name": "mit",
  "types": [
    { "index": 1, "name": "name_male",   "wordCount": 2048 },
    { "index": 2, "name": "name_female", "wordCount": 4096 }
  ],
  "words": [
    { "word": "alice", "typeIndex": 2, "code": 1, "bits": 12 },
    { "word": "bob",   "typeIndex": 1, "code": 1, "bits": 11 }
  ]
}
```

Codes are **genuine Huffman codes**: per-word `(code, bits)` pairs,
where `bits` is that word's code length. Different words in the same
type can have different `bits` values (true variable-length, not
fixed-length-per-type). For example, `fixtures/mit.dict.json.gz` has 20 of 37
types with mixed bit widths internally.

The thesis-era "words per type = exact power of 2, fixed-length per
type" property is *not* enforced by current builders. The actual
`wordCount` distribution is wide (e.g., `mit.dict.json` has wordCount =
3, 5, 9, 10, 24, 34, 41, 43, 74, 107, 307, 330). Decision was: prefer
density (Huffman packs more bits per word in the common case) over
the simpler thesis-property invariant.

Invariants enforced by builders:
- Every word lowercase
- Every word unique across the entire dictionary
- Every `(typeIndex, code, bits)` triple unique (Huffman codes are
  prefix-free per type)
- `code` is a non-negative integer; `bits` is its length in bits
  (0 when `wordCount === 1`)
- Types sorted alphabetically by name; `index` starts at 1 (0 reserved)
- Types are contiguous from 1 (the SAB packer in
  `js/src/builder/sab-pack.js` validates this)

Word codes in dict JSON are stored as integers (not bit-strings):
`{ "word": "alice", "typeIndex": 7, "code": 42, "bits": 12 }`. The
`bits` field lives **per word**. This saved ~1 MB on master.dict.json over
the bit-string format and removed the silly
`for ch of code: bits = (bits<<1)|(ch==='1')` walk in decode.

## Master / corpus dictionary tools (byos.json-driven)

All bake-time tools read their settings from `tools/byos/*.byos.json`
canonicals. The byos.json's `name` field determines the output stem;
the public spec (sources, augmentations, story, frequencies,
tieBreak) drives the build. Each builder writes a **native
intermediate** (`.dict.json.gz`, `.model.json.gz`, `.twlist.tsv.gz`);
the final step of `tools/build-all-fixtures.js` runs
`node tools/sab.js pack <category>` which compiles each native to
the canonical runtime SAB fixture (`.dict.sab.gz` / `.model.sab.gz`
/ `.twlist.sab.gz`) and deletes the native. The shipped form in
`/fixtures` is SAB-only; natives are transient. The build-guard
discipline lives in `tools/sab-fixtures-guard.js`.

- `tools/build-base-dict.js <byos.json>`: builds the native
  `fixtures/{byos.name}.dict.json.gz` for any byos with
  story.style='flat'. Replaces the pre-byos `build-master-dict.js`
  and `build-mit-dict.js`. Source names map 1:1 to twlists.
- `tools/build-corpus-dict.js <byos.json>`: builds a distribution
  dictionary D' = master ∩ vocab(corpus) for any byos with a non-flat
  story. Master TWLIST is loaded via `tools/byos/master.byos.json`'s
  base block (the canonical base for every corpus dict). Corpus path
  comes from byos.build.corpus. Self-defined `(word, word)` entries
  are emitted for vocab words not covered by master.
- `tools/build-model-table.js <byos.json>`: emits the native
  `fixtures/{byos.name}.model.json.gz` by tokenizing byos.build.corpus
  against the byos's already-built corpus dict. byos.story.sentence
  drives the dedupe flag (`random`→dedupe=true,
  `sequential`→dedupe=false).
- `tools/build-all-fixtures.js`: orchestrator. Iterates every byos in
  `tools/byos/`, dispatches to the right per-card builder, then emits
  `fixtures/cards.json` (the runtime nickname registry).
- Shared algorithm helpers in `js/src/builder/sources.js`:
  `parseTwlistLines`, `expandMitlist` (bare flatten only; the
  pos/posplr possessive augmentor was vestigial and is gone),
  `expandNumeric`, `applyVowelAugmentation`, `restrictToVocab`.
  Browser-safe.
- Shared Node-side helpers in `tools/byos-build-helpers.js`:
  `loadByosFile`, `loadFixtureTwlist`, `loadBaseTwlist`, `buildBaseDict`,
  `reportDictStats`.

## buildDictionary opt-in invariant

`buildDictionary(mtwlist, opts)` (in `js/src/builder/dct2mstr.js`) is
called from three sites with two different `opts` shapes:

- `tools/build-base-dict.js` (via `byos-build-helpers.buildBaseDict`):
  `{ name: byos.name, frequencies: null, tieBreak: byos.base.tieBreak }`.
  Phase 1: byos.base.frequencies is informational metadata; Phase 2 will
  wire it to load named freq fixtures.
- `tools/build-corpus-dict.js`: `{ name, frequencies: corpusWordCounts }`.
- `js/src/worker/build-session-worker.js` (BYOS): passes `frequencies`
  built from the user's checked freq sources or the corpus
  word-counts.

**Invariant: every new option in `buildDictionary` must default to
the existing behavior, and consumers opt in explicitly.**

Why this matters: today's master / mit fixtures are baked uniform-
weight because their tools don't pass `frequencies`. If a future
option (e.g. length-desc Huffman tie-break, see research-notes §12)
lands with the new behavior as the default, the next
`node tools/build-all-fixtures.js` silently rebuilds master / mit with
different bit assignments, a stealth change to every shipped
fixture. Keeping new behavior opt-in means master / mit and the chip
dicts stay byte-stable across engine evolution unless their bake-time
tool explicitly opts in (a separate, visible edit per tool).

This is also why BYOS can grow new knobs (the freq-source picker
today, length-desc tie-break tomorrow) without touching shipped
fixtures: the session-worker passes the new option, the bake-time
tools don't, the engine handles both paths from one code surface.

## Sentence-model-table tool

- `tools/build-model-table.js <corpus.txt> <dict.json> <out.json>`,
  uses `js/src/builder/genmodel.js` to walk the corpus, tokenize via
  the shared lexer, and emit one model per sentence. Model tokens are
  either type-indices (integers into `typeNames[]`) or punct strings.

`tools/build-model-table.js` accepts `--ordered` to skip dedupe, every
sentence becomes its own entry in document order with weight=1,
enabling true sequential replay (vs. the dedupe-then-replay-by-frequency
approximation). Used by `story.sentence=sequential` cards.

Tables use a compact token format on disk: each token is either a
number (typeIndex into the dict) or a string (punct value).
`modelTableStream` expands to the structured `{kind, ...}` form on
demand.

## OG dictionary architecture (confirmed)

The OG database Makefile builds **two master-style dictionaries** plus
per-corpus distribution dicts:

- `mstrdict.dat`: built from `complete.twl` which is the cross-merge
  of kimmo + rhyme + f2p + mitlist + numeric + vowel-augmentation.
  Matches our `fixtures/master.dict.json.gz` (452,242 vs 452,260 entries, within
  18).
- `syndict.dat`: built from impf2p (synonyms) **alone**. Single-source,
  no cross-merging.
- Per-corpus dicts (`fabldict`, `jfkdict`, `wizwordsdict`, ...) restrict
  either master to a corpus's vocabulary.
- Variants like `fablsyndict` use the syn dict as base instead of
  master.

Same builder, different source selection. The "POS or rhyme as just
another dictionary" pattern is what the OG does for synonyms, and is
supported by our existing `tools/build-base-dict.js`: just author a new
`tools/byos/<name>.byos.json` with a different `base.sources` list,
re-run `tools/build-all-fixtures.js`, and the new dict shows up under
its own nickname-driven filename.

## Density vs. type-richness tradeoff

After sortdct merges multi-typed words, kimmo+rhyme+f2p cross-product
produces a unique type for almost every word. That's great for grammar
precision (you can ask for "a verb of type V_BaseFin- that rhymes with
Y") but terrible for encoding density (most types end up with 1 word,
carrying 0 bits). The thesis acknowledges this tradeoff (Ch. 4.3-4.4).
Future work: optional `--sources=` flag on the master builder to let
users dial in the kimmo-only subset for higher density.

## GUTENBERG_END handling (fixed)

Project Gutenberg files start with a long legal notice ending in a
`*END*THE SMALL PRINT! ... *END*` marker. The lexer recognizes this as
a `GUTENBERG_END` token. `listword` discards everything counted before
the marker so corpora vocabularies reflect actual book content, not
the boilerplate. Initially this was reversed (we were stopping at the
marker, missing the entire book), fixed.

## Reference build artifacts

Dictionaries (built by `tools/build-base-dict.js` +
`tools/build-corpus-dict.js`, then compiled to SAB by `sab pack
dict`). Shipped filename = `fixtures/<getBYOSID>.dict.sab.gz`; for
canonical premade cards, `getBYOSID` resolves to the rev-suffixed
short nickname (e.g. `master-1`, `aesop-1`):

- `fixtures/mit-1.dict.sab.gz`: 25 types, 20K words, ~12 bits/word. Good for grammar tests.
- `fixtures/master-1.dict.sab.gz`: full master, 51K types, 156K words, ~6.6 bits/word.
- `fixtures/jfk-1.dict.sab.gz`: JFK Inaugural corpus dict, 545 types, 557 words.
- `fixtures/aesop-1.dict.sab.gz`: Aesop's Fables corpus dict, 5K types, 5K words.
- `fixtures/wizoz-1.dict.sab.gz`: Wizard of Oz corpus dict, 2.8K types, 2.9K words.
- `fixtures/shakespeare-1.dict.sab.gz`: Shakespeare corpus dict, 25K types, 28.5K words.
- `fixtures/claude-magical-1.dict.sab.gz`: Magical Creatures corpus dict (45.7K-word source), 5.3K types, 5.7K words.
- `fixtures/claude-tasting-1.dict.sab.gz`: Claude Tasting Notes corpus dict (55.4K-word source), 5.8K types, 6.2K words.
- `fixtures/claude-oratory-1.dict.sab.gz` (Claude Oratory corpus dict (45.7K-word source), 3.3K types, 3.4K words. Low density (0.13 avg bits/word, 5 max)) civic-ceremonial vocabulary is small and many words are self-defined single-word types.

Sentence model tables (built by `tools/build-model-table.js` from the
matching corpus + corpus dict, then compiled to SAB by `sab pack
model`):

- `fixtures/jfk-1.model.sab.gz`: 50 unique sentence shapes from JFK Inaugural
- `fixtures/aesop-1.model.sab.gz`: 1.9K unique shapes from Aesop's Fables
- `fixtures/wizoz-1.model.sab.gz`: 2.2K unique shapes from Wizard of Oz
- `fixtures/shakespeare-1.model.sab.gz`: 64.7K unique shapes from the complete works
- `fixtures/claude-magical-1.model.sab.gz` (1.3K unique Magical Creatures shapes (avg model length 41.2) long incantatory sentences)
- `fixtures/claude-tasting-1.model.sab.gz` (3.9K unique shapes (avg model length 17.7) short ritualized notes)
- `fixtures/claude-oratory-1.model.sab.gz` (2.7K unique shapes from 2.7K sentences (avg model length 21.1) sweeping ceremonial cadence)

Some corpus stats above slightly precede the worker arc, current
master.dict.json is closer to 52,500 types, 190,950 words. The exact numbers
shift as corpora are rebuilt; don't treat them as hard contracts.
