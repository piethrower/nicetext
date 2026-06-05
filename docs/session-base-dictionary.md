# Session-base Dictionary

The Advanced panel on `nicetext.html` builds a dictionary on the fly
from a picker of TW-list sources and, when a Story Style is chosen,
pairs it with that corpus's sentence-model. It replaces the old
two-dropdown (style, dictionary) Advanced panel. The curated cards in
the main panel hide while Advanced is in use, with no card ↔
Advanced-state mapping.

The artifacts the build produces:

- **session-base-dictionary**: the dictionary built from the picker
  selections. Lives in shared memory for the session, not on disk.
- **session-corpus-dictionary**: a corpus-restricted Huffman dict
  derived from the session-base entries plus the corpus vocabulary,
  with corpus word counts (and any selected frequency sources)
  weighting the Huffman codes.
- **session-model-table**: the sentence-shape table walked during
  encode, built by `genmodel` against whichever dict is active for the
  chosen Vocabulary Scope.

This is steganography, not cryptography. The picker is a codebook
variant, not a key. There is no secret in which sources you tick.

## Advanced panel controls

The panel replaces the old Style + Dictionary dropdowns with:

1. **Story Style** dropdown. Corpus name only (Aesop, JFK, Frankenstein,
   Moby Dick, and so on), plus "Flat" for the corpus-free random-words
   mode.
2. **Sentence Scope** dropdown. Model-replay options (random pick,
   sequential, etc.). Hidden when Story Style is Flat.
3. **Base-dictionary picker**. The grouped source table described in the
   next section.
4. **Vocabulary Scope** ("Use words from the story style"). On = encode
   uses the session-corpus-dict; off = encode uses the wider
   session-base-dict filtered to model-reachable types. Hidden when
   Story Style is Flat (Flat always uses the session-base-dict).
5. **Frequency picker**. Up to three external word-frequency sources
   (Norvig, Google Books, Project Gutenberg) plus a dynamic
   "<Style> frequencies" option for the corpus's own counts. Hidden
   when Vocabulary Scope is on (the corpus is the authority for
   weighting in that mode).
6. **Build button**. Opens the progress dialog and kicks off the worker.

At least one base-dict source must be selected for the build to run
(the worker throws `no base-dictionary entries selected` otherwise).

## Base-dictionary picker

The picker is a meta-driven grouped table, not a fixed list of
checkboxes. `renderAdvancedSourcesTable` in `js/app.js` reads
`twlistSourcesMeta` (`fixtures/twlist-sources.meta.js`, auto-generated
from `tools/build-twlist-fixtures.js`) and renders one checkbox row per
source, organized under group headers. The render allowlist is
`ADV_SOURCE_KEYS` in `js/app.js`; the per-group "use case" copy in the
header rows comes from `GROUP_USE_CASES`.

The shipped groups and their sources (source key in parentheses):

- **Emoji**: Emoji (`emoji16`), Emoji inspired word-only phrases
  (`emoji-cldr-names-16`), Common emoji combinations
  (`emoji-curated-phrases-16`), Filter weird emoji matches
  (`emoji16-curated-keywords`). The group also renders an emoji-preset
  pill row and the two cross-modal aug rows (emoji into words, words
  into emoji).
- **Jargon**: Modern words (`claude2026`), Programming keywords
  (`proglang-keywords`).
- **Morphology**: Word tags small set (`impkimmo`), Word tags large set
  (`impkimmo2026`), Contractions (`impkimmo2026-cform`).
- **Names**: Names and places (`mit`).
- **Numbers**: Numbers keep original form (`num-form-preserved`),
  Numbers swap digits and words (`num-form-interchangeable`), Roman
  numerals (`num-roman`).
- **Parts of Speech**: Parts of speech broad (`moby-pos`), Parts of
  speech standard (`wordnet`).
- **Poetry/Song**: Rhymes (`rhyme`), Syllable count (`cmu-syllable`),
  Stress pattern (`cmu-stress`), Alliteration (`cmu-alliteration`).
- **Synonyms**: Synonyms small set (`impf2p`), Synonyms standard
  (`wordnet-synonyms`), Synonyms very large (`moby-thesaurus`), Word
  roots (`impkimmo2026-root`).
- **Experimentation** (pinned to the bottom): Built-from-suffix flag
  (`impkimmo2026-drvstem`), Root part of speech (`impkimmo2026-rootpos`),
  Example Connector Words (`connectors`), plus the user-supplied custom
  TW-list upload row.

Group order is alphabetical with Experimentation last; rows within a
group are alphabetical by label. Adding a source means keeping four
in-sync lists named in the worker comment (`SOURCE_NAMES` in
`js/src/byos.js`, `SOURCE_LABELS` in `js/src/share.js`,
`ADV_SOURCE_KEYS` in `js/app.js`, `KNOWN_TWLIST_KEYS` in the worker).

`connectors` is the MIT card's grammar glue and is filed under
Experimentation: other sources already carry those joiner words with
richer types that `sortDict` prefers.

## Augmentations

- **MIT possessives** are baked into the `mit` fixture at build time
  (`tools/build-twlist-fixtures.js`), not toggled at runtime.
- **Cross-modal emoji augs** (emoji into words, words into emoji) run
  in-worker via `runAugsPacked`, gated on `emoji16` being among the
  selections. The CLDR keyword map and the optional curated-keyword
  filter (`emoji16-curated-keywords`) load lazily only when an emoji
  aug is on.
