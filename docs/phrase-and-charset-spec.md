# Phrase-and-charset spec

Approved design decisions for six related extensions to nicetext's
tokenization, dictionary, encoder, and decoder. This file is the
specification (the *what*). Implementation sequencing lives in a
separate build plan; sequencing decisions there can change without
re-opening these design questions.

The six items are packaged together because they all touch the
lexer + dictionary + encoder/decoder contract. Designing them
independently risked re-doing each one when the next landed.

- A. UTF-8 base (replacing the ASCII-only assumption)
- B. Latin-letter support in WORD_CHAR
- C. Emoji as words (Emoji16 TW-list + cross-modal augmentations)
- D. Phrases as tokens (multi-word dictionary entries)
- E. End-of-sentence punctuation runs and intra-sentence whitespace
- F. Emoji-phrases (multi-emoji and emoji-plus-word phrases)

D is the structural item; A, B, C, E ride on top of it; F falls out
of D + C.

---

## A. UTF-8 base

### Decision

UTF-8 is the canonical encoding throughout. ASCII-only assumptions are
removed where they exist.

### What's already true

The payload (secret) side is already byte-transparent end-to-end:

- `getSourceBytes()` (`js/app.js:2293-2296`) reads the textarea via
  `new TextEncoder().encode(...)`, which always emits UTF-8.
- `encode.js` writes cover bytes via the same `TextEncoder`.
- `decode.js` displays recovered bytes via
  `new TextDecoder('utf-8', { fatal: true })` (`js/app.js:327`); fatal
  mode falls cleanly into the existing "(binary: N bytes ...)"
  preview path for non-UTF-8 byte sequences (e.g., ciphertext).

So payload-side UTF-8 needs no work; it has been working all along.
The "ASCII only" framing in old docs applied strictly to **cover-side
tokenization**, not to the secret.

### What needs to change

Cover-side. See B for the WORD_CHAR change. See E for whitespace
handling. The "UTF-8 base" decision is mostly a renaming/clarifying
move that records the existing reality and removes ASCII-only language
from comments and docs.

---

## B. Latin-letter support in WORD_CHAR

### Decision

WORD_CHAR uses the Unicode property `\p{Script=Latin}`. Words consist
of Latin-script letters only, plus the existing word-extender chars
`0-9 & # @ $ % * +`. Emoji become WORD tokens via the separate path
in §C. Everything else in UTF-8 (CJK, Cyrillic, Greek, Arabic, math
symbols, currency symbols, etc.) is punctuation.

### Rationale

Three options were considered:

1. Stay ASCII-only (`[A-Za-z0-9&#@$%*+]`). Fails for any non-English
   text; loses accented-Latin words like `café`, `naïve`, `Dvořák`.
2. Latin-script only (`\p{Script=Latin}`). Adds Western/Central
   European languages cleanly; CJK, Cyrillic, Greek, etc. fall
   through to punctuation handling.
3. Any letter (`\p{L}`). Admits all scripts as WORD tokens. Non-Latin
   words then sit in the lookup path as zero-bit unknowns, which
   technically round-trips but mixes "real word, no dict entry" with
   "this isn't a word at all" along the same code path.

Option 2 is the chosen path because:

- Sharp word/non-word boundary. Word = Latin letter, or emoji per
  §C. Non-word = punctuation. No third "word but ignored" category.
- The existing TW-list lexer-round-trip gate (`parseTwlistLines`
  rule 2: word column must lex to a single WORD token equal to
  itself) rejects any twlist line whose word column contains a
  non-Latin-non-emoji character. Same mechanism that rejects
  malformed entries today; no special-case code.
- Non-Latin scripts in user-pasted corpora are captured as PUNCT and
  preserved literally in the model and cover via §E's
  literal-preservation path. They survive end-to-end without
  contaminating the dictionary.

### Consequences for non-Latin scripts

CJK / Cyrillic / Greek / Arabic / Hebrew / Devanagari / etc. lex as
PUNCT tokens. Behavior at each pipeline stage:

- **Dictionary (TW-list ingestion)**: any line whose word column
  contains a non-Latin-non-emoji character fails
  `parseTwlistLines` rule 2 (the word would lex as PUNCT, not as a
  single WORD token equal to itself). Rejected with the existing
  `lexer-rejected` reason. No new gate; no special-case code.
