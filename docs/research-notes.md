# NiceText 2026. Modernization Notes

> **Role of this document.** This is a live research appendix that the
> paper (`whats-new.html`) cites by section number (e.g. "docs/research-notes.md §16").
> Keep it current. The early "future work / left out" sections below (§8, §9)
> are the original 2026 scratchpad and are partly superseded; where an item has
> since shipped or been retired, an inline note says so rather than deleting the
> historical context.

Working notes on the design decisions, measurements, and lessons from the
2026 JavaScript port of NiceText. Intended as raw material for an
eventual quasi-academic write-up; written informally but with enough
detail and numbers to be useful later.

## 1. Background

**NiceText** is a linguistic-steganography system originally developed
1995–2001 by Mark T. Chapman and George Davida (UW-Milwaukee), described
in Chapman's 1997 M.S. thesis ("Hiding the Hidden: A Software System for
Concealing Ciphertext as Innocuous Text") and the ICICS 1997 paper. The
original C++ implementation accompanied the thesis but was never publicly
distributed in a way that produced any extant `.nicetext` files in the
wild. **There is no compatibility burden**, we have full design freedom,
and we used it.

**Goal of the port:** a working modern implementation that runs in the
browser (no server, no build step, no dependencies) and from the Node
CLI, suitable for live demos and (eventually) educational use.

**Result:** a ~3,500-line ESM codebase, six dictionaries totaling ~22 MB,
four sentence-model tables (jfk/aesop/wizoz/shakespeare), and a static
HTML page that does encode/decode entirely in the browser. The OG C++
archive (formerly vendored under `OG-NiceText-C++/`) has since been split
out into a sibling repo; the thesis is preserved here as `papers/thesis.pdf`.

## 2. Architecture

```
js/src/                 browser-safe ESM core (no fs, no Buffer; runs in Node ≥20 and browsers)
  bitstream.js          BitReader / BitWriter over Uint8Array, MSB-first within byte
  stream.js             streamWrap / streamUnwrap (EOF-marker wrap, replaces SIZER)
  random.js             mulberry32 PRNG, returns [0, 1)
  lexer.js              word/punct/EOS tokenizer, lex-style longest-match
  dictionary.js         loader → byWord, byTypeAndCode, byTypeIndex maps
  encode.js             SCRAMBLE-inverse (bits → cover text)
  decode.js             cover text → bits, then streamUnwrap
  typestream.js         flat random/round-robin type streams (Phase 3 fallback)
  modeltable.js         model-table streams (random + sequential modes)
  builder/
    lexer-shared.js
    listword.js         text → unique word counts
    txt2dct.js          (type, words[]) pairs → flat TWLIST
    sortdct.js          TWLIST → MTWLIST (lowercase, dedupe, multi-type merge)
    huffman.js          per-type canonical-ish Huffman code builder
    dct2mstr.js         MTWLIST → JSON dict with Huffman codes
    sources.js          OG-twlist parsers (impkimmo, rhyme, mitlist, numeric, impf2p)
    genmodel.js         text + dict → sentence-model frequency table
  grammar/
    parser.js           .def file recursive-descent parser
    expand.js           grammar → sentence model (with skip-and-retry)
    format.js           {Cap}/{CAPSLOCKON}/{,}/{. n}/{^literal^} interpreter
    expgram.js          dict → m-rules for portable grammars

js/bin/                 Node CLI shells (no browser code)
  nicetext.js  scramble.js  gendict.js

tools/                  build-time scripts (also Node)
  build-base-dict.js <byos.json>          base dict from byos.base sources
  build-corpus-dict.js <byos.json>        corpus → distribution dict
  build-model-table.js <byos.json>        corpus + dict → sentence-model table
  build-twlist-fixtures.js                emit per-source TWLIST fixtures
  build-all-fixtures.js                   orchestrator + cards.json emitter
  byos/*.byos.json                        canonical card specs
  byos-build-helpers.js                   shared helpers
  serve.sh                                python3 -m http.server (browsers block file://)

index.html, nicetext.html   static HTML at the repo root (no build, no deps)
css/                    page stylesheets
img/                    page assets
js/                     web app entrypoints (app.js, penny.js, tutorial-script.js)
```

**Constraint:** zero external dependencies. Pure JS / HTML / CSS only.
No npm packages, no CDN scripts, no bundlers, no transpilers. Allowed:
Node built-ins (`node:test`, `node:zlib`, `node:fs`) in CLI/build only,
and web platform built-ins (`Uint8Array`, `TextEncoder`, `fetch`,
`Blob`, etc.) in `js/src/`.

## 3. Where we diverged from the OG

### 3.1 Dropped the binary file format

The OG used a custom Random Access Object Format (`raof.h` /
`raof2rbt.h`) for `.dat` / `.jmp` / `.alt` dictionary files, disk-resident
B-tree-ish lookup designed for 1990s memory constraints. We replaced
with **JSON dictionaries loaded entirely into memory**. Modern hardware
makes this trivial; modern browsers can fetch and parse a 16 MB JSON in
under a second.

**Result:** ~17,000 lines of `mtc++/` infrastructure (RAOF, RBT, BST,
mstring, mmstring, initfile, heap) collapsed to nothing. Replaced with
`Map`, `Array`, `String`. The remaining `mtc++` content that mattered
(bit streams) is `js/src/bitstream.js`, ~50 lines.

### 3.2 Replaced SIZER with a streamable EOF marker

The OG's `SIZER` (thesis Ch. 2.3) prefixed the payload with its byte
length so the encoder could emit "extra bits" past EOF without confusing
the decoder, and the decoder knew exactly how many bytes to recover.

**We replaced this with an EOF-marker wrap:**

```
Wire layout:  [escaped payload bytes] [4-byte EOF marker = 0xAA AA AA AA] [random tail]
```

Why: no length prefix → encoder can pump payload bytes through as they
arrive; decoder stops when it sees the marker. **Genuinely streamable**
(future async I/O hook).

Marker choice is `0xAA × 4` (binary `10101010 × 4`): equal density of 0
and 1 bits avoids biasing dict picks alphabetically (an all-zero marker
would pick the alphabetically-first word in every type during the marker
emission).

Escape rule (PPP-style):
- `0xAA` in payload → `0x55 0x8A`
- `0x55` in payload → `0x55 0x75`

Decoder reads bytes; any `0x55` is an escape sequence (next byte XOR
`0x20`); any `0xAA` is the start of the marker. Validates all 4 marker
bytes.

**Overhead:** ~0.78% on uniform random bytes; ~0% on typical ASCII text
(neither byte is in printable range). Minimum cover-text size is set by
the 4-byte marker; even a zero-byte payload generates ~3–10 cover words.

**Test you can run yourself:** encode an empty payload and look at the
first words of the cover. They are the marker bits mapped through your
dict, different per dict but always derived from `0xAAAAAAAA…`:

```
mit:         knipe dobbing murtaza kahaleel ariella adey alejandrina gursin
master:      6465 unfermented carley seines tydas' alikee behzad zuhua's macsupport parenthetically
shakespeare: unexecuted intestate twenty-five outface drinkings chalice victor's patroness mourners
```

### 3.3 Huffman codes per type