- **a/an agreement** is handled by the **xanax rewriter**
  (`js/src/rewriter/xanax.js`), which mutates the encoder's phrase
  buffer per emission with phonology-aware lookahead. The older
  begins-with-a-vowel augmentation it replaced is retired: the code
  survives in `js/src/builder/aug-impls-sab.js` for reference but is
  not wired into byos and is not a picker option.

## Fixtures

### TW-list fixtures

Each source ships pre-packed under `/fixtures/` as
`<key>.twlist.sab.gz`: a gzipped, zero-parse entries-SAB (NTEN
format), produced once at build time by `sab pack twlist`. There are no
`.twlist.tsv.gz` files. The worker loads a source with
`loadResource(key, 'twlist', { fixture: true })`, which fetches and
gunzips the SAB, then `unpackEntriesAsync(wrapEntriesSAB(sab))` walks
it into the `[{type, word}, ...]` array. The big morphology lists
(`impkimmo2026` family, ~3.4M entries) drop from seconds of TSV parse
to milliseconds of typed-array walk per session start.

Per-source labels for the progress modal live in `ADV_SOURCE_LABELS`
in `js/app.js`. Attribution lives on `attributions.html`.

### Corpus-text fixtures

Each Story Style references a pre-curated corpus shipped as
`<name>-curated.txt.gz` under `/fixtures/` (for example
`aesop-curated.txt.gz`). The corpora are already sliced to book content
during curation, so there is no runtime slicing step and no
`content-ranges.json` (Gutenberg boundary handling is the lexer's job
via its markers, not a runtime range table). The worker fetches the
corpus text with `fetchText(new URL(corpusFile, FIXTURE_DIR))`, where
`corpusFile` is the `build.corpus` relative path from the byos. A
custom Story Style instead uses the uploaded corpus text directly.

## Build pipeline

The build runs in `js/src/worker/build-session-worker.js`. It receives
one `build-session` message describing the selections, Story Style,
Sentence Scope, Vocabulary Scope, frequency picks, and the rewriter /
reformatter blocks, then walks the branches below. For the worker pool,
loader proxy, and SAB cache substrate this sits on, see
`docs/architecture-workers.md` and `docs/architecture-sab.md`; this
page does not duplicate them.

### Section 1: load and combine (all paths)

Load each selected twlist via `loadResource` + `unpackEntriesAsync` and
concat into `combined`. Apply the emoji augs (`runAugsPacked`) when
selected. Append voice-reformatter and rewriter singleton fixtures (also
`<key>.twlist.sab.gz`) when their byos blocks are on. Load any external
frequency fixtures (`loadResource(key, 'freq', { fixture: true })`) and
merge them with the optional corpus counts into one frequency map.

### Branch by Story Style and Vocabulary Scope

| Story Style | Vocab Scope | Artifacts built and posted |
|---|---|---|
| Flat | (hidden) | session-base-dict (full union, no type filter) |
| corpus | corpus | session-corpus-dict, session-model-table |
| corpus | base | session-base-dict (type-filtered), session-model-table |

- **Flat path**: `sortDictAsync` the full union →
  `buildDictionaryAsync` → `packDictToSABAsync`, post `base`.
- **Non-flat (always)**: load + tokenize the corpus
  (`listWordsWithCounts`), `restrictToVocabAsync` the combined union to
  corpus vocabulary, re-append voice singletons, `sortDictAsync`,
  `buildDictionaryAsync` (corpus counts plus any frequency picks weight
  the codes), `packDictToSABAsync` → corpus dict, then
  `generateModelTableAsync` against that corpus dict →
  `packModelTableToSABAsync` → model table.
- **Vocabulary Scope = corpus**: run `tableHasUsableModelsAsync` against
  the corpus dict (throws with corpus-too-short advice if no slot can
  carry bits), then post `corpus` + `model`. No base dict is built.
- **Vocabulary Scope = base**: the corpus dict above is internal
  scaffolding. Its merged-type set seeds a filter; `sortDictAsync` the
  full union, keep rows whose merged type the model can reach, union in
  the corpus-dict rows (to catch self-defined and voice words), then
  `buildDictionaryAsync` → base dict. Re-run the usability check against
  the wider base dict, then post `base` + `model`.

All stages reuse the browser-safe builder modules in
`js/src/builder/`. Every posted artifact is a packed SAB delivered to
the parent as `{type:'sab', kind, sab, ...}`; a final `{type:'done'}`
signals success and `{type:'error', error}` carries failures.

### SAB cache

Posted artifacts register into the parent-side resource cache for the
session so the encoder and decoder pick them up via `loadResource`
without re-fetching, and so flipping Vocabulary Scope or corpus during a
session reuses already-built pieces. The cache lives only for the
session. See `docs/architecture-sab.md`.

## Progress dialog

The Build button opens a modal that renders one row per active worker
step. The worker emits `load-progress` and `progress` messages for
loading, unpacking, sorting, Huffman-building, packing, and the
usability check; the modal mirrors them live. A Cancel button is wired
to the workers' AbortSignal pattern, and the modal dismisses on success.

## Stats

After a successful build the worker posts per-dict stats alongside each
SAB (`dictStats`): word count, type count, average bits per word, max
bits, and packed SAB size in bytes. The panel surfaces these for the
active dict.

## Out of scope

- Persistence. No localStorage, IndexedDB, or download-built-dict; the
  built artifacts live only for the session.
- Granular sub-toggles inside a source (no per-file selection within
  `mit`, `claude2026`, etc.).
- Mapping the curated cards to Advanced state. Cards hide while Advanced
  is in use.