- **Model (genmodel from corpus)**: non-Latin runs in a corpus emit
  as PUNCT tokens whose value is the literal string. Genmodel's
  existing `pushPunct(tok.value)` path stores them as inter-word
  literal puncts. Same path as `!!!\n!!!` or any other arbitrary
  punct/whitespace run (see §E).
- **Encode (cover output)**: model PUNCT tokens emit verbatim via
  `fmt.emitPunct(value)`. A model built from a corpus that contains
  Chinese paragraphs produces cover text containing those Chinese
  paragraphs literally.
- **Decode (cover → bits)**: PUNCT tokens skipped at
  `decode.js:47` (`if (tok.type !== TOKEN.WORD) continue`). Zero
  bits consumed. Round-trip safe.

Combined effect: any UTF-8 content the developer pastes into a
corpus survives end-to-end into cover regardless of script. None of
it carries bits; all of it preserves layout.

### Steganographic angle

Cover text containing accented Latin words (`café`, `naïve`,
`Dvořák`) reads naturally for Western European prose. Cover text
containing non-Latin-script content reproduces the corpus's
non-Latin content verbatim (paragraph breaks and all) without
breaking decoding. The upgraded system targets Latin + emoji as
bit-bearing scripts; everything else rides along as
preserved-literal punctuation.

### Behavior table

Assuming `\p{Script=Latin}` for WORD plus emoji-cluster recognition
(prepared in this step as PUNCT, reclassified to WORD in §C):

| Input | gendict | genmodel | nicetext (encode) | scramble (decode) |
|---|---|---|---|---|
| **Latin word** (`café`, `Dvořák`) | Lexer emits as WORD. TW-list rule-2 gate accepts. | Captured under its assigned type. | Bit-bearing slot. | `lookupWord` finds entry; bits consumed. |
| **CJK run** (any length) | Lexer emits as PUNCT (catch-all rule). TW-list rule-2 rejects. | Captured as literal inter-word punct via `pushPunct(tok.value)`. | `fmt.emitPunct(value)` writes literal verbatim. | Skipped at `decode.js:47`. Zero bits. |
| **Cyrillic / Greek / Arabic / etc.** | Same as CJK. | Same. | Same. | Same. |
| **Emoji** (single or sequence) | After this step: PUNCT cluster, gate rejects in twlist context. After §C: WORD, gate accepts. | After this step: literal punct. After §C: bit-bearing if in dict. | After this step: emit verbatim. After §C: bit-bearing slot. | After this step: skipped. After §C: bit-bearing if in dict. |

### Lexer mechanics

WORD_CHAR becomes `[\p{Script=Latin}0-9&#@$%*+]` (regex with the `u`
flag). The contraction APOS_SUFFIX broadens from `'[A-Za-z]{0,2}` to
`'[\p{Script=Latin}]{0,2}` so Latin-extended contractions round-trip.
The `[DdOoLl]'` PREFIX is unchanged (those are ASCII-Latin name
prefixes).

PUNCT becomes a two-tier classifier in `PATTERNS`, ordered:

1. The existing specific-char list (`,;:()<>"=~+_` plus ellipsis)
   continues to match first, so its members keep their identity as
   distinct one-char tokens.
2. New catch-all rule: any code point that is not Latin letter, not
   digit, not word-extender, not whitespace, not EOS terminator, not
   emoji cluster, not Gutenberg marker, lexes as PUNCT. The catch-all
   eagerly consumes consecutive non-word characters into a single
   PUNCT token, capped at `ABSOLUTE_TOKEN_CAP`.

Eager consumption matters: a 200-char Chinese paragraph lexes as one
PUNCT token of value 200 chars (preserved verbatim), not as 200
separate single-char PUNCT tokens. Models stay tractable; cover
output stays faithful.

---

## C. Emoji as words

### Decision

Emoji are admitted as WORD tokens via `Intl.Segmenter` grapheme
recognition (or equivalent regex over `\p{Extended_Pictographic}` +
ZWJ/skin-tone/regional-indicator rules). A new TW-list source
`Emoji16` ships emoji as bit-bearing dictionary entries, organized
into semantic groups derived from Unicode CLDR.

### Architecture

Four independent levers, each opt-in via byos:

- **Emoji16 TW-list** (parallel to moby/wordnet; not folded into
  master). Source: `emoji-test.txt` from Unicode 16.0
  (`unicode.org/Public/emoji/16.0/`), filtered to fully-qualified
  entries. Types are `em16_<snake_case_subgroup>` derived from
  Unicode's group/subgroup headers (`em16_plant_flower`,
  `em16_face_smiling`, `em16_flag`, etc.). Augmentation keyword data
  for A, B, and mix comes from CLDR `annotations.xml` /
  `annotationsDerived.xml` of the matching CLDR release.
- **Augmentation A: emoji into existing word types.** For each
  emoji E with CLDR keyword `k`, look up the literal word `k`
  across every twlist the byos has selected. For every `(T, k)`
  pair found in any source (T = whatever type that twlist row
  carries, regardless of which source), emit `(T, E)` as a new
  twlist row. Mechanism is **type-blind**: types are opaque tags,
  never parsed. The emoji ends up under every type its keyword
  landed in, across all sources. Existing word types occasionally
  render as emoji.
- **Augmentation B: words into emoji types.** Inverse of A. For
  each emoji E in type T_E (its `em16_<subgroup>`) with CLDR
  keyword `k`, if `k` exists as a word value anywhere in the
  selected twlists, emit `(T_E, k)` as a new twlist row. The word
  `k` picks up T_E in its compound type at dict-build time. Emoji
  types occasionally render as words.
- **Mixed phrases (folded into Aug A and Aug B).** Phrase variants
  emit alongside A's and B's atomic emits. Controlled by an integer
  `base.augment.mixedPhrases` (0..MIX_MAX, currently 10). Per
  (emoji E, CLDR keyword k, target type T) tuple at mix=N:
  - The atom `(T, E)` (A-side) or `(T_E, k)` (B-side) emits
    unconditionally as long as A or B respectively is on.
  - For n in 1..N: emit the word-phrase `(T, "k E×n")` (A-side)
    or `(T_E, "k E×n")` (B-side), a single keyword followed by
    the emoji repeated n times.
  - For n in 2..N: additionally emit the bare-repeat `(T, "E×n")`
    or `(T_E, "E×n")`. n=1 is omitted because the bare-1 form
    is just the atom.

  Total mix-attributable emits per tuple = 2N − 1 (one word-phrase
  at each of N levels + one bare-repeat at each of N−1 levels ≥ 2).
  Real chat-register patterns: `omg 💀💀💀`, `love it 💖💖💖💖`, `😂😂😂`.

  Direction is single (`"k E×n"` only, word-first) for natural
  chat register; the reversed `"E×n k"` form is skipped. Mix is
  gated by Aug A or Aug B being on (a phrase with no atomic peer
  in the same slot would have no constituent to compete against).
  When mix=0 (default), no phrase variants emit and A/B behave
  exactly as their pre-mix versions.

  An earlier draft of this spec had three modes (false/narrow/wide)
  with mix as a separate aug pass; the wide mode produced
  incoherent type-walked pairs (`sad 😀`, `cat 😀`) on POS and
  morphology classes and was retired. The integer-knob design
  above scales output linearly with N, every entry stays
  semantically anchored to the CLDR keyword, and the algorithm
  is a tiny addition inside A's and B's existing emit loops.

The asymmetry between A (many destinations per emoji-keyword pair)
and B (one destination per emoji-keyword pair) is intentional. A
single word like `cloud` polysemously inhabits many types
(noun, verb, moby_cloud, kimmo morphology classes, ...), so Aug A
fans out to every type the word lives in. An emoji is already
canonically classified by its Unicode subgroup (☁️ → `em16_weather`,
period), so Aug B has exactly one home type to propagate the word
into. Both passes remain type-blind: neither parses any type
string; the difference is purely a consequence of where polysemy
lives in the data (words yes, emoji no).

Worked example for Aug A. ☁️ has CLDR keyword `cloud`. Suppose the
selected twlists contain these `(type, cloud)` pairs (illustrative,
type names from different sources):

```
twlist-1: noun, cloud
twlist-1: verb, cloud
twlist-2: moby_noun, cloud
twlist-3: 3sp#_df2SDf234, cloud
twlist-3: 4ds_d2, cloud
```

Aug A emits five new rows:

```
noun, ☁️
verb, ☁️
moby_noun, ☁️
3sp#_df2SDf234, ☁️
4ds_d2, ☁️
```

Each one feeds the existing compound-type-assembly pipeline like
any other twlist row. After dict-build, ☁️'s compound type tag is
the union of every type that any of its CLDR keywords landed in.
Encoder picks any of those types → ☁️ is in the candidate pool.
The augmentation never inspects what `3sp#_df2SDf234` means; it
just propagates the symbol along the existing word-to-types graph.

