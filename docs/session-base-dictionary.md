# Session-base Dictionary

A new advanced feature on `nicetext.html` that builds a dictionary on
the fly from a checkbox-selected combination of TW-list sources, and
optionally pairs it with a corpus's sentence-model. Replaces the
existing two-dropdown (style, dictionary) Advanced panel. The curated
cards in the main panel hide while Advanced is in use, with no card
↔ Advanced-state mapping for now.

The artifact names used throughout:

- **session-base-dictionary**: the dynamically built dictionary from
  the checkbox picker. Lives in memory, not on disk.
- **session-corpus-dictionary**: a corpus-restricted Huffman dict
  derived from the session-base-dictionary plus the corpus vocabulary,
  with corpus word counts weighting the Huffman codes.
- **session-model-table**: the sentence-shape table walked during
  encode, built by `genmodel` against either the corpus dict or the
  base dict (depending on the Use Corpus toggle).

This is steganography, not cryptography. 254 valid base-dict
permutations is well inside trial-decode territory; the picker is a
codebook variant, not a key.

## Advanced panel: five controls

The panel replaces today's Style + Dictionary dropdowns with:

1. **Story Style** dropdown. Corpus name only: "Aesop's Style", "JFK
   Style", "Wizard of Oz Style", "Shakespeare Style", "Magical
   Creatures Style", "Tasting Notes Style", "Civic Oratory Style", and
   "Flat". No `mt-rnd:` / `mt-ord:` style-id baked in here.
2. **Sentence Scope** dropdown. Cleaned-up version of the existing
   model-replay options (random pick, ordered, etc., final list TBD).
   Hidden when Story Style is Flat. Default: random.
3. **Base-dictionary picker**. Eight checkboxes (see next section).
4. **Use words from the story style** checkbox. Checked = encode uses
   session-corpus-dict; unchecked = encode uses session-base-dict.
   Hidden when Story Style is Flat (Flat always uses session-base-dict).
5. **Build button**. Opens the progress dialog and kicks off the
   worker pipeline.

Validation, all gating the Build button:

- At least one base-dict checkbox required.
- "Begins with a Vowel" alone is rejected (it only augments other
  sources).

## Base-dictionary picker (eight checkboxes)

1. Synonyms (impf2p)
2. Parts of Speech (kimmo)
3. Names and Places (mit, possessives baked in, no separate toggle)
4. Numbers and Digits (numeric)
5. Rhymes (rhyme)
6. Modern Words (claude2026)
7. Connector Words (cfg-words)
8. Begins with a Vowel (vowel augmentation, only valid alongside one
   or more of 1 through 7)

All eight checked reproduces master's recipe (byte-equivalent to
`fixtures/master.dict.json.gz` modulo the `name` field).

## Augmentations: baked vs. dynamic