The OG built dictionaries with **fixed-length codes per type**, achieved
by truncating each type to the largest power of 2 ≤ the actual word
count and dropping the rest (thesis Ch. 2.4: "NICETEXT ignores all but
the first g words of each type because any remaining words do not have
a code assigned").

We replaced this with **per-type Huffman codes**, optionally weighted
by source-corpus word frequency. Two big wins:

1. **No truncation.** Every word is reachable.
2. **Cover text auto-Zipfs for corpus dicts.** The encoder reads
   random-looking bits and walks the per-type Huffman tree until it hits
   a leaf. Words with short codes are picked more often (the bit pattern
   `0…` matches the `0`-rooted leaf at probability 1/2). If we feed the
   builder the source corpus's word counts, common words get short codes,
   so cover text reads like the source.

**Frequency policy:**
- **Corpus dicts (jfk / aesop / wizoz / shakespeare)**: weighted by per-word
  count from the source corpus (`listWordsWithCounts`).
- **Master and mit**: uniform weights (no obvious reference corpus). Still
  get the no-truncation win.

**Schema bump.** Dict JSON went from version 1 to version 2:

```json
{
  "version": 2,
  "name": "shakespeare",
  "types": [
    { "index": 1, "name": "noun", "wordCount": 4096 }
  ],
  "words": [
    { "word": "the", "typeIndex": 1, "code": 0, "bits": 1 },
    { "word": "of",  "typeIndex": 1, "code": 2, "bits": 2 }
  ]
}
```

`bitCount` no longer exists on types (codes vary per word). The encoder's
lookup map is keyed by `<typeIndex>:<bits>:<code>`.

### 3.4 RNG contract clarified

The OG (and our first cut) had a subtle bug: `mulberry32` returned a
uint32, but every weighted-pick site computed `r = random() * total`
expecting `Math.random`-style `[0, 1)`. With `r` always being huge, the
loop fell through to "return last item", **every weighted pick
deterministically picked the same item**. Round-trips passed because
encode and decode were both equally broken in the same way.

After fixing `mulberry32` to return `[0, 1)`, weighted selection works
correctly. Caught when the user observed Shakespeare-style output was
the same line repeated.

This is documented as a contract: **all PRNGs in this codebase return
floats in `[0, 1)` like `Math.random`**. The bit stream's random tail
scales via `Math.floor(rand() * 256)`.

### 3.5 Other small changes

- **Format-token spacing**: when a `{^literal^}` ends with an
  alphanumeric, set `pending-space = true` so adjacent literals don't
  fuse ("where" + "alack" → "where alack" instead of "wherealack" which
  the decoder lexer can't tokenize). When it starts with alphanumeric
  and there's pending space, insert it. Otherwise the literal is
  authoritative about its own whitespace.
- **GUTENBERG_END semantics**: the marker ENDS the legal boilerplate;
  everything AFTER it is the actual book. Our `listword` and `genmodel`
  discard everything counted *before* the marker (the OG version was
  reversed at first, which made wizoz tokenize to 596 unique words
  instead of ~3000).
- **CFG grammar parser** is a hand-written recursive-descent parser
  (replaces yacc/lex). Same syntax as OG `.def` files.
- **Sequential model-table mode** (`build-model-table.js --ordered`):
  preserves source document order and lets you "replay" a corpus's
  sentence shapes literally. Useful demo: encoding any short payload
  through the JFK ordered model produces something very close to the
  actual inaugural address.

## 4. Algorithm at a glance

The thesis describes the algorithm in detail; here is the JS port's
view in one screen.

### Encode (NICETEXT: bits → cover text)

```
1. wrap payload as a bit stream:
     [escaped payload] [0xAAAAAAAA marker] [pseudo-random tail]
2. loop until marker has been consumed AND we've used at least
   minExtraBits of the random tail:
     a. pick a sentence model (from CFG, model table, or single-type stream)
     b. for each token in the model:
          if punct token: feed to formatter (Cap, CAPSLOCKON, {. n}, {^lit^}, …)
          if type slot:   walk the per-type Huffman tree bit-by-bit,
                          emit the matched word through the formatter
3. flush formatter, return cover text
```

### Decode (SCRAMBLE: cover text → bits)

```
1. tokenize cover with the lex-style word/punct/EOS lexer
2. for each WORD token:
     lower-case it, look up entry in dict.byWord
     if known and entry.bits > 0: writeBits(entry.code, entry.bits)
     (unknown words and non-WORD tokens are silently skipped)
3. streamUnwrap the resulting bytes (drop escapes, stop at marker)
```

The whole system is symmetric around a (typeIndex, code) ↔ word
mapping, the encoder reads bits to choose `code`, the decoder reads
the word to recover `code`.

## 5. Source-data inventory (master dictionary)

Master is assembled from eight tag-prefix families. Most words carry
multiple tags simultaneously (because `sortdct` merges across all input
TWLISTs that mention the same word), so the totals below summed across
families do **not** equal the dict's word count, they're separate views
of the same shared word pool.

Master totals: **51,893 types, 190,841 words.**

> Note: these are early scratchpad counts and drift from the other docs.
> The canonical labeled figure is the paper's snapshot
> (`whats-new.html` Table 1: 149,300 words / 52,128 types, historical snapshot).
> Cite that when a single number is needed; the per-family breakdown below is
> kept as an illustrative view, not a current census.

| Tag prefix family | Distinct tags | Types containing tag | Word slots (sum across containing types) |
|---|---:|---:|---:|
| `kimmo` (PC-KIMMO + Englex morphological POS, SIL 1995)               | 142   | 40,928   | 99,114  |
| `rhymel*` (CMU Pronouncing Dictionary-derived rhyme groups, CMU 1995) | **7,356** | 106,699 | 132,271 |
| `synonymOf_*` (Frog2Prince synonym groupings, UWM thesis)             | 7,062 | 33,129   | 48,318  |
| `name_*` (MIT first/family/other names + auto-generated possessives)  | 9     | 11,132   | 68,665  |
| `place` (MIT places)                                                  | 1     | 282      | 373     |
| `num_*` (numeric: digits / years / cardinals / roman)                 | 4     | 34       | 19,136  |
| `begins_with_a_vowel` (a/an grammar agreement marker, awk-augmented)  | 1     | 14,295   | 39,156  |
| `claude2026_*` (modern vocabulary, Claude 2026 contribution)          | 24    | 737      | 1,071   |

### Sample tag names per family

- **kimmo POS** (142 distinct grammar-feature combinations):
  `N_3sg+Sg`, `N_3sg-Pl`, `V_BaseFin-`, `V_PastEdFin+`, `V_IngFin-`,
  `AJ_AbsVerbal-`, `AJ_SuperVerbal-`, `AV`, `PP`, `CJ`, `IJ`,
  `PR_3sg+3SgNomReflex-Wh-`, ...

- **rhyme** (7,356 distinct rhyme groups; the `lN` is the "depth": how
  many syllables back the rhyme matches):
  `rhymel2_ts`, `rhymel3_ah0ts`, `rhymel4_mah0ts`, `rhymel5_ow1ster0z`,
  `rhymel10_nstih0tuw1shah0nz`, ...

- **synonym** (7,062 synonym clusters from the Frog2Prince thesis):
  `synonymOf_definitely`, `synonymOf_admixing`, `synonymOf_emblematizing`,
  `synonymOf_activating`, ...

- **name** (9 atomic categories: heavily merged with rhymes/POS in practice):
  `name_male`, `name_female`, `name_family`, `name_other`, `name_male_pos`,
  `name_family_pos_plr`, ...

- **claude2026** (24 categories added in 2026):
  `claude2026_ai_term`, `claude2026_color`, `claude2026_country`,
  `claude2026_dinosaur`, `claude2026_element`, `claude2026_food`,
  `claude2026_internet_noun`, `claude2026_planet`,
  `claude2026_programming_language`, `claude2026_subject`,
  `claude2026_tech_company`, ...

### How they combine

The family sums above don't add to 190,841 because most words end up
sharing many tags. A single merged type-name in master can look like:

```
AJ_AbsVerbal-,N_3sg+SgProp-Verbal-,begins_with_a_vowel,claude2026_color,
  rhymel2_zher0,rhymel3_ah0zher0,rhymel4_zh1ah0zher0,synonymOf_azure
```

That's a single merged type for the word `azure`, telling you it's an
adjective, also a proper noun, vowel-initial (so use "an"), in
claude2026's color category, rhymes with these phonetic patterns at
depths 2/3/4, and is a synonym for "azure" in the Frog2Prince database.
**Eight tags simultaneously.** Future grammars can target any subset of
these for very specific picks (the kind of thing the OG `expgram` tool
makes navigable via `mTYPE` references, see §3.4).

### Source files in repo

| Source | Path |
|---|---|
| kimmo                | `fixture-src/twlist/impkimmo/kimmo.twlist.gz` |
| rhyme                | `fixture-src/twlist/rhyme/rhyme.twlist.gz` |
| synonym              | `fixture-src/twlist/impf2p/f2p.twlist.gz` |
| names + places       | `fixture-src/twlist/mitlist/{name_*,place}` |
| numeric              | `fixture-src/twlist/numeric/num_*` |
| `begins_with_a_vowel` | auto-generated by `applyVowelAugmentation` (sources.js) when `base.augment.vowel` is true in the byos.json (superseded by the xanax rewriter, see paper §6.2; the augmentation code still exists but is no longer wired into byos) |
| `claude2026`         | `fixture-src/twlist/claude2026/claude2026.twlist` |

The OG `doc/distribution.txt` (shipped with the OG C++ archive, now in a
sibling repo) documents the upstream provenance of the first six.

## 6. Measurements

### 5.1 Dictionary sizes

| Dict          | Types  | Words   | Avg bits/word | Max bits | JSON size |
|---------------|-------:|--------:|--------------:|---------:|----------:|
| `mit`         |     25 |  25,829 |            : |       14 |     2.4 MB |
| `master`      | 51,676 | 190,540 |          7.45 |       15 |      16 MB |
| `jfk`         |    545 |     559 |          0.06 |        3 |      82 KB |
| `aesop`       |  5,110 |   5,526 |          0.30 |        7 |     792 KB |
| `wizoz`       |  2,797 |   2,974 |          0.20 |        6 |     425 KB |
| `shakespeare` | 25,034 |  29,546 |          0.96 |       12 |     3.5 MB |

`avg bits/word` is across **all words including 0-bit single-word
types**, so it's pulled down by the long tail of merged-type singletons
in corpus dicts. The *picked* words during encoding average significantly
higher.

### 5.2 Huffman code-length distribution

Master dict (uniform Huffman, 51K types):

| bits | words   |
|-----:|--------:|
|    0 |  40,308 (single-word types) |
|    1 |  14,466 |
|    2 |  11,747 |
|    3 |   7,222 |
|  4–7 |   6,319 |
| 8–11 |  21,348 |
| 12–14 | 65,729 |
|   15 |   3,072 |

Maxes out at 15 bits, exactly `ceil(log2(64))` on the largest type.
With uniform weights, Huffman degenerates into approximately balanced
trees per type, so code lengths cluster around `log2(wordCount)`.

Shakespeare dict (frequency-weighted Huffman, 25K types):

| bits | words   |
|-----:|--------:|
|    0 |  24,089 (single-word types) |
|    1 |   1,561 |
|    2 |     424 |
|    3 |     190 |
|    4 |     215 |
|    5 |     226 |
|    6 |     343 |
|    7 |     589 |
|    8 |     594 |
|    9 |     706 |
|   10 |     602 |
|   11 |       1 |
|   12 |       6 |

Note the **U-shape**: a small set of very common words at 1–2 bits, a
long thin tail of rare words at 6–10 bits, and very few extreme outliers.
Maximum code length is 12 bits (well under our 53-bit safety cap).

### 5.3 Cover-text expansion ratio

100-byte ASCII payload, encoded with the weighted flat type stream
(no grammar, just words):

| Dict          | Cover length | Expansion |
|---------------|-------------:|----------:|
| `mit`         |     527 chars |   5.27× |
| `master`      |     855 chars |   8.55× |
| `shakespeare` |   1,994 chars |  19.94× |
| `aesop`       |   2,949 chars |  29.49× |
| `wizoz`       |   3,134 chars |  31.34× |
| `jfk`         |   3,737 chars |  37.37× |

Same 100-byte payload, encoded through the model-table stream (real
sentence shapes from the source corpus):

| Dict          | Cover length | Expansion |
|---------------|-------------:|----------:|
| `shakespeare` |  16,752 chars |  167.52× |
| `aesop`       |  27,239 chars |  272.39× |
| `wizoz`       |  32,163 chars |  321.63× |
| `jfk`         |  67,278 chars |  672.78× |

The model-table variant is much fluffier because **most type slots in a
model are 0-bit (single-word merged types)**, so most of the cover text
is "free" (carries no payload). The few bit-bearing slots do all the
encoding work; everything else is filler from the source's natural
sentence shape. The visual payoff: the cover text reads like the
original author.

### 5.4 Cover-text samples

**Aesop's style** (model-table random, payload "Encode this in Aesop style."):

> The Lion replied: "This statue was made by one above you men." The
> Peacock and Juno THE PEACOCK made complaint to Juno that, why the
> nightingale pleased every ear within his song, he himself no sooner
> opened his mouth than he became a laughingstock to all who heard him.
> He felt it, and being in doubt, said: "I do not quite know though it
> is the cub of a Fox, or the whelp of a Wolf, but this I know full
> well." The Hunter ran after him, as if he was sure above overtaking
> him, but the Horseman increased more and more the distance between them.

**Shakespeare style** (model-table random, payload "Encode this in
Shakespeare style."):

> I thank you before this comfort. Abominable cozen. I have brought you
> a letter and a couple of pigeons here. your ruin marry her; And with
> my best eyebrows in your absence Your disgracing father strive to
> qualify, And bring him upon to liking. If my lady have not call'd
> under her steward Malvolio, and bid him turn you out of doors, never
> trust me. But tis no matter; this poor show doth better; this doth
> infer the midriff I had to see him.

**JFK sequential** (model-table ordered, payload "Hi"):

> This is a retranscription of one of the first Project Gutenberg
> Etexts, offically dated November 20, 1993 and now officially
> re-released on November 20, 1993 on the 30th anniversary of his
> assassination. \*\*\*the Project Gutenberg Etext of Kennedy's Inaugural
> Address\*\* Jfk's Inaugural Address, January 11, 1973, 12:11 EST. We
> observe today not a victory of party but a celebration of freedom...
> symbolizing an end as well as a beginning... signifying renewal as
> well as change for I have sworn for you and Almighty God the same
> solemn oath our forbears prescribed nearly a century and three-quarters
> ago. The world is very different now, before man holds in his mortal
> hands the power to abolish all forms of human poverty and all forms
> of human life. And though the same revolutionary beliefs for which
> our forbears fought are still at issue around the globe... the
> belief that the rights of man come not from the generosity of the
> state but from the hand of God.

(Sequential mode REPLAYS the source's sentence shapes in document order,
with bit-bearing slots filled by Huffman-encoded picks. Notice that the
JFK speech is essentially reproduced verbatim, only words at multi-word
type slots vary. With a 2-byte payload, only ~16 bits get distributed
across many sentences, so most slots use their 0-bit single-word fillers
which happen to be the original words. The numbers and dates have
multi-word types so they shift slightly: "November 20" instead of
"November 22", "1973" instead of "1961".)

## 7. Bugs found, lessons learned

A short catalog of the non-obvious gotchas we hit, in the order we hit
them:

### 6.1 Lex DFA vs. JS regex backtracking

The OG word lexer's contraction patterns (e.g. `[nN]'[tT]` for `n't`)
require lex's NFA-DFA "longest match across all parses" semantics. JS
regex with `+` is greedy with backtracking but **doesn't backtrack
across an outer `(...)*` boundary**. So `can't` matched as `can` plus a
zero-length contraction match instead of `can't` as a whole. Worked
around with a permissive `'[A-Za-z]{0,2}` apostrophe-suffix; covers all
real English contractions, no observed false matches in natural text.

### 6.2 GUTENBERG_END semantic flip

Project Gutenberg files have a `*END*THE SMALL PRINT! ... *END*` marker
that ends the legal boilerplate; the actual book starts AFTER it. Our
first cut treated it as "stop tokenizing here", missing the entire book.
Wizard of Oz tokenized to 596 unique words instead of ~3000. Fixed by
discarding everything counted BEFORE the marker.

### 6.3 The RNG contract bug

`mulberry32` returned a uint32 (`~4 billion`); weighted-pick code did
`r = random() * total`. `r` was always astronomically larger than any
cumulative weight, so the loop fell through to "return last item" every
time. **Every weighted pick was deterministic, picking the same item.**
Round-trips stayed green because both encode and decode were equally
broken. Caught when the user observed Shakespeare-style output was the
same sentence repeated.

The lesson: **define your PRNG contract upfront and stick to it**. Now
all PRNGs return `[0, 1)` like `Math.random`; bit-level uses
`Math.floor(rand() * 256)`.

### 6.4 Format-spacing for verbatim literals

A late discovery from the Huffman/streaming work: the corpus dict
truncation (under the OG scheme) dropped some source words; `genmodel`
emitted them as `{^word^}` literals; my formatter cleared
pending-space after a verbatim emit; **adjacent literals fused** ("where"
+ "alack" → "wherealack" → decoder lexer can't recover). Fixed by making
the formatter smart about alphanumeric boundaries inside literals.
Huffman's no-truncation property eliminates this scenario, but the
formatter behavior is more robust now anyway.

### 6.5 Encoder forward-progress guard

After "always finish a sentence model" was added (so we don't emit
partial sentences when the random tail kicks in), corpus dicts with
mostly 0-bit single-word types could put the encoder in an infinite
loop: pick a model, no bits consumed (all 0-bit slots), pick another
model, no bits consumed, … until V8 OOMs. Guard added: after 256 models
without consuming any bits, error out with a clear message.

### 6.6 BitWriter's 32-bit shift trap

JS bitwise ops are signed 32-bit; `(value >>> i) & 1` for `i ≥ 32` is
broken. We hit this with Huffman codes >32 bits long (theoretically
possible on extreme Zipf with very large vocabs). Fixed by using
`Math.floor(value / Math.pow(2, i))` for `i ≥ 31`. Cap raised to 53 bits
(JS safe-integer range).

## 8. What's deliberately left out

- **No encryption layer.** NiceText is steganography (hiding the
  channel), not cryptography (hiding the content). If you want the
  payload encrypted, encrypt before encoding. The thesis (Ch. 5) makes
  the same point.
- **No statistical analysis of detectability.** The thesis acknowledges
  that NiceText cover text is statistically distinguishable from real
  natural language; this is research-level work and out of scope for the
  port.
- **No async streaming I/O.** _Shipped since:_ the streaming path landed
  as `streamWrap` / `streamUnwrap` in `js/src/stream.js` (with
  `IncrementalUnwrap` for byte-at-a-time decode); see paper §7.2. The wire
  format always supported streaming; encode/decode no longer have to
  materialize the whole payload as a `Uint8Array`. (Original note: a
  generator-based async path is a clean follow-on.)
- **No web upload of custom dicts/grammars.** _Shipped since:_ delivered as
  Build-Your-Own-Style (BYOS) upload, `js/src/byos.js` plus the
  `tools/byos/` card specs; see paper §5.1. (Original note: architecture
  always supported this. The catalog in `js/app.js` is just an array; the
  builder code in `js/src/builder/` is browser-safe; only the UI work was
  outstanding.)

## 9. Future work (roughly in priority order)

1. **Hybrid frequency master.** Build a dict that uses corpus
   frequencies (one or several corpora aggregated) to bias master toward
   natural English, while still containing every word in master so any
   text can encode. Effectively: frequency-weighted Huffman on master.
   Most natural-feeling general-purpose dict.
2. **Custom dict/grammar/wordlist upload** in the web UI. _Shipped_ as
   Build-Your-Own-Style upload (BYOS, see §8 and paper §5.1).
3. **In-browser dictionary builder.** All the build code is already
   browser-safe; expose it. _Shipped_ via the BYOS Advanced panel (the
   builder runs in the worker on demand).
4. **Async streaming I/O.** Encoder takes an async byte iterator;
   decoder yields bytes as it sees them. _Shipped_ as
   `streamWrap` / `streamUnwrap` (see §8 and paper §7.2).
5. **Quasi-academic write-up.** Use these notes plus the thesis as the
   source material for an HTML-only write-up of the modernized algorithm.
6. **Huffman tie-breaker policy.** §12 measured + landed. The
   `tieBreak: 'length-desc'` engine option ships as the BYOS "Prefer
   shorter words" checkbox; bake-time tools stay on the alpha-asc
   default so shipped fixtures don't drift. See §12.4 and
   `docs/builders.md` "buildDictionary opt-in invariant".

## 10. References

- Mark T. Chapman, "Hiding the Hidden: A Software System for Concealing
  Ciphertext as Innocuous Text", M.S. Thesis, UW-Milwaukee, 1997.
  Preserved here as `papers/thesis.pdf`. (The original C++ archive that
  vendored the plain-text `doc/thesis.txt` now lives in a sibling repo.)
- M. Chapman & G. Davida, "Hiding the Hidden", *Proc. ICICS 1997*,
  Beijing, Springer LNCS. The plain-text `doc/icics97.txt` shipped with
  the OG C++ archive, which now lives in a sibling repo.
- D.A. Huffman, "A Method for the Construction of Minimum-Redundancy
  Codes", *Proc. IRE* 40(9), 1952.
- PPP byte-stuffing escape rule: RFC 1662, *PPP in HDLC-like Framing*.

## 11. External word-frequency sources (design, 2026-05-03)

Design capture for a planned extension to weighted Huffman beyond the
corpus-dict path. Elaborates on §9 item 1 ("Hybrid frequency master").

**Fixtures landed 2026-05-04 in commit 48e71ff**: three sources
(`fixtures/norvig.freq.sab.gz`, `fixtures/google.freq.sab.gz`,
`fixtures/gutenberg.freq.sab.gz`) covering 70% of the active 418K-word
vocab pool. (These shipped as packed SAB blobs, not the `.freq.tsv.gz`
named in the original design draft below; the Google one is
`google.freq.sab.gz`, not `google-books`.) Reproducers under `fixture-src/freq/<source>/`. Engine
unchanged: the `combineFrequencies()` consumer helper and the
Build-Your-Own-Style freq-picker UI are the next pass. The remaining
open decisions (§11.9), bake vs. runtime for master/mit, the
corpus-blend toggle, per-source weighting, gate that work.

### 11.1 Problem

Today, frequency-weighted Huffman happens in exactly two places:
`tools/build-corpus-dict.js` (prebuilt corpus dicts) and
`js/src/worker/build-session-worker.js:212` (the custom-corpus portion of
a session-base build). Master, mit, and the TW-list portion of session-
base all use uniform Huffman, because TW-lists carry no frequency info
and there's no obvious reference corpus for "general English."

Result: a Build-Your-Own-Style session-base dict built from 13
TW-list sources gives `the` and `defenestrate` the same code length
within a type. Cover text reads more uniform than it would otherwise.

### 11.2 Source list (v1 candidates)

| Source | Size (gz) | License | Bundle? |
|---|---|---|---|
| Norvig `count_1w.txt` | ~2 MB | "may be used for any purpose" | yes |
| Google Books Ngrams English 1-grams (top-N derived) | few MB after vocab prune | CC BY 3.0 | yes |
| PD Gutenberg derivation | small | underlying texts PD; pick a derivation | yes (specific upstream TBD) |
| SUBTLEX-US | ~3 MB | mixed; commercial-use status unclear | needs license confirmation |
| OpenSubtitles word lists | ~2-3 MB | OPUS CC0; derivations usually MIT | likely yes; alternative spoken register |
| BNC Kilgarriff | ~6K lemmas | open | too thin, skip |

V1 ships **Norvig + Google Books top-N + one PD-Gutenberg derivation**.
Three sources, three different registers (web / books / PD-literary),
all clearly redistributable.

### 11.3 Bundling pattern (mirrors TW-list convention)

Same fetch-and-prune pattern as `fixture-src/twlist/{moby-pos,
moby-thesaurus, wordnet}/`. As built:

```
fixture-src/freq/<source>/fetch.js          # how to reproduce
fixture-src/freq/<source>/raw/              # gitignored; small (<10 MB)
                                        # raw committed alongside fetch.js
                                        # for Norvig only, for that source
                                        # raw is kept locally indefinitely
                                        # so future sessions can mine it
fixtures/<source>.freq.tsv.gz           # bundled, git-tracked
```

Pruning to fixture size happens in `tools/build-freq-fixtures.js`,
which is separate from the fetchers (mirrors `tools/build-twlist-
fixtures.js` vs. `fixture-src/twlist/<source>/fetch.js`).

**Format** is tab-delimited `word<TAB>count`, gzipped. `#`-prefixed
lines are header comments parsed only for display; ignored on data
ingest. Headers carry: title, attribution, source URL, "curated subset"
note.

**Vocabulary intersection at build time:** the builder only keeps words
that appear in any `fixtures/*.dict.json.gz` or `fixtures/*.twlist.tsv.gz`.
Drops Google Books from ~4.5 GB raw → 1.6 MB pruned. Norvig shrinks
similarly (full ~333K → 99K). Gutenberg from ~23 GB raw → 1.3 MB pruned.

Worth backporting two header lines (source URL + curated-subset note)
to existing TWLIST fixtures so the convention is uniform across both
fixture families.

### 11.4 Normalization math

**Within a source, count → probability.** Divide each word's count by
the source's total token count.

```
p_s(w) = count_s(w) / total_tokens_s
```

After this, every source's numbers live in [0, 1] regardless of source
size. A source that says `the` happened a million times out of a billion
contributes the same `p(the) = 0.001` as a small source that saw `the`
500 times out of 500,000.

**Across sources, average present-source probabilities.** For each
word, average over only the sources that contain it.

```
p(w) = mean( p_s(w) for s in sources_that_have_w )
```

**Convert to Huffman weight.** `buildDictionary` wants integer weights.
Bigger weight = shorter code = picked more often. Floor at 1 so absent
words still hash into the tree:

```
weight(w) = max(1, round(p(w) * SCALE))      // SCALE = 1e9
```

The per-type Huffman tree only cares about *relative* weights, so the
exact scale doesn't matter as long as the smallest real probability
still rounds to ≥1.

Worked example, three sources combined:

| Word | Norvig p | Google p | Gutenberg p | Combined p | Weight |
|---|---|---|---|---|---|
| `the` | 0.0220 | 0.0250 | 0.0240 | 0.0237 | 23,700,000 |
| `azure` | 0.0000030 | (absent) | 0.0000600 | 0.0000315 | 31 |
| `defenestrate` | 0.0000001 | (absent) | (absent) | 0.0000001 | 1 (floored from <1) |
| `sklerb` (in TW-list, in no source) | (absent) | (absent) | (absent) |, | 1 (floor) |

Two paths land at weight 1: too-rare-to-round and absent-from-everything.
Both get the longest available code in their type, least-preferred
pick, which is exactly what we want.

### 11.5 Coverage-gap policy

- **Word in some sources but not all** → average over present sources
  only (skip-if-absent). Each source that DOES have it contributes
  equal voice.
- **Word in our vocab but in no selected source** → floor weight = 1.
  Matches today's `dct2mstr.js:43` behavior
  (`frequencies.has(w) ? frequencies.get(w) : 1`).

### 11.6 Corpus dicts as just another source

A corpus dict already has counts via `listWordsWithCounts(corpus)`.
Same math: turn corpus counts into `p_corpus(w)`, drop into the average
alongside Norvig / Google / Gutenberg if the user opts in.

| Word | Aesop p (corpus) | Norvig p | Combined |
|---|---|---|---|
| `lion` | 0.0048 | 0.000051 | 0.00243 |
| `the` | 0.063 | 0.022 | 0.0425 |

**Zero new math.** The decision is purely UI: do we expose the option,
given that mixing in external freqs dilutes the corpus's voice? Default
recommendation is **no**, the whole appeal of "Shakespeare style" is
Shakespeare's distribution, not Shakespeare-words at general-English
rates. Expose only as an explicit advanced toggle.

### 11.7 Where it plugs in (the four-pipeline matrix)

| Pipeline | Today | With external freqs |
|---|---|---|
| `master`, `mit` (bundled fixtures) | uniform | rebuild fixtures with combined ext-freqs (one bake-time mix) **or** runtime per-session re-weight |
| Corpus dicts (aesop / jfk / etc.) | corpus freqs | leave alone v1 (corpus voice is the point) |
| Session-base from TW-lists | uniform | **biggest win**. TW-lists carry no freq info; ext-freqs give them one |
| Session-base + custom corpus | corpus freqs on corpus portion, uniform on TW-list portion | ext-freqs replace uniform on TW-list portion; corpus portion stays corpus-weighted (or blends if user opts in) |

### 11.8 UI surface (Build Your Own Style)

Today: corpus radio (+custom upload), 13 base-dict TW-list checkboxes
(+custom TW-list upload). Add a third row for frequency control,
shaped by whether a corpus is selected.

**When a corpus / style IS selected:**

A single toggle, default checked: **"Use this style's frequencies"**
(working title; alternates: "Style frequencies only", "Match [selected
style]'s word distribution"). Naming TBD.

| Toggle state | Behavior |
|---|---|
| Checked (default) | Corpus freqs only. No external picker shown. Matches today's session-base + corpus behavior. |
| Unchecked | Word-Frequency-Sources picker expands with checkboxes for each bundled source (Norvig / Google / Gutenberg) **plus** a checkbox for the selected style. Any combination merges via §11.4 normalization. |

This avoids the "checkboxes apply only to TW-list portion" complexity
of the earlier (ii) option, the toggle is an explicit mode switch the
user controls.

**When NO corpus / style is selected:**

The freq picker shows only the external sources (Norvig / Google /
Gutenberg). No style option to offer. Default all unchecked = uniform
Huffman (today's behavior, no surprise to existing users).

**Why not allow freq from any style.** Mechanically possible, every
corpus dict has counts. But a list of N styles as freq sources is
more dial than user benefit. Restricting to "the selected style" keeps
the picker scannable; the merge math doesn't change either way.

i-in-circle disclosure on the row explains what each source is and how
combination works.

**Post-landing revision (2026-05-04).** The toggle described above
shipped briefly, then collapsed: the picker is now permanently visible
in both Vocabulary Scope modes, the per-row `[Style] frequencies`
checkbox replaces the toggle, and the merged Map drives weights for
whichever dict is active at runtime (base in expand-vocab mode, corpus
dict in only-words-from-story mode). Ticking `[Style]` folds the
corpus's own counts into the merge; unticking it removes them
entirely. This fully resolves Q2, see §11.9.

### 11.9 Open decisions

| # | Question | Status |
|---|---|---|
| Q1 | master/mit: bake one combined-source variant as the bundled fixture, or runtime re-weight per session? | **open**, bake recommended (simpler, faster); pick one default mix. Gates the next pass. |
| Q2 | Corpus dicts: leave alone, or expose blend option? | **resolved**, blend exposed via the same always-visible picker; the `[Style]` checkbox folds raw corpus counts into the merge, unticking it leaves external sources alone weighting the corpus dict. To reproduce legacy "raw corpus counts only," tick only `[Style]`. |
| Q3 | SUBTLEX: confirm license or drop? | **resolved**, dropped from v1 (license unclear; revisit if cleared). |
| Q4 | PD-Gutenberg derivation: which upstream? | **resolved**, built ourselves via rsync of PG plain-text + the engine's own lexer for tokenization. Filtered to single-language English via the rdf-files.tar.bz2 catalog; per-book variant prefers bare `<id>.txt`, falls back to `<id>-0.txt` (UTF-8). |
| Q5 | Per-source weighting (e.g., 2× Gutenberg)? | **open**, defer; ship uniform mix v1. |
| Q6 | Final label for the corpus-selected toggle? | **open**, candidates: "Use this style's frequencies" (lean), "Style frequencies only", "Match [style]'s word distribution". |

### 11.10 Engine impact

Zero. Encoder and decoder don't know or care where weights came from;
only `buildDictionary` needs the `frequencies` Map. The build pipeline
gains a `combineFrequencies(sources)` helper and the worker gains a
parallel "load freq fixtures" step alongside the existing TW-list
preload.

### 11.11 Rounding artifacts under normalize-then-round (recorded 2026-05-06)

Surface observation: the §11.4 math has a numerical-precision quirk
that produces cosmetically-different Huffman dicts vs. the equivalent
"raw integer counts" pipeline that an earlier Node-side bake script
used. Same engine, identical bit lengths per word, but different `code`
values at internal nodes. Worth recording for the paper because it's
the kind of detail a reproducer will hit.

**The quirk.** §11.4 produces `weight(w) = max(1, round(p(w) * 1e9))`
where `p(w)` is a per-source probability or mean of probabilities. Two
words A and B with raw count c=1 each, plus a word C with raw count
c=2, in a corpus of T tokens:

- Raw-counts path: `weight(A) = weight(B) = 1`, `weight(C) = 2`. A+B
  internal node has weight `1+1 = 2`, exactly tying with C. Huffman tie-
  breaks by insertion order.
- §11.4-round path: `weight(A) = weight(B) = round(1/T * 1e9)`. For
  T=30000 that's 33333. `weight(C) = round(2/T * 1e9) = 66667`. A+B
  internal node is `33333+33333 = 66666`, which is NOT 66667. Now the
  internal node and C are in strict order, not tied. Huffman pops the
  smaller (the internal node) first.

The two strategies produce identical Huffman tree SHAPES (same depth
per word) but different code-label assignments at internal nodes: the
flip in pop order toggles which child gets bit 0 and which gets bit 1
at each affected merge. Encoder and decoder built from the same dict
work correctly; cross-dict (encoded with one, decoded against the
other) does not.

**Why it happens often.** Inside Huffman: every internal-node merge
produces a sum-of-children weight that gets compared against still-
pending leaves. With raw integer counts the sums add cleanly; with
scaled-and-rounded weights they don't. For a small corpus with a long
tail of c=1, c=2, c=3 words, near-ties happen at every layer of the
bottom of the tree.

**Why it's mathematically benign.** Both trees are valid optimal
Huffman codes for their respective weight inputs. Average bits per
word is identical (we verified). Compression ratio for any corpus is
identical. Only the labeling of 0/1 paths to leaves shifts. It's the
same category of arbitrariness as the alphabetical tie-breaker (§12).

**Mitigations considered (none chosen).** The artifact is unavoidable
in any normalize-first scheme with finite-precision arithmetic, because
`round(2c/T * S) ≠ 2 * round(c/T * S)` whenever the fractional part of
`c/T * S` is non-zero. Floor instead of round shifts the boundaries
but doesn't remove them. Higher SCALE (1e15, 1e18) reduces the
fraction of pairs that hit the artifact but doesn't eliminate it. The
only artifact-free option is rational/BigInt arithmetic: keep weights
as exact `(numerator, denominator)` pairs and cross-multiply for
comparison, exact-add for internal-node merges. Cost: ~2-3x slowdown
on the Huffman heap. For ~30K words this is a few extra seconds at
build time, which is acceptable but not free.

**Decision (2026-05-06).** Stick with §11.4 round as the canonical
math, accept the cosmetic byte-instability between historical raw-
count fixtures and current rebakes, document the artifact here so
the paper can reference it. Future rational/BigInt switch stays
available as an opt-in if precision ever matters for a downstream
reason (it currently doesn't).

**Scope of consequences.** Anyone holding cover-text encoded against
the raw-count-baked shipped fixtures (pre-2026-05-06) will need the
old fixture file to decode. New cover-text encoded against the post-
rebake fixtures decodes against any path that uses the same §11.4
math (Node bake, browser worker, any future build sink), since the
math has converged on one path.

## 12. Huffman tie-breaker design (research note, 2026-05-04)

When per-type Huffman weights tie (today's default uniform, or after
the §11 long-tail floors many words to weight=1), the input order
decides which leaves end up deep vs. shallow. Currently
`dct2mstr.js:46` sorts a type's words ascending alphabetical, so
alphabetical-late words get the shallow slots, e.g. `zebra` emits
more often than `ass` in any non-power-of-2 type.

The choice is arbitrary today. Worth exploring whether a smarter
tie-break could shrink cover-text expansion or improve naturalness:

- **Shortest-first.** Promote short words into shallow slots; directly
  minimizes chars-per-bit. Sort a type's words by `(wordLength desc,
  alphabetical asc)` before Huffman input, see "builder asymmetry"
  below for why the direction is desc, not asc.
- **Frequency-as-tie-break.** Among words at the same integer weight
  (common after the §11 floor), prefer the one with higher external
  frequency. Uses information already on disk; zero runtime cost.
- **Reverse alphabetical.** Cosmetic flip; no quantitative motivation.
- **Vowel/consonant policies.** Speculative naturalness story; no
  obvious quantitative win.

Measure before changing: per type, compute
`Σ_w wordLen(w) × 2^(-bits(w))` under current vs. candidate orderings,
weighted by per-type emission probability. The aggregate shrink ratio
tells us whether a fixture rebuild is warranted. Tie-breaker policy is
a global engine choice that re-bakes every shipped dict, so the bar
for changing it is empirical evidence, not aesthetic preference.

### 12.1 Builder asymmetry (recorded 2026-05-04)

The shortest-first sort direction matters because of a non-obvious
asymmetry in `huffman.js`. The min-heap breaks weight-ties by
`order ASC`, and items popped first are combined first, ending up
DEEPER in the tree. So the LAST-inserted word in a tied group ends
up at the SHALLOWEST slot, not the first.

Concretely, with `["a", "bb", "ccc"]` (lengths 1/2/3, all weight 1):
- `(length asc, alpha asc)` → input `["a", "bb", "ccc"]` → `ccc` at depth 1.
  Longest word at shallow slot, expected chars/emit = 2.25.
- `(length desc, alpha asc)` → input `["ccc", "bb", "a"]` → `a` at depth 1.
  Shortest word at shallow slot, expected chars/emit = 1.75.

So the originally-proposed `(length asc, alpha asc)` would systematically
make cover-text expansion WORSE, not better. The correct sort is
`(length desc, alpha asc)`. (Equivalently, leave the input alpha-asc and
flip the heap's tie-break to `order DESC`.) Same logic applies to the
freq-tiebreak proposal: to give higher-freq words shallower slots, sort
input by `(freq asc, alpha asc)` so high-freq goes last in insertion
order.

### 12.2 Empirical magnitudes (recorded 2026-05-04)

`tests/node/huffman-tiebreaker.test.js` runs the §12 metric over the
two shipped uniform-weight base dicts plus the §11.4 long-tail floor
regime:

```
master.dict (uniform, 11260 multi-word types, 149710 words)
  alpha-asc       : 96289   (baseline)
  len-asc-alpha   : 97744   (+1.51%, worse, confirms the asymmetry)
  len-desc-alpha  : 94912   (-1.43%)

mit.dict (uniform, 23 multi-word types, 25826 words)
  alpha-asc       : 137.01
  len-asc-alpha   : 144.04  (+5.13%, worse)
  len-desc-alpha  : 131.13  (-4.29%)

master.dict + norvig §11.4 floor (73.7% of words at weight=1)
  alpha-asc       : 95345   (baseline)
  len-asc-alpha   : 95666   (+0.34%)
  len-desc-alpha  : 95012   (-0.35%)
  freq-asc-alpha  : 95343   (-0.003%)
  freq-desc-alpha : 95346   (+0.001%)
```

Read: under uniform weight=1, length-desc tie-break trims ~1.4%
expected chars/emit on master and ~4.3% on mit. Once §11 frequency
weighting is in play, the headroom shrinks to ~0.35% (weights now
dominate; tie-break only affects same-weight groups). The §12
freq-tiebreak proposal is essentially noise (±0.003%) on master with
norvig, because most floor-weight words are norvig-absent and re-tie
at zero raw frequency.

Per-type top-10 (recorded in the test diagnostics) shows the wins are
spread across many small synonym types, not concentrated in a few big
ones, consistent with §12's identification of small-N non-power-of-2
types as the asymmetry's locus.

### 12.3 Alpha-vs-frequency correlation (recorded 2026-05-04)

`tests/node/freq-alpha-correlation.test.js` answers a complementary
question: across the three external freq lists, is alphabetical
position correlated with word frequency at all? If yes, alpha tie-
breaking has a directional bias; if no, it's unbiased noise.

```
norvig         (n=99,126)  Spearman ρ(alpha-rank, freq-rank) = 0.010
google-books   (n=261,594) Spearman ρ                        = 0.145
gutenberg      (n=278,069) Spearman ρ                        = 0.027
```

Norvig and gutenberg are essentially zero. Google-books shows weak
positive correlation; per-first-letter mean log10(count) shows the
effect is concentrated in two outlier buckets (`u` at 3.28, `n` at
3.59 vs. the rest at 3.9-4.2), not a smooth A-to-Z gradient.

Implication: alpha tie-breaking is statistically unbiased at the list
level on two of three sources, and only weakly biased (in the
"accidentally helpful" direction) on the third. Combined with §12.2's
~0.003% freq-tiebreak signal, this confirms the average-case headroom
for replacing alpha-asc with a freq-aware tie-break is negligible.
The length-desc result remains the only non-trivial win on the table.

### 12.4 Status

Three findings:
1. The §12 sort direction was wrong as originally written; corrected
   to `(length desc, alpha asc)` above.
2. Length-desc gives a real but modest ~1.4% improvement on uniform-
   weight master, ~0.35% with §11 frequency weighting; ~4.3% on the
   smaller mit base.
3. Freq-tiebreak gives ~0% in practice because the underlying alpha-
   freq correlation across the three lists is near zero.

Landed: `buildDictionary` gained an opt-in `tieBreak` option
(`'alpha-asc'` default | `'length-desc'`). BYOS shows a "Prefer shorter
words" checkbox below the freq-source picker that toggles the option
per session. Default off, so untouched recipes match shipped behavior.
Bake-time tools (`build-base-dict.js`, `build-corpus-dict.js`) read
the option from byos.base.tieBreak; shipped master / mit / chip fixtures
keep `tieBreak: alpha-asc` (the default) so they rebuild byte-identically,
see `docs/builders.md` "buildDictionary opt-in invariant" for the rule. The option flows
through `session.js` (folded into the cache key) and `share.js`
(emitted as `tb=ld` in the share URL plus a "Tick Prefer shorter
words." line in `describeRecipe`). Whether any bake-time tool ever
opts in is a separate, per-tool decision and not on the table here.

The freq-tiebreak proposal is not worth pursuing, §12.3's near-zero
correlations across the three freq lists predict the ~0% engine effect
that §12.2 confirmed.

## 13. Shipped base dicts vs. on-the-fly BYOS (parked, 2026-05-04)

Forward-looking design idea, not committed: at some point we may stop
shipping pre-baked base dictionaries (`master.dict.json.gz`,
`mit.dict.json.gz`, the chip dicts like `jfk.dict.json.gz` /
`shakespeare.dict.json.gz` / etc.) and instead treat the existing
"style cards" as preset BYOS recipes that build their dict in the
worker on demand from the smaller inputs (twlists + freq lists +
corpora + grammar).

If we go this way:

- Shipped fixture surface shrinks dramatically. Twlists + freq lists +
  corpora + grammars are smaller than the dicts they generate.
- A style preset is a serialized BYOS recipe: same shape as today's
  share-style URL params, just preloaded instead of pasted.
- "Shipping a new style" becomes "ship a new preset JSON," not "rebake
  and ship a new fixture."
- Every `buildDictionary` call becomes a runtime worker call. The
  engine's opt-in surface (see `docs/builders.md` "buildDictionary
  opt-in invariant") becomes the only relevant surface for tuning
  what a dict does, since there's no second class of "baked" outputs
  to keep consistent with.

Cost: every page-load that touches a style pays the build cost (a few
seconds in the worker; cached after first build). Today's chip dicts
load near-instantly from a packed SAB. The cycle-mode-style shared-SAB
cache already mitigates this for repeat builds within a tab.

Decide-only. The opt-in invariant is the right design either way: it
keeps the door open without forcing the choice.

## 14. Alternative encoding: power-of-2 subtype partitioning (research note, 2026-05-06)

NiceText today encodes within a type via per-type Huffman codes. This
note records an alternative scheme considered during the BYOS work: a
fixed-bit encoding that splits each type into power-of-2 subtypes,
with the cover-style picker choosing which subtype to draw from. The
scheme trades encoder bandwidth for cleaner frequency control. Worth
documenting for the paper because it sits next to Huffman in the
design space and has different optimization knobs.

### 14.1 Basic scheme (flat distribution within type)

Take a type with N words, none of which is a power of 2. Today's
Huffman approach allocates variable-length codes; this alternative
splits the type into multiple subtypes whose sizes are each powers of
2 and sum to N. Example: a noun type with 5 words splits into
`noun_group_a` (1 word, encodes 0 bits) and `noun_group_b` (4 words,
encodes 2 bits).

The cover-style generator (grammar / sentence model) treats the
subtypes as alternatives for "noun" and picks one with probability
proportional to subtype size: P(group_a) = 1/5, P(group_b) = 4/5.
Within the chosen subtype, the secret-bit stream consumes the
fixed-length code (0 bits in group_a, 2 bits in group_b).

Per-word emission probability: every noun emits with probability 1/5.
The distribution over the type is **flat**, regardless of the original
N. Average bits encoded per noun slot:

```
P(group_a) * 0 + P(group_b) * 2 = (1/5)*0 + (4/5)*2 = 1.6 bits
```

Compared to Huffman on 5 equal-weight words (~2.4 bits per slot, close
to the log2(5) ≈ 2.32 entropy bound), the subtype-split scheme
transports ~33% less secret per slot. The lost bandwidth was spent on
the random subtype selection, which is independent of the secret bits.

### 14.2 Frequency-weighted scheme (exact distribution match)

The basic scheme produces a flat distribution within each type. The
generalization: cluster words by target frequency and partition each
cluster into power-of-2 subtypes summing to its size. Subtype mass
becomes proportional to (cluster mass / subtype size) so per-word
emission probability matches the target distribution exactly.

Example with target frequencies w1=101, w2=33, w3=66, w4=66, w5=66
(total tc=332):

- `noun_group_a` = (w1), 1 word, mass 101/332, encodes 0 bits.
- `noun_group_b` = (w2), 1 word, mass 33/332, encodes 0 bits.
- `noun_group_c` = (w3, w4), 2 words, mass 132/332, encodes 1 bit.
- `noun_group_d` = (w5), 1 word, mass 66/332, encodes 0 bits.

Per-word emissions:
- P(w1) = 101/332 * 1 = 101/332 ✓
- P(w2) = 33/332 ✓
- P(w3) = 132/332 * 1/2 = 66/332 ✓
- P(w4) = 132/332 * 1/2 = 66/332 ✓
- P(w5) = 66/332 ✓

Exact match. Note that w3, w4, w5 share the same target frequency
(66/332) but are split across two differently-sized subtypes (group_c
size 2, group_d size 1). The group masses scale to compensate: group_c
gets mass 132/332 to spread over two words at 1/2 each; group_d gets
mass 66/332 for its single word.

Average bits encoded per noun slot:
```
(132/332) * 1 = 0.398 bits
```
A ~6x bandwidth drop compared to Huffman on the same weights
(~2.3 bits per slot, close to entropy 2.24). The bits the secret
doesn't encode are spent by the random subtype picker.

### 14.3 Two design knobs

The frequency-weighted scheme has two independent dials.

**Knob 1: clustering threshold.** How close must two words' target
frequencies be to share a cluster?

- Threshold = 0 (only exact ties cluster) → up to N clusters, exact
  frequency match, minimum bandwidth.
- Threshold = ∞ (everyone in one cluster) → 1 cluster, flat
  distribution, maximum bandwidth.

**Knob 2: within-cluster partition.** Once a cluster of k near-equal-
frequency words exists, partition into power-of-2 subgroups summing
to k. Larger subgroups deliver more bits per slot. For k=7: choose
4+2+1 (max bandwidth) or 1+1+1+1+1+1+1 (zero bandwidth) or any sum-
to-7 partition. Within-cluster partition does not affect frequency
match, only bandwidth.

### 14.4 Clustering strategies

All defensible; no obvious winner without measurement.

- **Quantile-based.** Fix the number of clusters K (driven by a
  bandwidth target), partition words into K equal-population buckets
  by frequency rank. Uniform cluster sizes regardless of distribution.
- **Distribution-aware (Jenks / natural breaks).** Find boundaries
  that minimize within-cluster variance and maximize between-cluster
  variance. Adapts cluster count to the data; isolates outliers (e.g.,
  the few highest-frequency words) and merges the long tail.
- **Std-dev-from-centroid.** Pick a threshold ε; merge words whose
  frequencies differ by less than ε. Adaptive but ε-sensitive.
- **Log-scale clustering.** Bucket by order of magnitude in log-
  frequency space. Closer to "perceptually comparable frequency"
  for natural language, which is Zipfian.

### 14.5 Zipfian distribution favors bandwidth

Natural language is Zipfian: a small head dominates token counts and
the bulk of word *types* sit in the long tail at very low frequency
(c=1, c=2). For this scheme:

- Head: top-K frequent words each have unique frequencies. Each
  becomes its own cluster, contributing 0 bits to bandwidth, but
  preserving exact frequency for the words readers notice most.
- Tail: thousands of c=1 words cluster into one large cluster.
  Partitioned into a 2^k subgroup of size up to k, this single
  cluster delivers ~log2(k) bits per slot whenever the encoder
  draws from the tail. For k=4096, that's 12 bits per slot in the
  tail-emitting case.

So the bandwidth profile is bursty: most slots emit 0-1 bits, a few
slots (when the tail cluster is selected) emit a lot. Average
bandwidth depends on the relative mass of head vs. tail clusters.

### 14.6 Comparison with Huffman

Huffman (current scheme):
- Variable-length codes per word.
- Bit lengths integer; emission probability per word is `2^(-bits(w))`
  (always a power of two of the type's emission rate).
- Frequency match is "snapped to nearest power-of-two bucket":
  approximate but information-theoretically optimal under the integer-
  bit-length constraint.
- Bandwidth: close to type entropy (log2 N for uniform, less for
  skewed). ~log2(type-size) bits per slot in practice.

Subtype partition (this note):
- Fixed-length codes per subtype.
- Frequency match can be exact (knob 1 set tight) or any quality in
  between exact and flat.
- Bandwidth: lower than Huffman, tunable via knob 2. Drops below 1
  bit per slot when most clusters are singletons; can reach
  log2(largest subtype) bits per slot for cluster-emitting slots.

When subtype partition might win:
- Stealth-over-payload regimes (perfect distribution match matters
  more than bits per slot).
- Simpler encoder/decoder (fixed bits per subtype, no Huffman tree).
- Cleaner frequency control: tweak knob 1 to dial fidelity
  continuously vs. choosing among Huffman tree topologies.

When Huffman wins:
- Payload-over-stealth (you want as many secret bits as the cover
  text permits).
- Already implemented and well-understood.

The two schemes are not mutually exclusive within a system: a future
NiceText could pick per-type. Decide-only; not on the implementation
roadmap.

## 15. Obfuscation space and trivial cryptanalysis (research note, 2026-05-06)

NiceText is steganography, not cryptography. The dictionaries are
public codebooks; there is no key. Counting "how many distinct
buildable styles" gives us a small obfuscation space, then walking the
adversary models shows just how trivial recovery is once those styles
are enumerable.

### 15.1 Counting the BYOS surface

Today's BYOS panel exposes the following independent knobs (treating
"Custom corpus" and "Custom TW-list" as binary use/don't-use slots,
since the bytes themselves never leave the tab, only their presence
flag rides on the byos):

| knob              | states              | notes                                     |
| ----------------- | ------------------- | ----------------------------------------- |
| Story Style       | 9                   | 7 named + Flat + Custom-corpus            |
| Sentence Scope    | 2 (1 if Flat)       | random / sequential                       |
| Vocabulary Scope  | 2 (1 if Flat)       | corpus / base                             |
| Base Dictionary   | 2^13 − 1 = 8,191    | 12 fixture sources + Custom-twlist; ≥1    |
| Frequencies       | 2^4 = 16 (8 if Flat)| style + Google + Norvig + Gutenberg       |
| Prefer shorter    | 2                   | tiebreak                                  |

Flat path: 1 × 1 × 1 × 8,191 × 8 × 2 = 131,056.
Non-Flat path: 8 × 2 × 2 × 8,191 × 16 × 2 = 8,387,584.
Total: 8,518,640 distinct buildable styles. log₂(8.5M) ≈ **23 bits of
obfuscation space**.

For comparison: AES-128 has 128 bits. DES (broken since 1998) has 56.
A 23-bit space is brute-forceable in milliseconds on commodity
hardware.

### 15.2 Why this is not a cipher

Three properties separate this from anything cryptographic:

1. **No key.** A user "selects" a style, but every byos.json is
   shareable plaintext (that's the whole share-style flow). Two
   parties using the same style aren't agreeing on a secret;
   they're agreeing on a public protocol parameter.
2. **Public codebooks.** Every base dict, model table, and
   frequency source ships as a fixture in this repository. An
   adversary downloads the same code we do.
3. **Deterministic, unmixed bit assignment.** Within a fixed style,
   each word w in a type t emits a fixed Huffman bit-string h(t,w).
   No diffusion: the bits read out of the cover are precisely the
   secret payload bits, in their original order.

A cipher hides the relationship between plaintext and ciphertext via
a secret key. NiceText hides the *channel* (the cover looks like
prose) and presumes the secret was already encrypted upstream. The
2002 Chapman & Davida paper makes this explicit: NiceText alone is
concealment; security comes from composition with real encryption
and the deniability that produces.

### 15.3 Adversary models

#### A. Has the software, has the cover, doesn't know which style

The user-facing warning Penny shows ("they can easily recover the
secret by trying all the styles") is exactly this. The attack:

```
for each of the 8.5M styles s:
    bytes = decode(cover, s)
    if bytes parses as the expected payload format (or has
    high-entropy ciphertext signature, or matches a known plaintext):
        return (s, bytes)
```

At a few ms per style, the whole space sweeps in seconds. Mitigation
is composition with real encryption: every recovered bytes blob now
*either* decrypts to plaintext under the correct key (so the attacker
needs the key, not the style) *or* looks like noise, exactly the
deniability framing.

#### B. Has only the cover, no software access

Harder, but still tractable on a corpus of any size. Outline:

1. **Lexer recovery.** The token boundaries (whitespace + the
   WORD_CHAR class) are observable; tokenize into a flat word
   stream.
2. **Type-grouping recovery.** Words within a type are interchanged
   per the cover's sentence model; words across types are not.
   Position-dependent co-occurrence statistics (which words appear
   in which sentence-template slot) cluster words into their types.
   This is straight unsupervised tagging on a self-consistent corpus.
3. **Bit assignment recovery.** Once types are recovered, the
   per-type Huffman trees are determined by per-word frequencies in
   the corpus: rebuild the trees, recover h(t,w) for every word.
4. **Bit recovery.** Read the cover word by word, look up the bit-
   string for each word in its inferred type, concatenate.
5. **Sentence-model overhead.** Sentence templates spend bits on
   shape selection, not payload; the recovered stream includes those
   "decoy" bits. Strip them by re-deriving the templates from the
   tokenized cover (same unsupervised step that recovered the types).

The whole pipeline is one or two days of focused engineering for an
adversary familiar with linguistic-stego literature, no novel
cryptanalysis required. The 23-bit space narrows further: an attacker
with the cover and any partial knowledge of the style (e.g. the
register: "this looks like Aesop") collapses the search to that
neighborhood.

#### C. Has the cover, has known plaintext

Trivial. Pick any candidate style, decode, compare known prefix to
recovered prefix. Linear in the obfuscation space.

### 15.4 Implications

The 23-bit space is not a security claim; it's a stealth budget. As
long as the cover passes a casual reader's plausibility check, the
goal is met. A reader who doesn't know NiceText exists has nothing
to enumerate; a reader who does has only the obfuscation space, and
the math above tells them how cheap exhaustion is.

This frames the paper's "future directions" honestly: any "more
combinations" feature widens the stealth budget but never approaches
cryptographic relevance. A 2^60 obfuscation space sweeps in a day on
a phone; a 2^80 space sweeps in a year of a single GPU. The right
research direction is composition (encrypt-then-smuggle, deniability
narratives, cover-style ensembles that resist register-based
narrowing in §15.3 step B), not key-space inflation.

Cross-references: §11 (frequency sources affect step B's tree
recovery), §14 (alternative encoding via subtype partitioning has the
same vulnerability surface; the public-codebook constraint is
fundamental to NiceText's framing).

## 16. BYOS optimizer: considered and rejected (research note, 2026-05-07)

A "BYOS optimizer" was scoped after seeing the personality-optimizer
in the sibling Span-It! project (which evolves Span-It! minimax weight
sets via round-robin tournaments). The first sketch borrowed that
shape directly: enumerate or genetically search the BYOS parameter
space (which base sources are checked, which freqs, scope, vocab,
tieBreak, customTw, customCorpus), score each candidate, return a
ranked leaderboard or a Pareto frontier. A separate
`byos-optimizer.html` page would drive a worker pool defaulting to
`hardwareConcurrency - 1`, and the same orchestration would be
callable from a Node CLI.

The concept dissolved on inspection. Recording why.

### 16.1 Expansion rate is closed-form

Expansion rate (cover bytes per secret byte) is the obvious single
scalar to optimize. It's also analytically computable from artifacts
the build pipeline already produces:

- The dictionary determines the bit-cost per type slot via the
  type's Huffman code length (`log2(wordCount)` if balanced; the
  weighted mean of code lengths otherwise; see §11 / §12).
- The model table determines the type-frequency distribution: each
  model's tokens are typed slots, weighted by the model's own count
  in the table.
- Expected bits per emitted token is the weighted average of code
  lengths over the type-frequency distribution. Expected characters
  per token follows from the dictionary's word-length distribution
  per type.

So `expectedExpansionRate = expectedCharsPerToken / expectedBitsPerToken`,
all computable directly from the dict and model SAB headers. Running
real conceals to measure it is just slow Monte Carlo for a value the
build pipeline could emit as a stat.

This already lands in the cover-stats panel as observed expansion
post-conceal. The optimizer's "expansion-rate winner" tells us
nothing the build artifacts can't predict to within Monte Carlo
noise.

### 16.2 Expansion isn't the goal anyway

NiceText is not a compression system. Nobody runs it to save bytes.
A 100x expansion that produces readable Aesop is a success; a 6x
expansion that produces word salad is a failure. Optimizing
expansion-rate alone optimizes the axis we don't care about, and
left to its own devices the optimizer would find dense-but-weird
covers (high-cardinality types densely packed with rare words).

### 16.3 Believability requires a proxy that isn't believability

To score "believability" automatically, the optimizer needs a
function cheaper than asking a human. Three candidates were
considered:

- **Literal-token rate.** Fraction of cover tokens emitted as
  `^foo^` quoted literals (the engine's escape hatch when no usable
  dictionary entry exists). Already computed, cheap. But it measures
  *engine fallback frequency*, not believability. A cover with zero
  literals can still read like word salad.
- **Bigram log-probability.** Score each cover under a precomputed
  bigram language model from a bundled reference corpus (Project
  Gutenberg, the master dict's source corpora). Bundling the bigram
  table is feasible (~1–10 MB at sane cutoffs) and zero-deps clean.
  But local n-gram statistics are insensitive to the kinds of
  incoherence that actually break believability (subject-verb
  mismatch, narrative incoherence, topic drift), and the optimizer
  would game whatever the bigram model happens to favor.
- **LLM-as-judge.** Send each cover to an external API for a 0–100
  score. Fails the project's zero-deps rule outright. Even setting
  that aside: 0–100 prompts are poorly calibrated across models,
  pairwise comparison blows up combinatorially, and the optimizer
  becomes a bias-finder for whatever the judge model happens to
  reward (length, vocabulary, formality).

Every candidate proxy is gameable, and the optimizer is by
construction the thing that games it. A few thousand evaluations of
"maximize believability-proxy P" is a few thousand chances to find
the BYOS that best exploits whatever P misses about real
believability.

### 16.4 The actual metric is unmeasurable

What NiceText needs from a cover is *plausible-deniability cover*,
which decomposes into two human judgments:

- **Believability:** does this read like prose a human might write?
- **Entertainment value:** does it read like prose a human would
  want to share, fun, romantic, absurd, period-appropriate, in
  character with the chosen style?

Both are inherently subjective, vary per secret length and style,
and depend on the reader's expectations. There is no scalar fitness
function that captures them, and any approximation is a different
metric wearing the same name.

### 16.5 The product already has the right ergonomic

The Conceal button is a one-click human filter. If a developer
doesn't like the cover the engine produced, they click again. The
engine generates a different cover each time (random sentence-model
selection, bit-aligned alternative slots when ties exist). Three or
four re-rolls usually produce something the developer is happy to
ship.

This is the right shape for a domain where the metric is subjective:
defer to the human at the only point that matters (the moment they're
about to share the cover) and make re-rolling cheap. An automated
optimizer searching ~2^23 BYOS combinations to find the one whose
*first* cover happens to read well is solving the wrong problem.

### 16.6 What an optimizer would have given us

In the spirit of "considered and rejected", what we *would* have
gained:

- An expansion-rate leaderboard that adds nothing closed-form
  prediction can't supply.
- A believability-proxy ranking that, by construction, is a ranking
  on the proxy and not on believability.
- A cache of pre-evaluated BYOS fitness keyed by `BYOSID`, useful
  only insofar as the fitness function is useful, which §16.3 says
  it isn't.

The one thing the optimizer plumbing would genuinely help with is
**scaling human evaluation**: run cheap proxies first to shrink the
candidate set from thousands to ~50, then surface those 50 via a
pairwise-comparison UI. That's a different feature ("BYOS browser
with cheap pre-filtering") and isn't what was originally scoped.

### 16.7 Implications for the paper

The right framing for the paper's "future directions" or
"limitations" section: NiceText's value lives in the
human-in-the-loop ergonomics, not in finding a globally optimal
style. A research project that built and trained a high-quality
believability scorer would be interesting, but its outputs would
characterize the scorer, not the steganography.

Cross-references: §11 (frequency sources are part of the BYOS space
the optimizer would have searched), §15 (the same 2^23 obfuscation
space is the optimizer's nominal search space; see §15.4 on why
widening it isn't a cryptographic gain).

## 17. Position-coded side channels and the bit-count crossover (research note, 2026-05-07)

This note records a thought experiment that surfaced a useful framing
principle: NiceText earns its keep specifically as a *linear-in-N*
algorithmic encoder, and only when N is large enough that the
*exponential-in-N* cost of rejection-sampled position-coding becomes
impractical. For tiny secrets, NiceText adds nothing over a plain
email and a pre-shared parity rule.

### 17.1 The thought experiment

Setup: a spy needs to convey one bit to a handler ("is the operation
a go?"). Construct a minimal NiceText configuration:

- Custom corpus = `"yes."` (a single word, terminated so genmodel
  flushes a sentence pattern).
- Custom twlist = `x,yes` and `x,no`.
- Vocabulary scope = "Only words from the story" (so the dict is
  built from the corpus ∩ twlist intersection: type `x` with two
  words `yes` and `no`).

Encode "yes." (4 bytes, ~32 bits + framing) → cover is ~35 yes/no
words separated by periods. Optionally feed through cycle mode (§16
references; per `docs/cycle-mode.md`) for `n` iterations of
conceal+gzip, producing increasingly long yes/no streams. Pre-share
`(n, i)` with the handler. The handler reads the i'th word of the
n'th cycle's cover; that word is the operational answer.

### 17.2 The reduction

The above scheme is information-theoretically equivalent to:

- Spy sends a normal email.
- Pre-shared agreement: parity of the i'th letter of the n'th word
  encodes go/no-go.
- Handler reads one byte, computes parity, recovers the bit.

Both schemes carry one bit. Both depend entirely on `(n, i)` being
secret. Both have tiny key spaces. Both fail catastrophically if the
scheme is known to the adversary.

The plain-email version is **strictly better** on every practical
axis:

- **More plausible carrier.** A normal email beats a yes/no stream.
- **No tooling or protocol fingerprint.** Cycle mode is identifiable
  as cycle mode; a normal email isn't.
- **Lower computational cost.** No conceal/gzip iterations.
- **Same security.** Both schemes' secrecy lives in the position
  index, not in the carrier.

For a 1-bit signal, the elaborate stego apparatus is theater. The
plain-email parity trick wins.

### 17.3 Generalizing: position-coding side channels

The 1-bit case generalizes. For N bits the sender pre-shares N
position-and-parity rules (or a deterministic generator: a seeded
PRNG over byte offsets, with a parity rule per position). The
sender writes *any* cover and rejection-samples: keep generating
candidate covers until the parities at the agreed positions match
the desired N bits. Recipient reads the N positions, computes
parities, recovers N bits.

Carrier can be anything: an email, a tweet, a grocery list, a yes/no
stream from NiceText, the digits of pi starting at a pre-agreed
offset. Information-theoretically interchangeable.

### 17.4 Why rejection sampling breaks

A random cover satisfies N specific parity constraints with
probability `2^-N`. Expected number of covers to generate before one
matches is `2^N`.

| N (bits) | Expected covers | Practicality |
|----------|-----------------|--------------|
| 1        | 2               | trivial: any random cover, 50/50 chance |
| 8        | 256             | trivial: write a handful, one matches |
| 16       | 65,536          | feasible if cover generation is automated |
| 20       | ~10⁶            | borderline; minutes of automated generation |
| 30       | ~10⁹            | impractical without dedicated infrastructure |
| 64       | ~10¹⁹           | hopeless |
| 256      | ~10⁷⁷           | hopeless even with all the world's compute |
| 8,192    | ~10²⁴⁶⁶          | (a 1 KB secret) absurd |

Either the sender selects positions *after* writing the cover (which
loses the pre-shared-key model and pushes secrecy onto the position
list itself, blowing up its size with N), or rejection sampling
becomes infeasible somewhere in the 20–30 bit range.

For larger N the sender's only practical options are:

1. **Hand-craft** text whose parities satisfy all N constraints.
   Tedious; brittle (one edit breaks it); doesn't scale past ~30
   bits in any reasonable amount of time.
2. **Algorithmic encoder** that builds the constraints into the
   cover-generation loop. The encoder picks each token under the
   joint constraint of "fits the language model" and "carries the
   right bits."

### 17.5 Where NiceText earns its keep

NiceText is exactly the algorithmic encoder of (2). Each emitted
token carries a known number of bits via the Huffman walk over types.
Cost is **linear in both cover length and secret size**, at the
price of producing a recognizable artifact (the cover IS a NiceText
output, not a free-form email).

The cover is by-construction natural language because the encoding
is integrated into the language model. Huffman trees over types
that respect the dict's word-frequency distribution, sentence
patterns drawn from a real corpus's CFG model. The naturalness is
not bolted on; it falls out of the encoder design.

### 17.6 The crossover

Combining §17.4 and §17.5:

- **N ≲ 20 bits**: position-coding with rejection sampling on a
  free-form carrier wins. The carrier looks more natural, the
  protocol fingerprint is zero, the security is identical (both
  schemes' keys are tiny).
- **20 ≲ N ≲ 30 bits**: borderline. Rejection sampling needs
  automation; the sender is already running a script. NiceText
  becomes competitive on engineering effort even though
  position-coding is still feasible.
- **N ≳ 30 bits**: rejection sampling is impractical. NiceText (or
  any per-token algorithmic stego) is the only scalable answer.

The crossover varies with assumptions (how much CPU the sender will
burn, whether the position list itself is part of the secret, what
"plausible carrier" means in context), but the qualitative shape
holds: NiceText earns its keep at non-trivial secret sizes and not
before.

### 17.7 Implications

This sharpens the paper's framing of when linguistic steganography
is the right tool:

- Linguistic stego is a **bulk-encoding** technique. For tiny
  payloads, simpler covert channels dominate.
- The "naturalness" of the cover matters specifically when the
  cover-as-a-whole is the channel, not when a single position
  within it carries the signal.
- Plausible deniability is a property of the carrier-shape and the
  generation process, not just of the bit-extraction protocol. A
  free-form email rejection-sampled to satisfy a few parity
  constraints is more deniable than a yes/no stream from NiceText
  cycle mode.

The paper's "where NiceText fits" section should lead with the
bit-count crossover and use the spy-with-1-bit example as the
counter-illustration.

Cross-references: §15 (the obfuscation-space framing complements
this; §17 is about secret size, §15 is about key size, both
characterize where the system isn't doing useful work). §16 (the
optimizer-rejected note shares the meta-pattern of "considered
elaborate apparatus, found simpler alternative dominates"). The
cycle-mode design at `docs/cycle-mode.md` is what the §17.1
thought experiment runs through; its real-world value is for
non-trivial N where the deniability bound from re-generating
plausible decoy s(-1) chains is the actual property, not for
1-bit signaling.

## 18. Augmentation pipeline (fixed-point iteration)

The dict-build phase applies *augmentations* (augs) to the
concatenated TWLIST entries before sortDict and Huffman coding.
Today's set is four augs:

- **vowel** (`begins_with_a_vowel`): for every entry whose word
  starts with a vowel-class character, append a copy under the
  `begins_with_a_vowel` type. Used by grammars for `a`/`an`
  agreement.
- **emojiIntoWords (Aug A)**: for each emoji, find every word
  type containing one of its CLDR keywords; append `(T_word, emoji)`.
- **wordsIntoEmoji (Aug B)**: inverse of A. For each emoji's CLDR
  keyword that exists as a word elsewhere, append `(T_emoji, keyword)`.
- **mixedPhrases (mix, integer 0..MIX_MAX)**: folded into Aug A and
  Aug B. Per (emoji, CLDR keyword, target type) tuple, emits one
  word-phrase per level n in 1..N (`"k E×n"`) plus one bare-emoji
  repeat per level n in 2..N (`"E×n"`). Real chat-register patterns
  (`omg 💀💀💀`, `love it 💖💖💖💖`). N is the dial knob; output
  scales linearly. Earlier "narrow/wide" mode design retired,
  see §C of `docs/phrase-and-charset-spec.md` for the replacement
  semantics and the wide-mode failure analysis that motivated it.

Each aug is a pure function over the running entries bag. None
operates on dictionaries; none reads from the filesystem; all
emit additional `(type, word)` entries that share the bag with
their inputs.

### 18.1 The ordering trap

Augs are not commutative. `e(v(t))` differs from `v(e(t))`: when
v runs first, e sees a richer `wordTypes` map (the
`begins_with_a_vowel` membership) and emits cross-type pairings v
alone wouldn't have surfaced. When e runs first, v never sees the
phrase entries that emoji-aug introduces (e.g. `"apple 🍎"`),
so `begins_with_a_vowel` misses them.

Picking a hand-curated chain order works for today's four augs but
breaks the moment a fifth aug lands: every existing aug needs to be
re-checked against every new aug for cross-dependencies.

### 18.2 Fixed-point iteration

The chosen design sidesteps order entirely with a snapshot-based
fixed-point loop. Notation:

- `t0`: the original concatenated TWLIST entries (no augs).
- `xti`: aug `x`'s contribution at iteration `i` (just what x added,
  not the running bag).
- `ati`: `{xti for x in selectedAugs}`.
- `ti`: full bag at end of iteration `i`: `t0 ∪ at1 ∪ ... ∪ ati`.

Algorithm:

```
i := 0
loop:
  i := i + 1
  for each x in selectedAugs:
    xti := x(ti-1 \ x's-prior-contribution)
  ati := union of xti
  if ati is empty: break (converged)
  if i == |selectedAugs| + 1: warn (still emitting at theoretical cap), break
return t0 ∪ at1 ∪ ... ∪ ati
```

Properties:

- **Order-independent.** All augs at iteration `i` see the same
  snapshot `ti-1`. Their contributions merge into `ati` without
  mutual interference within a round.
- **Convergent.** The emission universe is bounded by `(types ×
  words × phrase-shapes)`, finite. Each aug's internal `seen`
  Set guarantees no entry is emitted twice. Eventually no new
  emissions are possible and the loop exits.
- **Cap chosen at `|selectedAugs| + 1`.** The longest possible
  dependency chain through N augs is N hops; one extra iteration
  confirms no-op convergence. If iteration N+1 still emits new
  entries, an aug is misbehaving, log a warning, accept the
  current bag, move on.
- **Self-exclusion is efficiency, not correctness.** Each aug at
  iteration i ignores its own iteration-(i-1) contribution because
  re-applying an aug to its own output produces only duplicates
  (caught by the dedup anyway). The exclusion saves cycles.

### 18.3 Why this matters

Two outcomes that the fixed-point design buys:

1. **New augs compose without surgery.** Drop in a fifth aug, give
   it a dedup guard, register it with the orchestrator. No call-site
   reordering. No "where in the chain does this go" review.
2. **Cross-aug interactions surface naturally.** If a future aug
   produces output that vowel-aug should pick up (a new vowel-class
   token form, say), v sees it on the next iteration. No special
   plumbing per pair.

The implementation runs entirely in memory: no `vt.twlist.gz` /
`et.twlist.gz` intermediate files, no extra persistence surface.
The output of the loop feeds directly into sortDict →
buildDictionary → SAB pack, same as today.

This section closes the §C augmentation discussion in
`docs/phrase-and-charset-spec.md`: where that document specified
*what* each aug does, this one specifies *how* they compose.

### 18.4 SAB-packed snapshots, multi-worker execution

(Historical motivation: the original three-mode `mixedPhrases`
design (false/narrow/wide) included a wide mode that performed a
type-membership-walk across the matched target type. Its output on
heterogeneous TWLISTs like master ran into the JS-engine Map/Set
cap and produced incoherent pairs (`sad 😀`, `cat 😀`) on POS and
morphology classes. That mode was retired; mix is now an integer
folded into A and B. The SAB + multi-worker rewrite originally
motivated by the wide-mode ceiling is still load-bearing for any
future high-fanout aug.)

The first in-process JS-object implementation of the fixed-point
loop hit two real ceilings at master-TWLIST scale:

- **JS engine cap**: `Map`/`Set` size limit (~2^24 ≈ 16M
  entries). The retired `mixedPhrases='wide'` mode on master could fan past this
  in iteration 1 alone (3500 emojis × CLDR keywords × type sizes).
- **Throughput**: building a `seen` Set per aug per iteration
  over a 300k+ entry array, plus rebuilding emoji-aug indexes per
  call, drove a single Build past 60s with no progress visibility.

The chosen architecture target lifts both:

- **Entries packed into a SharedArrayBuffer** (one SAB per
  iteration's snapshot, one SAB region for each aug's
  contribution). Format mirrors the existing dict-SAB string-pool
  layout: a header + offset table + UTF-8 string pool. Augs read
  packed entries directly, dedup via a custom hash table inside
  the SAB. Limit becomes available memory rather than the JS
  engine cap.
- **Multi-worker execution** within an iteration. Workers run
  augs in parallel against the shared snapshot SAB and write
  contributions into pre-allocated output regions. Pool size:
  `max(min(hardwareConcurrency - 1, augCount), 1)`. When the
  pool is smaller than `augCount`, the orchestrator queues
  remaining augs and recycles workers as they free up, augs
  stay in their packed-SAB single-shape implementation regardless
  of pool size.
- **Iteration barrier**: all augs of iteration `i` must complete
  before iteration `i + 1` starts (the snapshot-semantics
  invariant from §18.2).
- **Single progress path**: the orchestrator emits per-iteration
  and per-worker completion events, replacing the in-process
  callback hooks that would have lived inside each aug. One owner
  for cadence reporting.
- **Node-side parity**: fixture builds (`tools/byos-build-helpers.js`)
  use `os.availableParallelism()` (Node ≥ 18.14) for the pool size
  in place of `navigator.hardwareConcurrency`. Same orchestration
  shape, same SAB format.

Tradeoff: the augs themselves require a one-time rewrite to
operate on packed-byte snapshots rather than `{type, word}` JS
objects. After that rewrite, transferring snapshots between the
orchestrator and N workers is genuinely free (SAB is shared by
reference, no `postMessage` clone).

The fixed-point algorithm in §18.2 is unchanged; SAB + workers
is purely an implementation strategy under the same semantics.


## 19. Believability vs. round-trip recoverability (research note, 2026-05-10)

Throughout the engine we hit shapes where the cover's natural-language
appearance could be improved (e.g. balanced quote marks, balanced
parens, "Chapter 1" followed by "Chapter 2" in monotonic order, fewer
single-letter words bleeding through as fallback emits, no
mid-sentence proper-noun substitutions). Improving these would mean
introducing semantic-group models, ordering invariants across
sentence boundaries, or token-level grammar checks beyond
parts-of-speech.

The architectural framing for this tradeoff: **round-trip recovery
always wins over believability**. NiceText's job is to round-trip
secret bytes through cover and back. If a believability rule and a
recovery rule conflict, recovery is non-negotiable; believability is
nice-to-have. Concretely:

- Random sentence-model picking can produce unbalanced quote / paren /
  bracket pairs. To balance them would require semantic-group models
  (encode a `(` only after committing to a matching `)`). We don't,
  because it bloats the model and constrains encoding density. The
  cover reads slightly off; nicetext doesn't care.
- A user who wants strong believability can pick sentence-mode =
  sequential and choose a corpus whose paragraph structure already
  yields balanced groupings. That's a recipe choice, not an engine
  requirement.
- A different research direction (semantic models, plot continuity,
  named-entity tracking) is interesting but out of scope. A modern
  AI tool can be asked "compress, encrypt, then steganograph this
  message into a picture" with arguably better hidden-channel
  properties. NiceText's value proposition is different: deterministic
  recoverable bit-for-bit round-trip through a public, transparent,
  open-source codebook.
- The same framing constrains the corpus pre-clean pipeline (rules
  added at the corpus-text level before genmodel): every pre-clean
  decision is "if this shape COULD cause lexer round-trip mismatch,
  drop or normalize it." Believability impact is weighed but is
  always the tiebreaker, never the deciding factor.

### Pre-clean rule explicitly considered and dropped: long punctuation runs

Considered: collapse continuous PUNCT-class runs longer than N chars
(stylized `!!!!!!!!!!!!!!!!`, ASCII dividers `**********`, etc.) to
prevent oversized literal puncts in the model.

Decision: dropped. The lexer's `EOS_RE` has no length cap, so a
100-char terminator run lexes cleanly as one EOS token; round-trip
works. The rule would have only saved model-literal size and made
covers slightly less stylized, purely aesthetic gains that don't
clear the round-trip-is-the-only-critical-function bar.

## Is the cover a substitution cipher?

Yes, from the cryptanalyst's perspective. The cover IS a simple
substitution cipher: each word maps to one fixed bit-string (the
word's Huffman code in the active style's dictionary). Per the
project invariant "one word, one Huffman code," the decoder is
type-blind, it does a flat word → code lookup. Multi-word phrases
add a small wrinkle (a phrase entry like "and/or" carries one code
for the whole token) but the substitution structure is unchanged.

The encoder is more sophisticated. It picks WHICH word to emit at
each slot based on:
  - a sentence model (which type comes next at each position)
  - a per-type Huffman codebook (selecting the word whose code
    matches the next bits of the secret)

That makes the ENCODER something like polyalphabetic + homophonic
substitution: multiple per-type codebooks selected by context. But
none of that machinery survives into the cover. The output is a
flat stream of words, decoded by a single word → code table.

Practical consequence for cryptanalysis: cracking any one word
gives you a permanent bit-string-to-word mapping for that style.
An attacker who recovers enough words from a captured cover can in
principle reconstruct the dictionary used. This is the operational
meaning of the project tenet "dictionaries are public codebooks,
not keys", the substitution cipher analogy is honest, not just a
teaching device.

scramble() (the inverse-direction utility) is unambiguously a
simple substitution cipher: parse tokens, look up each in the
dictionary, emit the matching code (or a null code for unknown
words / punctuation). No sentence model, no type tables.

Clarified during the May 2026 share-modal copy pass when we needed
to describe the cover story to first-time users.

## §N. Model enhancers, considered, rejected

In a May 2026 design conversation we explored a possible third
intervention category between rewriter and formatter: a "model
enhancer" that mutates the loaded NTMT in memory at encode-time,
walking model entries and cloning, rebalancing, or restructuring
them before the encoder's weighted-random sampler consumes them.

Concrete prototype that surfaced the idea: a Sentence-End style
variant (uptalk: `.` → `?`). Two viable implementations:

- **Formatter**: post-encode regex on surface text. ~10 lines,
  dict-blind, safe per Guideline 4 (`.` and `?` both tokenize as
  phrase-fusion barriers).

- **Model enhancer**: clone each model entry whose final punct is
  `.`, give the clone `?` and split the original weight between the
  two proportional to the intensity. Encoder's existing sampler
  handles the rest with no post-encode pass.

The model-enhancer route works but is order-of-magnitude more
complex, doubles model size, and has to handle sequential mode
alongside random. For the entertainment use case the project is
built for, no candidate transform surfaced that genuinely required
model-level surgery and couldn't be done as a rewriter (per-
emission `phraseBuf` mutation) or formatter (post-encode surface
transform). Cross-corpus blending, pattern-length scaling, and
weight rebalancing are the cases where model enhancers would shine
, but those are statistical tuning moves, not voice/style moves,
and they're achievable through card configuration today.

**Verdict:** not pursuing model enhancers as a separate category.
Stick with rewriters + formatters + plain models / dictionaries.
The pattern is documented here so a future session that genuinely
needs structural model surgery (e.g., grammar-aware sentence
reordering) has the framing already laid out.