Useful regimes:

- **Emoji16 only**: pure emoji slots interleaved with Latin
  ("Shakespeare with emoji").
- **Emoji16 + Aug A**: mostly Latin with occasional emoji
  substitutions.
- **Emoji16 + Aug B**: mostly emoji with occasional Latin
  substitutions.
- **Emoji16 + Aug A + Aug B**: maximum cross-modal mixing.
- **Crank `mixedPhrases` ≥ 1 on top of A and/or B**: phrase variants
  (`happy 😀`, `wave 👋👋`, `cloud ☁️☁️☁️`) compete with their
  constituents on every relevant typed slot. Higher N adds
  emoji-repetition variants for chat-register density.

### Naming convention

The TW-list is keyed to the Unicode emoji version (`Emoji16`, not
`Emoji`) because each Unicode revision adds and reclassifies
emoji. Pinning the version freezes our snapshot of the codebook so
older clients can decode covers built with the current set. Future
bumps land as `Emoji17`, `Emoji18`, etc., as separate sources; old
covers keep decoding because their dict carries the snapshot's
codebook embedded. (`claude2026.twlist` uses calendar-year keying
because there is no canonical Claude release schedule; Unicode
emoji is the opposite case.)

### TW-list shape and grapheme clusters

On-disk format is the existing TSV: `type<TAB>value`, one entry per
line, with `# title:` and `# attribution:` header comments. Each
value is exactly one grapheme cluster: single emoji, ZWJ sequence,
skin-tone-modified emoji, regional-indicator flag pair, or
variation-selector cluster.

Example entries spanning the cluster shapes:

```
em16_plant_flower	🌹
em16_plant_flower	💐
em16_face_smiling	😀
em16_weather	🌧️
em16_person_gesture	👋
em16_person_gesture	👋🏻
em16_person_gesture	👋🏽
em16_flag	🇺🇸
em16_flag	🇫🇷
em16_family	👨‍👩‍👧‍👦
```

The lexer's emoji-cluster recognition (introduced in §B as PUNCT,
reclassified to WORD here) handles each shape:

- Single supplementary-plane emoji (`🌹`): one grapheme cluster, 4
  bytes UTF-8, 2 UTF-16 code units.
- BMP emoji-symbol with variation selector (`🌧️` = `🌧` + U+FE0F):
  one grapheme cluster, 6 bytes UTF-8, 2 UTF-16 code units.
- Skin-toned emoji (`👋🏽` = `👋` + U+1F3FD): one grapheme cluster,
  8 bytes UTF-8, 4 UTF-16 code units.
- Regional-indicator flag (`🇺🇸` = U+1F1FA + U+1F1F8): one grapheme
  cluster, 8 bytes UTF-8, 4 UTF-16 code units.
- ZWJ family (`👨‍👩‍👧‍👦`): one grapheme cluster, 25 bytes UTF-8, 11
  UTF-16 code units.

The TW-list import gate (`parseTwlistLines` rule 2: lexer round-trip
check) is the authoritative validator. An entry is accepted iff its
value lexes as a single WORD token equal to itself. Same gate the
runtime lexer uses, so what passes at bake time is exactly what the
runtime recognizes.

### Word-phrase companion fixture

Companion fixture `fixtures/emoji-cldr-names-16.twlist.tsv.gz` carries
CLDR-derived word-phrases, typed by the same verbatim subgroup
labels used by `emoji16.twlist.tsv.gz`. Built once at
fixture-bake time by `fixture-src/twlist/emoji16/fetch.js`, not at
runtime; consumers see it as a normal twlist source like any other.

For each emoji E in subgroup S, for each multi-word CLDR keyword P
attached to E (single-word keywords are skipped, since Aug B
already handles them), emit `(em16_S, P)`. Examples:

```
em16_country_flag	United States       (from 🇺🇸)
em16_country_flag	United Kingdom      (from 🇬🇧)
em16_country_flag	South Korea         (from 🇰🇷)
em16_time	alarm clock                 (from ⏰)
em16_food_prepared	French bread       (from 🥖)
em16_book_paper	rolled-up newspaper    (from 🗞)
```

The phrase value is the literal CLDR keyword string in canonical
single-space form (phrase support per §D).