- **MIT possessives** bake into the fixture. Regular `'s` form for all
  non-place files (Alice's, Bob's). Family-only plural-possessive `s'`
  form for `name_family` (Smiths'). Two transforms ride together; not
  user-toggleable since "names without possessives" is not a real use
  case.
- **Vowel augmentation** runs in-worker, post-concat. Toggleable.
  Implementation matches the OG awk transform: any word starting with
  `[AEIOUHaeiouh]` gets a parallel `(begins_with_a_vowel, word)`
  entry. H counts deliberately, so the grammar can pick "an honest"
  vs. "a horse" without splitting silent-vs-sounded H.

## Fixtures

### TW-list fixtures

Pre-baked under `/fixtures/`:

- `impf2p.twlist.tsv.gz`
- `impkimmo.twlist.tsv.gz`
- `mit.twlist.tsv.gz` (bare MIT name list; no possessive augmentor)
- `numeric.twlist.tsv.gz`
- `rhyme.twlist.tsv.gz`
- `claude2026.twlist.tsv.gz`
- `connectors.twlist.tsv.gz` (cfg-words)
- `proglang-keywords.twlist.tsv.gz` (Programming Keywords; per-language
  `<lang>_<keyword>` singleton tags across 20 source files covering 12
  programming languages, 3 shells, and 5 command sets, see
  `fixture-src/twlist/proglang-keywords/`. Underscore-bearing originals
  like `is_array` and `__init__` are authored for forward compat
  against any future lexer loosening; today they are rule-2-rejected
  and the builder synthesizes `<lang>_split_<word>` fragments so the
  constituent WORDs still contribute vocabulary. Not enabled in any
  card fixture; opt-in per BYOS for code-corpus sessions.)
- `moby-pos.twlist.tsv.gz`, `moby-thesaurus.twlist.tsv.gz`,
  `wordnet.twlist.tsv.gz`, `wordnet-synonyms.twlist.tsv.gz`

Format: gzipped tab-separated `<type>\t<word>` per line, with
`# title:` and `# attribution:` header comment lines that the
parser skips. No JSON wrapper. Same shape as the custom-twlist upload
path so a single parser (`parseTwlistLines` in
`js/src/builder/sources.js`) handles both. Title shown in the build
modal's progress line lives in `ADV_SOURCE_LABELS` in `js/app.js`;
attribution lives on `attributions.html` (the `# attribution:` lines
in the fixture itself are a self-documenting copy, never parsed).

Total uncompressed bulk is on the order of master's source set
(roughly 10 to 15 MB, with kimmo and f2p dominating). HTTP gzip handles
wire cost.

### Corpus-text fixtures

The worker also needs corpus text. Approach: copy the source `.txt`
files from `fixture-src/texts/` into `/fixtures/` (e.g.,
`/fixtures/aesop.txt`), keeping the Gutenberg attribution headers
intact. Slicing to actual book content happens at runtime via
`fixture-src/texts/content-ranges.json` (also copied to `/fixtures/`),
matching the existing build-tool recipe.

Duplicating corpus content between `fixture-src/texts/` and `/fixtures/`
is acceptable. The eventual release shape (full corpora vs.
fixtures-only) is a later call.

## Build pipeline

### One-time fixture builder

`tools/build-twlist-fixtures.js`, called by `tools/build-all-fixtures.js`
as the first step. Reads the raw `.gz` and bare-wordlist sources from
`fixture-src/twlist/`, runs them through the existing browser-safe helpers
in `js/src/builder/sources.js` (`parseTwlistLines`, `expandMitlist`,
`expandNumeric`), and writes the gzipped TSV fixtures. Run during
development, not at runtime. No engine changes.

### Runtime worker

A worker receives a message describing Story Style, Sentence Scope,
the eight checkbox states (incl. vowel-aug), and Use Corpus. It builds
the artifact set determined by that combination.

| Story Style | Use Corpus | Artifacts built |
|---|---|---|
| Flat        | (hidden)   | session-base-dict |
| corpus-name | ✓          | session-base-dict, session-corpus-dict, session-model-table (against corpus dict) |
| corpus-name | ✗          | session-base-dict, session-model-table (against base dict) |

Within those, each step:

- **session-base-dict**: load each selected twlist via
  `loadResource(key, 'twlist', { fixture: true })`, the shared
  resource loader fetches `/fixtures/<key>.twlist.sab.gz`,
  gunzips, hands back an entries-SAB (NTEN format) that
  `wrapEntriesSAB` + `unpackEntries` turn into the
  `[{type, word}, ...]` array. No TSV parse on the hot path;
  the parse happened once at build time via `sab pack twlist`.
  Concat the per-source entry arrays, optionally
  `applyVowelAugmentation`, then `sortDict` + `buildDictionary`
  + `sab-pack`. The resulting session-base-dict SAB registers
  into the parent-side resource cache under a
  `pageLifeSpan:<byosId>` key so the encoder / decoder picks it
  up via `loadResource` without re-fetching.
- **session-corpus-dict** (Use Corpus only): fetch the corpus `.txt`
  fixture, slice by `content-ranges.json`, tokenize via
  `listWordsWithCounts` to get vocab + per-word counts, then
  `restrictToVocab` against the session-base-dict, then
  `buildDictionary({ frequencies: wordCounts })` so common corpus
  words get short codes. Then `sab-pack`.
- **session-model-table**: feed the sliced corpus text plus whichever
  dict (corpus dict if Use Corpus, else base dict) into `genmodel` to
  produce the sentence-shape table. Then `sab-pack`.

All three pure-JS pipelines reuse existing browser-safe modules
(`js/src/builder/`). No engine changes are required. The worker reads
each fixture as gzipped TSV text and runs `parseTwlistLines` on it,
the same parser the custom-twlist upload path uses, so there is one
TW-list ingestion code path across the codebase.

### SAB cache

Three artifacts at most live in the parent-side SAB cache (per
`docs/architecture-sab.md`, `docs/architecture-workers.md`), keyed
together so flipping between corpora during a session does not
rebuild artifacts already produced:

- `session-base-dict`: keyed by base-dict-id (a hash of the eight
  checkbox states, including vowel-aug).
- `session-corpus-dict`: keyed by `(base-dict-id, corpus-name)`.
- `session-model-table`: keyed by `(base-dict-id, corpus-name,
  use-corpus)` since the dict the model is type-indexed against
  changes by Use Corpus.

Cache lives only for the session.

## Progress dialog

Modal opened by the Build button. Shows per-step status as the worker
chain progresses (base-dict → corpus-dict → model-table). Carries a
Cancel button wired to the existing AbortSignal pattern in workers.
Dismisses on success.

## Stats panel

Shown alongside or below the Advanced panel after a successful build,
since the feature is advanced and the developer wants to see what they
got:

- Word count
- Type count
- Average code length (avg bits per word)
- Max code length (max bits)
- Output size in bytes / MB

Stats apply to the session-base-dict at minimum; if Use Corpus is on,
also surface the same stats for session-corpus-dict.

## Out of scope (this pass)

- Persistence (no localStorage, IndexedDB, or download-built-dict).
- Granular sub-toggles inside a category (no per-file selection within
  mitlist, claude2026, etc.).
- Mapping the existing curated cards to Advanced state. Cards just
  hide while Advanced is in use.

## Open

- Cleaning up the Sentence Scope option list (currently bundled in
  style-id; needs untangle).
- Stats panel exact layout / placement.