Cross-modal mixing happens via shared type labels: 🇺🇸 (typed
`em16_country_flag` in the emoji fixture) and `United States`
(typed `em16_country_flag` in the phrases fixture) merge into the
same compound-type pool when both fixtures are selected. No new
runtime code paths; standard compound-type assembly does the work.

Type-blind: no semantic mapping. We never decide 🇺🇸 is "a country";
we just propagate Unicode's `country-flag` subgroup label verbatim
(snake-cased to `country_flag` for type-name normalization). The
shared label is what makes cross-modal substitution work.

Multi-emoji phrases (e.g. `🌧️ ☔` for weather, `🌹 💐` for flowers)
are hand-curated for v1 in a small data file under
`fixture-src/twlist/emoji16/`. For each entry, the bake-time builder
emits two rows: the emoji-phrase under its declared subgroup type
(in the emoji fixture), and the corresponding word-phrase derived
by primary-keyword substitution under the same type (in the
phrases fixture). The substitution is gated on an all-words-exist
check: each constituent word of the candidate phrase must appear
as a value in some other selected twlist, otherwise the
word-phrase is dropped (don't fabricate phrases out of words
nobody else recognizes).

### Curated keyword filter

Optional companion fixture `fixtures/emoji16.curated-keywords.tsv.gz`
ships a hand- or AI-curated list of CLDR keywords approved for
augmentation use. One keyword per line, optional comment column.
When a byos selects this fixture, Aug A and Aug B (including their
folded mix-phrase emits) filter their CLDR keyword input through
the list: only listed keywords drive augmentation. When the fixture
is not selected, augs use the full CLDR keyword set (mechanical,
noisier behavior).

Purpose: clean up cross-modal noise. CLDR keywords skew toward
search-friendly labels (`face`, `person`, `symbol`, `smiley`,
`smiling`, `emotion`), which produce stilted aug output
(`face 😀`, `smiley 😀`). The curated list restricts augs to
keywords that pair naturally with their emoji (`happy`, `wave`,
`cloud`, `rose`, `umbrella`, `tired`, `excited`).

Generation: a one-time AI-curation pass produces the list using
heuristic rules (keep concrete nouns, emotion adjectives, and
specific actions; drop generic descriptors and stilted verb forms).
Plain-text format; refinements re-bake the fixture at any time.

Type-blind preserved: NiceText itself doesn't know which keywords
are "good." The list is data, the same shape as any other curated
fixture content. The curation is an externalized decision shipped
as a file, comparable to how moby/wordnet/CLDR ship their own
curated content.

Resolves the spec's earlier "Augmentation strictness for cross-modal"
open question.

### Steganographic value

Covers a register (modern social/casual chat) that bland prose
covers don't reach. Variant-rich types (large semantic groups give
~2-3 bits per slot before subtype/Huffman tricks) provide good
encoding density.

---

## D. Phrases as tokens

### Decision

Multi-word entries are first-class TW-list values. Their type is the
phrase's part of speech, not the type of any constituent word.
Dictionary lookup keys multi-word entries by their canonical
single-space form. Decoder uses greedy longest-match fusion at lex
time. Encoder uses peek-and-buffer with backtracking to prevent
accidental phrase formation between independently selected slots.

### TW-list format

Unchanged on disk. Existing format `type<TAB>value` is sufficient;
the `value` field can contain whitespace. Existing import-gate
filter that rejects multi-word entries becomes a configurable flag
rather than an unconditional drop.

Examples:

```
ia,a
noun,capella
adv,a capella
adv,de facto
adv,a la carte
```

Each entry is independent. The phrase `a capella` lives in `adv`,
not in `ia`. Constituent words `a` and `capella` keep their own type
assignments untouched.

### Decoder: greedy longest-match fusion

At dictionary load time, the decoder builds an auxiliary phrase
index keyed by first word, listing possible phrase completions:

```
"a"  → ["a capella", "a la carte", "a priori", "a posteriori", ...]
"de" → ["de facto", "de jure", ...]
```

At lex time, when the next token is a WORD with first-word matches
in the index, the lexer peeks ahead at subsequent WORD tokens
(treating intervening WHITESPACE as transparent; PUNCT or EOS as
hard barriers, see E) and attempts to match the longest entry. On
match, the constituent WORD tokens are fused into a single token
whose value is the canonical phrase string.

Lookup proceeds normally on the fused token; the phrase entry is
found and its bits are recovered.

### Encoder: peek-and-buffer with backtrack

The encoder must not allow accidental phrase formation across
independently selected slots. Two distinct cases use the same
machinery:

- **Defensive case.** Model said `{ia} {adj}`; encoder emits `a` for
  ia; bits at adj slot would map to `priori`; cover would read
  `a priori`; decoder would fuse it; lookup would resolve to the
  phrase entry, not to `a` + `priori` separately. Bit accounting
  breaks unless the encoder prevents this.
- **Positive case.** Model said `{adv}`; bits at adv slot map to
  the multi-word entry `a capella`; encoder emits the canonical
  string `a capella`; decoder fuses it on lex (no special
  encoder-side action needed beyond emitting the literal string).

#### Mechanism

The encoder maintains a buffer of recently emitted WORD tokens with
their consumed-bit counts. Buffer length is bounded by the longest
phrase in the dictionary (max-N words).

Per slot:

1. Read bits from source stream tentatively (cursor position
   tracked but not yet committed).
2. Map bits to a word from the slot's type.
3. Append candidate to a working buffer view (recent emitted
   tokens + this candidate).
4. Check buffer state:
   - If working view matches a complete phrase entry: **rewind**
     bits for all tokens in the matched span, drop those tokens
     from the buffer (they are not emitted), advance the model by
     one slot (skip), iterate.
   - If working view is a strict prefix of any phrase entry: hold
     the candidate in the buffer (don't emit yet, don't commit
     bits beyond what was already committed for prior slots),
     advance the model by one slot, iterate.
   - Otherwise: commit bits for the oldest buffered token, emit
     it to cover. Repeat the buffer check on the remaining
     buffered view; flush oldest until the view is empty or
     a valid phrase prefix.

#### Worked example: `"happy"`, `":)"`, `"happy :)"`

Dict has all three entries. Trace each branch concretely.

**Positive case, encoder picks the phrase entry directly.**
Huffman walk in some slot lands on the leaf `"happy :)"`. At
`encode.js / encode` (line 221) the candidate contains a space:
`flushBuffer()` empties any pending single-word buffer, then
`fmt.emitWord("happy :)")` emits the canonical string atomically.
Decoder lexer fuses it back to one WORD on read. Bit accounting
balances: one slot in, one phrase token out, both sides see the
same Huffman code consumed once.

**Defensive case, two independent slots would fuse in cover.**

- *Slot A* picks `"happy"`. No space, so it goes to `phraseBuf` as
  `{word: "happy", slotBits: [...]}`.
  `encode.js / analyzePhraseBuf` looks up `phraseIndex.get("happy")`,
  finds candidate parts `["happy", ":)"]`. Length 2 > buffer length 1,
  prefix matches → `strict-prefix`. Hold; emit nothing.
- *Slot B* picks `":)"`. Push to `phraseBuf`. Buffer is now
  `[{happy}, {:)}]`. `analyzePhraseBuf`: candidate parts length 2 ==
  buffer length 2, all parts equal → `complete-match`.
  `tryFlushOrRewind` collects every bit from both entries' `slotBits`
  in original order, calls `pushbackBits.unshift(...allBits)`,
  clears `phraseBuf`. Nothing reaches cover.
- *Slot C* (next grammar pick): `readBit` drains `pushbackBits`
  before pulling from the payload reader. With a different type at
  this slot, the Huffman walk on the same bits selects a different
  word, e.g. `"glad"`. Buffered, no phrase starts with `"glad"`
  → `no-prefix` → emit `"glad"`. Remaining rewound bits feed the
  next slot, eventually picking some other word that doesn't
  re-form the phrase.

The only way `"happy :)"` ever appears in cover is the positive
case (encoder chose it as one phrase-slot). The defensive case
guarantees the cover never carries the dangerous `"happy"` then
`":)"` adjacency that the decoder would greedily fuse.

**Boundary clearings.** PUNCT and EOS slots call `flushBuffer()`
before emitting, matching the decoder's rule that fusion never
crosses PUNCT/EOS. End-of-stream `flushBuffer()` emits any held
strict-prefix words raw (e.g. trailing `"happy"` with nothing
after it); decoder sees a lone `"happy"`, no fusion candidate
completes, accounting balances.

**Failure mode.** If dict + grammar are arranged so every replay
of rewound bits keeps re-producing the same phrase, the
`MAX_NO_PROGRESS_MODELS = 256` guard at `encode.js / encode`
(line 175) throws rather than looping.

#### Punctuation resets the buffer

Whenever the encoder emits a PUNCT or EOS token (model-driven), the
phrase-detection buffer is cleared. Symmetric to the decoder's
fusion, which never crosses PUNCT or EOS.

#### Infinite-backtrack guard

The existing `MAX_NO_PROGRESS_MODELS = 256` counter
(`encode.js:86`) covers the analogous "many slots picked without
consuming bits" case and should be reused (or paralleled) here. If
backtrack-induced skips exceed the threshold, the encoder throws
the same family of error.

### Why this works for the asymmetric encoder/decoder

The decoder reads tokens linearly and looks each up in the
dictionary. Each word maps to exactly one entry, one type, one
code, one bit count. The decoder doesn't walk the model and doesn't
care which slot a token "belongs to" from the encoder's
perspective. Encoder skipping a slot has zero effect on the decoder
beyond there being one fewer token to read. Bit accounting balances
automatically because skipped slots produce neither cover output
nor consumed bits.

This corrects the older "skip rule must be type-level" formulation
in the prior design notes, which was based on a wrong mental model
of the decoder's behavior.

### Multi-word phrases (n > 2)

The buffer mechanism handles arbitrary phrase length. For phrases up
to length N, buffer holds up to N-1 prior slots. When a new
candidate extends the buffer to a complete N-word phrase entry,
all N slots' bits rewind and N model slots are skipped.

For `a la carte`:

- Slot 1 (ia): bits → `a`. Buffer holds `a`. Prefix of `a la carte`,
  `a priori`, etc. Hold.
- Slot 2 (adj or whatever): bits → `la`. Buffer holds `a la`.
  Prefix of `a la carte`. Hold.
- Slot 3 (noun or whatever): bits → `carte`. Buffer holds
  `a la carte`. Match. Rewind 3 slots' worth of bits, skip those
  3 model positions, clear buffer.

The user never sees `a la carte` in the cover unless the encoder
intentionally picks it from a type that contains it as an entry.

---

## E. End-of-sentence punctuation runs and intra-sentence whitespace

### Decisions

1. Genmodel preserves the lexer's full `tok.value` for EOS tokens
   (translated to the formatter's mini-language), instead of the
   current hardcoded `'. n'` normalization.
2. The lexer captures non-default whitespace runs between WORD
   tokens as a new explicit token class (WHITESPACE), recorded in
   the model as ordinary punct items. Single spaces remain implicit
   (handled by the formatter's existing `state.space` flag); only
   multi-character whitespace, tabs, and mid-sentence newlines
   produce explicit tokens.
3. Sentence models that flush as partial (corpus didn't end with
   EOS) get a synthetic terminator (`. n` or equivalent) appended
   before flush to guarantee every model has at least one trailing
   punct.
4. `U+2028` LINE SEPARATOR is an EOS terminator. It exists for
   texting-style corpora (one message per line, no trailing
   `. ! ?`) where injecting visible punctuation would break the
   conversational tone. The build-time corpus loader
   (`tools/load-corpus.js`) substitutes `\n` → `U+2028` for
   `texting-teen*.txt` files; the lexer's `EOS_RE` matches a bare
   `U+2028` as EOS; the formatter emits it verbatim, where renderers
   display it as a soft line break. Other corpora are unaffected.

### What's broken today

`genmodel.js:136` normalizes every EOS token to the literal punct
string `'. n'` regardless of source value. Information lost:

- Specific terminator char (`?`, `!`, `!!!`, etc.) collapses to `.`.
- Trailing whitespace runs (`.\n            ` for centered headings,
  `.\n\n` for paragraph breaks) collapse to a single newline.
- All EOS tokens emit exactly one newline. Run-together sentences
  (`Hello. Goodbye.` mid-paragraph) and paragraph-separated
  sentences (`Hello.\n\nGoodbye.`) render identically in cover.

`format.js` already supports literal preservation via its
mini-language. The fix is one line in genmodel.

### Mini-language translation rules

The lexer's EOS `tok.value` translates char-by-char to the model
string:

- `\n` → `n` (formatter emits `\n`, clears pending-space)
- ` ` → ` ` (formatter conditional space)
- `.`, `!`, `?`, `"`, etc. → pass through literally (formatter
  emits char + sets pending-space)

Example translations:

| Lexer EOS value | Model token | Formatter output |
|---|---|---|
| `.` | `.` | `.` |
| `.\n` | `. n` | `. \n` (today's behavior) |
| `!!!` | `!!!` | `!!!` |
| `!\n\n` | `! n n` | `! \n\n` |
| `.\n            ` | `.n            ` | `.\n            ` |

### Intra-sentence whitespace

The lexer adds a WHITESPACE token type. Single spaces between WORD
tokens stay implicit (no model token; formatter's pending-space
flag handles them as today). Whitespace runs that are anything
other than a single space (multiple spaces, tabs, mid-sentence
newlines, indentation runs) emit a WHITESPACE token whose value is
the literal whitespace string.

Genmodel records WHITESPACE tokens as ordinary puncts (the
existing `pushPunct(tok.value)` path handles them).

The formatter requires one small adjustment: when emitting a
WHITESPACE token, suppress the pending-space flag so the implicit
space and the literal whitespace don't stack.

### Phrases and intra-phrase whitespace

Phrases stored canonically with single-space form
(`adv,a la carte`). The encoder always emits the canonical form
when picking a phrase entry from a slot. Intra-phrase whitespace
in the cover is therefore single-space, regardless of corpus
spacing.

The decoder's greedy fusion treats inter-WORD WHITESPACE as
transparent for phrase matching: `a la carte`, `a   la   carte`,
and `a\nla\ncarte` all fuse to the same phrase entry. Only PUNCT
or EOS between two WORDs blocks fusion.

### Steganographic and robustness consequences

- Sequential scope plus EOS preservation plus WHITESPACE preservation
  means cover layout mimics the original corpus exactly: same
  paragraph breaks at same positions, same double-spacing, same
  indentation.
- Post-processing the cover with whitespace transformations (word
  wrap, double-spacing, indentation, line breaks) does not break
  decoding. The decoder treats whitespace as transparent for
  phrase matching, so only punctuation edits can break cover
  decoding. This extends an existing property (whitespace-preserving
  decode for words) cleanly to phrases.

---

## F. Emoji-phrases

### Decision

Once C admits emoji as WORD tokens and D allows multi-token phrase
entries, emoji-phrases are simply phrase entries whose constituent
tokens happen to be emoji. Same TW-list shape, same encoder
machinery, same decoder fusion.

Examples:

```
feeling, 🌹💐
weather, 🌧️ ☔
greeting, 👋 😀
```

Mixed phrases (Latin + emoji) work identically:

```
feeling, happy 😀
greeting, hello 👋
```

The lexer treats both Latin words and emoji as WORD tokens (per
B + C), so the phrase-detection mechanism doesn't care which type
each component is. Defensive buffering, greedy fusion, canonical
storage, punct as fusion barrier: all apply unchanged.

---

## Open questions / decisions deferred

- **EOS-run length cap.** `Hello!!!!!!!!!!` may be undesirable in
  cover even if faithful to a noisy chat corpus. A configurable cap
  (e.g., preserve up to 3 consecutive terminator chars, normalize
  longer runs to 3) is a reasonable safety dial. Default unset
  (full faithfulness) until evidence shows a problem.
- **Augmentation strictness for cross-modal.** Resolved by the
  optional `fixtures/emoji16.curated-keywords.tsv.gz` fixture
  (see §C "Curated keyword filter"). Aug A, Aug B, and Aug-mix
  consume CLDR keywords; the curated-keywords fixture filters the
  keyword input set when selected, restricting augs to keywords
  that pair naturally with emoji. Default (no filter): full CLDR
  keyword matches.
- **Whitespace authority.** When a model token is a WHITESPACE
  punct, the formatter emits its literal value and suppresses
  pending-space. Edge case: what if the literal value is itself
  empty or contains no whitespace at all (e.g., from an upstream
  bug)? Validate at model-build time that WHITESPACE token values
  contain only `\s`.

---

## Relationship to existing research-notes

- `research-notes.md` §11.4, §12, §14 (frequency-weighted Huffman,
  power-of-2 subtypes) are orthogonal to this spec. Subtypes were
  briefly considered as a mechanism for phrase grouping during this
  design; that idea was rejected. Phrases live as ordinary
  dictionary entries; subtypes (if adopted) remain a frequency-
  matching mechanism only.
- The encoder skip rule ("type-level only") used in earlier sketches
  was incorrect and has been replaced by the peek-and-buffer
  mechanism in §D above.
