# SAB Binary Format for Shared Read-Only Artifacts

**Status:** locked-in. Eight resource categories pack and unpack
through `js/src/sab.js` (`dict`, `model`, `wlist`, `twlist`, `freq`,
`emoji-cldr`, `monotyped-model`, `rewriter`); every shipped fixture in `/fixtures` is a zero-parse
`.sab.gz`. Anchor tests in `tests/node/{dict,modeltable,grammar}-sab.test.js`
pin down the per-format layouts; `tests/node/sab.test.js` exercises
each category's pack + unpack round-trip; `tests/node/sab-fixtures-guard.test.js`
asserts the directory contains nothing else.

Spec, not plan. Captures decisions plus the design journey that
motivates them (paper-bound material).

## Scope

Covers the SharedArrayBuffer (SAB) binary format used for sharing
read-only artifacts across the worker pool, **both on disk and in
RAM**. The shipped on-disk form is now SAB-shaped:

- `fixtures/<id>.dict.sab.gz`: dictionaries (Huffman codebooks)
- `fixtures/<id>.model.sab.gz`: sentence-model tables
- `fixtures/<id>.wlist.sab.gz`: plain wordlists (sorted-unique,
  NTPS / packed-strings)
- `fixtures/<id>.twlist.sab.gz`: typed wordlists (entries-SAB /
  NTEN, `(type, word)` pairs)
- `fixtures/<id>.freq.sab.gz`: word-frequency sources (NTFQ, u64
  counts)
- `fixtures/<id>.emoji-cldr.sab.gz`: emoji → keyword-array map
  (NTCM)
- `fixtures/<id>.monotyped-model.sab.gz`: per-corpus monotyped-model
  precompute for Eve (NTMM, MM + collapsed-MM pools)
- `fixtures/<id>.rewriter.sab.gz`: per-rewriter apply-time lookup
  map (NTRW, `key → value-set`)

Plus CFG grammars (`/grammars/*.def`), packed to SAB at runtime
when loaded (no shipped `.sab.gz` for grammars yet, they remain
small enough that the runtime pack-in-worker pass is unnoticeable).

JSON / TSV / TXT files are the **native intermediates** the
build pipeline produces; `sab pack <category>` compiles them to
SAB and deletes the natives at the end of `build-all-fixtures`.
Natives are transient (they don't ship) but they're regenerable
from the upstream sources at any time. This document covers the
binary formats themselves; the build pipeline lives in
`tools/build-all-fixtures.js` and the build-guard in
`tools/sab-fixtures-guard.js`.

This document is paired with `docs/architecture-workers.md`, which
covers the worker pool and parent-as-broker registry that distribute
SAB references.

## Core decisions

### 1. Always-SAB for all shared read-only artifacts

Every read-only artifact that workers consume goes in a SAB. No size
threshold, no per-artifact-type carve-outs. Dicts, sentence-model
tables (small or large), CFG grammars: all SAB-backed.

The principle: one mental model, one access path, one binary
serialization pattern. Asymmetric "SAB for big, postMessage for
small" was considered and rejected; the consistency win outweighs
the small saved engineering on tiny artifacts.

### 2. SAB is now the on-disk form too

Pivot from the original "JSON-only on disk" stance. Every shipped
fixture in `/fixtures` is a `.sab.gz` (the SAB byte representation,
gzipped at rest). At load, the runtime fetches the gzipped bytes,
gunzips, and copies into a `SharedArrayBuffer`, zero parse, zero
worker round-trip just to materialize a SAB. The native JSON / TSV
/ TXT form lives only as a transient build-time intermediate that
`sab pack <category>` consumes and deletes.

The deferred-optimization escape hatch ("if first-load latency
becomes a problem, ship `.bin` files") is the live design today;
the SAB-fixtures arc realized it.

The build pipeline (`tools/build-all-fixtures.js`) enforces the
discipline: a final step asserts `/fixtures` contains only
`.sab.gz`, raw corpora (`*.txt.gz`), `.ttf` font files (copied from
`fixture-src/font/cooked/`), and four allowlisted runtime metadata
files. Any stray non-SAB fixture is a red build. See
`tools/sab-fixtures-guard.js`.

### 3. Pack at build time, wrap at load time

The SAB byte layout is computed once during the build, via
`node tools/sab.js pack <category>`. At runtime the loader fetches
the gzipped SAB bytes, gunzips into a fresh `SharedArrayBuffer`,
and the per-category `wrap*FromSAB` function returns a thin view
object that reads via byte-offset arithmetic, no per-realm parse,
no per-worker copy.

The build-time pack is the only place `JSON.parse` (or TSV parse)
runs for shipped fixtures. The on-the-fly pack-in-worker pathway
still exists as a fallback (`loadResource` runs `sab.pack()` if
the SAB form is missing and a native sibling is present), but the
shipped pipeline never exercises it: natives don't ship.

Browser-side dynamic builds. Custom Build's session-base
dictionary, still pack in a worker via
`js/src/worker/build-session-worker.js`. The result registers into
the resource-loader cache under a `pageLifeSpan:<byosId>` key, so
the encoder / decoder sees it through the same `loadResource` API
as any shipped fixture.

## The eight resource categories

Single-source-of-truth registry is `SAB_RESOURCE_CATEGORIES` in `js/src/sab.js`.
Each category has a distinct on-the-wire format and a corresponding
pack / unpack registered there. The build CLI (`node tools/sab.js
pack <category>`) and the runtime loader
(`loadResource(id, resourceCategory)`) dispatch by category token.

| Resource category | Magic | Pack / unpack module                       | Native ext             | Used by                                |
|-------------------|-------|--------------------------------------------|------------------------|----------------------------------------|
| `dict`            | NTDC  | `js/src/builder/sab-pack.js`               | `.dict.json.gz`        | encoder / decoder Huffman lookup       |
| `model`           | NTMT  | `js/src/builder/modeltable-pack.js`        | `.model.json.gz`       | encoder sentence-model stream          |
| `wlist`           | NTPS  | `js/src/eve/packed-strings-sab.js`         | `.wlist.txt.gz`        | Eve vocab-check, corpus-vocab matches  |
| `twlist`          | NTEN  | `js/src/builder/entries-sab.js`            | `.twlist.tsv.gz`       | BYOS session-base codebook             |
| `freq`            | NTFQ  | `js/src/builder/freq-pack.js`              | `.freq.tsv.gz`         | BYOS Huffman re-weighting              |
| `emoji-cldr`      | NTCM  | `js/src/builder/cldr-map-pack.js`          | `.emoji-cldr.json.gz`  | emoji aug (CLDR keyword pivots)        |
| `monotyped-model` | NTMM  | `js/src/eve/monotyped-model-sab.js`        | `.monotyped-model.json.gz` | Eve MonoTypedModelCheck detector   |
| `rewriter`        | NTRW  | `js/src/builder/rewriter-sab.js`           | `.rewriter.json.gz`    | cover-transforms rewriter apply-time lookup |

### Format discipline (every category)

Every SAB binary the codebase ships obeys three invariants. The
build's `sab.pack` enforces them; the per-format `wrap*FromSAB` /
`unpack*FromSAB` functions verify them on load:

1. **`u32 magic` + `u32 version` header.** First eight bytes of
   every SAB. unpack throws on magic mismatch (wrong category given
   the bytes) and on version mismatch (old fixture, format bumped).
   No silent corruption; old shipped fixtures fail loud on a
   format-version bump.
2. **`u32` size guard.** `sab.pack` refuses to emit any SAB whose
   `byteLength` meets or exceeds `2^32`. That's the cap on every
   u32 offset field across the formats. The guard triggers a clean
   error (`SAB_SIZE_CEILING`) instead of silent offset wrap.
   Nothing shipped today comes close (largest is
   `impkimmo2026-root.twlist.sab.gz` at ~127 MB compressed); the
   guard is a future-proofing tripwire, not a recurring concern.
3. **Little-endian everywhere.** All multi-byte fields are
   `DataView` LE reads / writes. Browsers and node both honor the
   explicit `true` flag, so the format is portable across runtimes.

### wlist vs twlist (never aliases)

`wlist` (NTPS) and `twlist` (NTEN) are **distinct resource
categories with distinct on-the-wire formats**, never aliases. A
wlist is sorted-unique words for O(log n) membership; a twlist
preserves the per-word `type` column for codebook construction. A
wlist is frequently a build-time projection of a twlist (the
twlist-wlist builder drops the type column, lowercases, dedupes,
sorts), but the projection produces a separate fixture, the
runtime category token names the format on the wire, not the
derivation that produced it. Eve consumers read wlists; BYOS
consumers read twlists. The naming discipline is enforced by
`tests/node/sab.test.js`'s `EXPECTED_TYPES` shape test and by
`js/src/resource-loader.js`'s protocol field separation (the
loader-proxy message envelope uses `resourceCategory`, not `type`,
to avoid conflating SAB category tokens with nicetext word-type
labels).

## Binary layout: dictionaries

Locked in by step 1 and pinned down by anchor tests in
`tests/node/dict-sab.test.js`. Authoritative field sizes live in
`js/src/builder/sab-pack.js` (`SAB_CONSTANTS`); the table below
mirrors them.

A key wrinkle made real by the actual JSON data: codes are genuine
Huffman codes (variable-length within a single type), not
fixed-length per type. For example, `fixtures/mit.dict.json.gz` has 20 of 37
types with mixed bit widths internally. So the per-type encode-side
representation is a Huffman tree, not a flat array.

```
[header]            magic, version, T, W, maxWordLength, section offsets
[type table]        T entries, name ref, wordCount, tree pointer
[tree nodes]        per-type Huffman tree node arrays
[byWord index]      sorted by word for decode-side binary search
[byTypeName index]  sorted by name for grammar/model resolveType
[string pool]       length-prefixed UTF-8 entries
```

### Header

Fixed 40 bytes, all little-endian:

| Offset | Field | Type |
|---|---|---|
| 0 | magic ("NTDC" LE) | u32 |
| 4 | version | u32 |
| 8 | typeCount T | u32 |
| 12 | wordCount W | u32 |
| 16 | maxWordLength | u32 |
| 20 | typeTableOffset | u32 |
| 24 | byWordOffset | u32 |
| 28 | byTypeNameOffset | u32 |
| 32 | stringPoolOffset | u32 |
| 36 | stringPoolLength | u32 |

### Type table

T entries, 24 bytes each, indexed by `(typeIndex - 1)` (typeIndex is
1-based; 0 is reserved). Verified contiguous from 1 by the packer.

| Offset | Field | Type |
|---|---|---|
| +0 | nameOffset | u32 (pool-relative) |
| +4 | nameLength | u16 |
| +6 | (reserved) | u16 |
| +8 | wordCount | u32 |
| +12 | treeNodeOffset | u32 (byte offset, not entry index) |
| +16 | treeNodeCount | u32 |
| +20 | typeIndex | u32 (the type's own typeIndex; redundant, easy) |

### Per-type Huffman tree

For each type, a contiguous run of nodes; each node is 12 bytes:

| Offset | Field | Type | Notes |
|---|---|---|---|
| +0 | leftChild | u32 | NO_NODE (0xFFFFFFFF) = no child |
| +4 | rightChild | u32 | NO_NODE = no child |
| +8 | wordOffset | u32 | NO_WORD (0xFFFFFFFF) for internal nodes; pool-relative offset for leaves |

Encoder lookup: walk root-to-leaf, one bit per step, reading
`leftChild` for bit=0 and `rightChild` for bit=1. Stop when
`wordOffset !== NO_WORD`. Single-word types have one node (root) that
is itself the leaf; the loop body never executes.

### byWord index

W entries, 16 bytes each, sorted alphabetically by word for binary
search:

| Offset | Field | Type |
|---|---|---|
| +0 | stringOffset | u32 (pool-relative) |
| +4 | length | u16 |
| +6 | bits | u16 |
| +8 | typeIndex | u32 |
| +12 | code | u32 |

Lookup `word → {typeIndex, code, bits}`: standard binary search.
Comparison reads bytes directly out of the string pool against the
TextEncoder'd query bytes. Zero allocation per comparison.

### byTypeName index

T entries, 12 bytes each, sorted alphabetically by name:

| Offset | Field | Type |
|---|---|---|
| +0 | nameOffset | u32 (pool-relative) |
| +4 | nameLength | u16 |
| +6 | (reserved) | u16 |
| +8 | typeIndex | u32 |

Used by `lookupTypeByName` (called from grammar `expand.js`,
`modeltable.js`, and the encoder's name-keyed `resolveType` path).
Same binary-search shape as byWord.

### String pool

All distinct strings (type names plus words) concatenated. Each entry
is length-prefixed:

```
[u16 length][bytes...]
```

References elsewhere (in type-table, byWord, byTypeName, tree-leaf
wordOffsets) carry just the pool-relative offset. The 2-byte length
prefix lets the reader decode without carrying the length redundantly
on every reference. Strings ≤ 65535 bytes (the packer rejects longer).

### Measured sizes

Actual `dict.sab.byteLength` from a fresh pack:

| Dict | JSON intermediate | SAB packed | Types | Words | Pack time |
|---|---|---|---|---|---|
| jfk | 50 KB | 0.07 MB | 518 | 528 | 5 ms |
| wizoz | 0.46 MB | 0.38 MB | 2,813 | 2,971 | 23 ms |
| aesop | 0.62 MB | 0.70 MB | 5,145 | 5,521 | 46 ms |
| mit | 2.5 MB | 1.20 MB | 37 | 25,840 | 168 ms |
| master | 16 MB | 13.52 MB | 52,500 | 190,950 | 1.6 s |

The "JSON intermediate" column is the size of the transient
`.dict.json.gz` build-time native, sized here for context only. It is
not an on-disk shipped form: `build-all-fixtures` deletes it after
packing, and only the `.dict.sab.gz` ships.

The master pack-time of ~1.6 s is dominated by tree construction
plus byWord sorting. Pack happens once per dict per page session and
runs in a worker so the main thread sees nothing. JSON.parse on
master.dict.json is roughly the same magnitude (~500 ms) and also runs
in the worker.

## Binary layout: sentence-model tables

Locked in by step 2. Anchor tests in
`tests/node/modeltable-sab.test.js`. Authoritative sizes in
`MODELTABLE_SAB_CONSTANTS` (`js/src/builder/modeltable-pack.js`).

A model table is an array of sentence "shapes," each a sequence of
token slots that the engine consumes one-per-encoded-word. JSON
shape:

```json
{ "version": 2, "name": "shakespeare", "ordered": false,
  "typeNames": [...string...],
  "models": [
    { "tokens": [12, "Cap", 7, ". n"], "weight": 5 },
    ...
  ] }
```

Each token in the JSON is either a non-negative integer (index into
`typeNames`) or a string (a punct value: `"Cap"`, `". n"`, `","`,
etc.). Distinct puncts per table are small (~10-15 in practice) so
they get interned into a tiny side table; the wire format stores one
4-byte token per slot with a flag bit for punct vs. typeName.

### Layout

```
[header]      48 bytes
[typeNames]   T' u32 entries (each = stringOffset into pool)
[puncts]      P  u32 entries (each = stringOffset)
[modelTable]  M  entries (12 bytes each)
[tokens]      N  u32 tokens (high bit = punct flag, low 31 = index)
[stringPool]  length-prefixed UTF-8 entries
```

### Header (48 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | magic ("NTMT" LE) | u32 |
| 4 | version | u32 |
| 8 | typeNameCount T' | u32 |
| 12 | modelCount M | u32 |
| 16 | punctCount P | u32 |
| 20 | orderedFlag | u32 (0 or 1) |
| 24 | typeNamesOffset | u32 |
| 28 | punctsOffset | u32 |
| 32 | modelTableOffset | u32 |
| 36 | tokensOffset | u32 |
| 40 | stringPoolOffset | u32 |
| 44 | stringPoolLength | u32 |

### typeNames table

T' entries × 4 bytes; each is a u32 stringOffset (pool-relative).
Indexed directly by the typeNames index that appears as a token.
Length lives in the pool's length-prefix.

### puncts table

P entries × 4 bytes; same shape as typeNames. Built at pack time by
walking every model's tokens and interning each distinct string in
first-seen order.

### Model table

M entries × 12 bytes:

| Offset | Field | Type |
|---|---|---|
| +0 | tokenOffset | u32 (absolute byte offset into tokens section) |
| +4 | tokenCount | u32 |
| +8 | weight | u32 |

### Tokens section

N tokens × 4 bytes (where N = sum of all models' tokenCount).
Each token is a u32:

- **High bit (`0x80000000`) clear:** typeName index. Low 31 bits
  index into the typeNames table.
- **High bit set:** punct index. Low 31 bits index into the puncts
  table.

The encoder's `expandModel` walks a model's tokens left-to-right,
decoding each into either `{kind: 'type', typeIndex}` or
`{kind: 'punct', value}`. typeName indices are pre-resolved against
the dict at stream creation time (see "stream creation" below);
puncts are resolved per-token via the puncts table.

### String pool

Same shape as the dict pool: length-prefixed UTF-8 entries
`[u16 length][bytes...]`, references carry just the pool-relative
offset. Strings ≤ 65535 bytes (packer rejects longer).

### Measured sizes

| Table | JSON intermediate | SAB packed | T' | Models | Pack time |
|---|---|---|---|---|---|
| jfk | 43 KB | 0.04 MB | 518 | 47 | 4 ms |
| aesop | 0.62 MB | 0.57 MB | 5,145 | 1,936 | 29 ms |
| shakespeare | 9.2 MB | 7.03 MB | 22,931 | 71,867 | 219 ms |

As with the dict table, the "JSON intermediate" column sizes the
transient `.model.json.gz` build-time native, not a shipped on-disk
form. Only the `.model.sab.gz` ships.

### Stream creation

`modelTableStream(table, {dict, mode, random})` builds, once per
stream:

1. `nameToTypeIndex: Int32Array(T')`, for each typeName, the dict's
   typeIndex (or -1 if missing).
2. `nameHasBits: Uint8Array(T')`, whether each typeName resolves to a
   multi-word type (encoder needs at least one of these per model
   to make payload progress).
3. The two-tier model pool (clean: every type resolves; fallback:
   at least one bit-bearing slot resolves) is computed by walking
   each model's SAB tokens.

After setup, `.next()` picks a model index (random by weight, or
sequential), reads its 12-byte entry, decodes its tokens into a
small `{kind, ...}` array, and returns. One small array allocation
per model emitted.

## Binary layout: CFG grammars

Locked in by step 3. Anchor tests in `tests/node/grammar-sab.test.js`.
Authoritative sizes in `GRAMMAR_SAB_CONSTANTS`
(`js/src/builder/grammar-pack.js`).

A CFG grammar is a small graph of rules. Each rule has weighted
alternatives; each alternative is a sequence of tokens. Tokens come
in three flavors, classified at pack time:

- **punct**: a literal `{...}` content from the source `.def` file
- **rule-ref**: references another rule (the expander recurses)
- **name-ref**: references a type name (the expander emits a type
  slot for the encoder to fill)

The current parser produces 2-flavor tokens (`punct` and `ref`); the
packer classifies each `ref` against the rule table at pack time. A
ref whose name matches a rule becomes a rule-ref; otherwise a
name-ref. "Rule wins on conflict" matches the pre-SAB
`grammar.rules.has(name)` check.

### Layout

```
[header]      56 bytes
[rules]       R entries (12 bytes each)
[alts]        A entries (12 bytes each, A = total alternatives)
[altTokens]   T u32 tokens (high 2 bits = kind, low 30 = index)
[puncts]      P u32 entries (each = stringOffset)
[names]       N' u32 entries (each = stringOffset)
[stringPool]  length-prefixed UTF-8 entries
```

### Header (56 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | magic ("NTGR" LE) | u32 |
| 4 | version | u32 |
| 8 | ruleCount R | u32 |
| 12 | altCount A | u32 |
| 16 | punctCount P | u32 |
| 20 | nameCount N' | u32 |
| 24 | startRuleIndex | u32 |
| 28 | ruleTableOffset | u32 |
| 32 | altTableOffset | u32 |
| 36 | altTokensOffset | u32 |
| 40 | punctsOffset | u32 |
| 44 | namesOffset | u32 |
| 48 | stringPoolOffset | u32 |
| 52 | stringPoolLength | u32 |

### Rule table

R entries × 12 bytes. Indexed by rule index (0..R-1, in
parsed-grammar key order; first rule is at index 0 unless the
parser changes order).

| Offset | Field | Type |
|---|---|---|
| +0 | nameStringOffset | u32 (the rule's own name, for diagnostics/expgram) |
| +4 | altIndexStart | u32 (first alt's index in the alt table) |
| +8 | altCount | u32 |

### Alt table

A entries × 12 bytes. Alternatives belonging to the same rule are
contiguous; the rule entry's `altIndexStart` and `altCount` slice
the alt table for that rule.

| Offset | Field | Type |
|---|---|---|
| +0 | weight | u32 |
| +4 | tokenOffset | u32 (absolute byte offset into altTokens) |
| +8 | tokenCount | u32 |

### Alt tokens section

T tokens × 4 bytes. Each token is a u32:

- **bits 30..31** kind:
  - 0 = punct (index → `puncts[index]`)
  - 1 = rule-ref (index → `rules[index]`, expander recurses)
  - 2 = name-ref (index → `names[index]`, expander emits type slot)
  - 3 = reserved
- **bits 0..29** the 30-bit index

### Puncts and names tables

P (or N') entries × 4 bytes; each is a u32 stringOffset
(pool-relative). Length lives in the pool's length-prefix, same as
the dict's string pool.

### String pool

Same shape as the dict and model-table pools: length-prefixed UTF-8
entries `[u16 length][bytes...]`.

### Expansion

`js/src/grammar/expand.js` walks the SAB tree:

```js
function expandRule(grammar, ruleIdx, out, random, maxLength) {
  const rule = readRule(grammar, ruleIdx);
  const alt  = pickWeightedAlt(grammar, rule, random);
  for each token in alt:
    decode (kind, index) from u32
    if punct:    out.push({kind:'punct', value: readPunct(grammar, index)})
    if rule-ref: expandRule(grammar, index, out, random, maxLength)
    if name-ref: out.push({kind:'type',  name:  readName(grammar, index)})
}
```

Recursion depth is bounded by `maxLength` (default 1024); recursive
grammars (e.g., `S: a S | x`) get skip-and-retry handling per the
thesis `-l` flag, just like the pre-SAB version.

CFG grammars in practice are small: `mit-names.def` is 1.8 KB raw,
the largest OG tutorial grammar is 3.7 KB. Pack runs in
sub-millisecond and the packed SAB is similar order-of-magnitude
to the source text.

## Binary layout: monotyped models (NTMM)

Per-corpus precompute used by Eve's MonoTypedModelCheck detector.
One file per card corpus, `fixtures/<stem>.monotyped-model.sab.gz`,
built by `tools/build-monotyped-models.js` via `genMonotypedModel`
(`js/src/eve/monotyped-model-check.js`). The same builder runs at
session-runtime to pack the suspected's monotyped model into a
SharedArrayBuffer shipped to all per-card workers; one path serves
both build-time and session-time.

A **monotyped model (MM)** is a pure structural sentence template:
the output of `genmodel(text, metaDict)` where the meta-dict maps
every word to one type (`MONO_TYPE = 'g'`). Punct, EOS, and case
markers survive verbatim; word slots become `g`. Joined by `|`,
example: `Cap|g|g|,|g|.`

A **collapsed monotyped model (CMM)** is the same MM with every
run of consecutive `g` parts replaced by a single `g`. Example:
the MM above has CMM `Cap|g|,|g|.` Two MMs share a CMM iff they
share the same skeleton and the same number of `g`-runs. The CMM
is the canonical representative of the phrase-augment equivalence
class; matching by CMM tolerates run-length differences induced by
multi-word phrase entries in the encoder dict, with no per-
sentence variant enumeration.

### Layout (NTMM v2, little-endian)

```
header (40 bytes)
  u32 magic              "NTMM"  (0x4D4D544E)
  u32 version            2
  u32 uniqueCount        M    (unique MM count)
  u32 orderedCount       N    (corpus sentence count)
  u32 cmmUniqueCount     P    (unique CMM count, P ≤ M)
  u32 poolOffset         MM utf-8 pool offset
  u32 indexOffset        MM ordered-index array offset
  u32 cmmOffsetsOffset   CMM offsets array offset
  u32 cmmPoolOffset      CMM utf-8 pool offset
  u32 cmmIndexOffset     per-unique-MM CMM index offset

MM unique offsets  (4 * (M + 1) bytes)
  u32 per unique MM; offsets[i+1] - offsets[i] = byte length of
  unique[i]. The +1 sentinel holds one-past-end pool position.
MM pool            utf-8 bytes of the M unique sorted MM strings.
MM ordered index   (4 * N bytes) u32 per corpus position; index
                   into MM unique pool. Provides positional access
                   via .at(i) with no string duplication for
                   repeated sentences.
CMM offsets        (4 * (P + 1) bytes) u32 per unique CMM + sentinel.
CMM pool           utf-8 bytes of the P unique sorted CMM strings.
CMM index          (4 * M bytes) u32 per unique-MM index; value is
                   the index into the CMM pool for that MM's
                   collapsed form. Many-to-one mapping by design.
```

### Wrapper API

`wrapMonotypedModel(buf)` returns a view with:

- MM side: `at(i)`, `uniqueAt(j)`, `hasSorted(s)`,
  `iterateOrdered()`, `iterateUnique()`, `uniqueCount`,
  `orderedCount`.
- CMM side: `cmmUniqueAt(p)`, `cmmHasSorted(s)`,
  `cmmIndexOfUnique(j)`, `cmmIndexOfOrdered(i)`, `cmmAtOrdered(i)`,
  `cmmUniqueCount`.
- Cross-sab convenience (wrapper-as-object):
  `exactMatchAtOrdered(otherView, i)`,
  `variantMatchAtOrdered(otherView, i)`.

`packMonotypedModel(orderedSentences, opts)` builds the SAB from
an ordered MM string list (CMMs are derived internally via
`collapsedMonotypedModel`). `opts.shared: true` returns a
SharedArrayBuffer (session-runtime); default returns a plain
ArrayBuffer (build-time, gz to disk).

### Sizes in practice

Per-card fixtures range from 1 KB (jfk, 48 sentences) to 810 KB
(shakespeare, 114K sentences) gzipped. The CMM pool is meaningfully
smaller than the MM pool: ratios from ~14 % (claude-magical:
293/1256) to ~80 % (leaves-of-grass: 2445/3082) of unique-MM
count. The added CMM section costs only the marginal disk and
RAM for those P strings + offsets + a per-unique-MM u32 index;
runtime payoff is the elimination of the previous variant-
enumeration loop (~140-210× per-card speedup measured in
`tests/node/tmp/probe-monotyped-cost-v2.mjs`).

## Lookup code path

The exported functions in `js/src/dictionary.js`:

- `wrapDictionaryFromSAB(sab) → dict`: the runtime path. Wraps a
  pre-packed SAB into a thin `{sab, view, bytes, header, ...}`
  view. Zero parse; this is what the loader invokes on the SAB
  fetched from `/fixtures/<id>.dict.sab.gz`.
- `loadDictionary(json) → dict`: packs a parsed JSON object into a
  fresh SAB and wraps. Used by build-time tools and by tests that
  start from a JSON shape. Returns the same wrapper as
  `wrapDictionaryFromSAB` plus a `json` back-reference for
  cross-format assertions.
- `lookupWord(dict, word) → {typeIndex, code, bits} | null`,
  binary search over byWord index.
- `lookupType(dict, typeIndex) → typeRec | null`: direct array
  index into type table.
- `lookupTypeByName(dict, name) → typeRec | null`: binary search
  over byTypeName index, then `lookupType` for the full record.
- `readTreeNode(dict, typeRec, nodeIdx) → {leftChild, rightChild, word | null}`,
  hot-path primitive used by the encoder loop. `word` is `null` for
  internal nodes; the resolved string for leaves.

`typeRec` shape:
`{typeIndex, name, nameOffset, nameLength, wordCount, treeNodeOffset, treeNodeCount}`.

The encoder hot loop walks the tree explicitly:

```js
let node = readTreeNode(dict, typeRec, 0);
let bits = 0;
while (bits < MAX_HUFFMAN_BITS && node.word === null) {
  const bit = reader.readBits(1);
  bits++;
  const childIdx = bit === 0 ? node.leftChild : node.rightChild;
  if (childIdx === TREE_NO_NODE) throw new Error('invalid path');
  node = readTreeNode(dict, typeRec, childIdx);
}
fmt.emitWord(node.word);
```

Single-word types fall through naturally (root is the leaf, loop
body never executes). No special case needed.

When `SharedArrayBuffer` is unavailable (older Node, browser
without COOP/COEP), `packDictToSAB` falls back to a plain
`ArrayBuffer` with the same byte layout. Same lookup code, different
backing store. Cross-worker sharing requires SAB though, so the
fallback path supports inline callers only.

## Build pipeline

Multi-pass binary writer in `js/src/builder/sab-pack.js` (browser-safe
ESM). Same code called by:

- `tools/sab.js pack dict` during `build-all-fixtures`: the
  dominant path; produces the shipped `.dict.sab.gz` fixtures.
- `loadResource`'s native-fallback path: fires only if a SAB
  fixture is missing and a native sibling is present
  (off the shipped pipeline today, kept for ad-hoc tool runs).
- `js/src/worker/build-session-worker.js` for Custom Build's
  session-base dictionary, packs in a worker, registers into
  the loader cache under `pageLifeSpan:<byosId>`.

Steps for a dict (model tables and grammars follow analogous
patterns; the wlist / twlist / freq / emoji-cldr formats have
their own per-module variants but obey the same magic + version +
size-guard discipline):

1. **Validate.** Confirm types are contiguous from 1 (the layout
   indexes the type table by `typeIndex - 1`). Confirm
   `(version === 2)`.
2. **Group words by type.** Build `Map<typeIndex, words[]>`.
3. **Build per-type Huffman trees.** For each type's word list,
   insert each `(bits, code)` path into a tree (root at depth 0,
   bits walked MSB-first). Single-word types get a one-node tree.
4. **Flatten trees.** DFS each tree, assign each node a contiguous
   index, capture `nodes` array per type for the writer.
5. **Intern strings.** Walk type names then word strings, append
   UTF-8 bytes to the string-pool builder (length-prefixed), remember
   `(offset, length)` per string.
6. **Compute section offsets.** Header → type table → tree nodes →
   byWord → byTypeName → string pool. Allocate `SharedArrayBuffer`
   (or `ArrayBuffer` fallback) of exactly that total size.
7. **Write tree-nodes section.** For each type, write its nodes with
   resolved child indices and wordOffsets (looked up from interned
   strings via a `Map<wordRef, entry>` to keep the writer linear).
8. **Write type table.** One 24-byte entry per type with
   `(nameOffset, nameLength, wordCount, treeNodeOffset, treeNodeCount, typeIndex)`.
9. **Write byWord index.** Sort words alphabetically; write each
   entry as `(stringOffset, length, bits, typeIndex, code)`.
10. **Write byTypeName index.** Sort types by name; write each entry.
11. **Write string pool.** Concatenate the prefixed chunks.
12. **Write header.** Magic, version, counts, all section offsets,
    pool length, maxWordLength.

All passes are linear in `(types + words)`. For master.dict.json (51K
types, 156K words), pack runs in well under a second; the dominant
cost is the `JSON.parse` that precedes it.

## Cross-runtime concerns

### Browser

`SharedArrayBuffer` requires cross-origin isolation. The page must be
served with three HTTP headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin` (so same-origin
  sub-resources can load under isolation)

`tools/serve.sh` invokes `tools/serve.py`, which adds these headers to
every response. Use it for local dev work that needs SAB (the SAB-only
worker test, validating cross-worker sharing, etc.).

**Production: GitHub Pages.** GH Pages serves static files only and
does not let you set custom HTTP headers. The repo ships a Service
Worker COI hack that handles this: `coi-sw.js` at the deployment root
intercepts fetches and re-emits them with the three COI headers
added; `js/coi.js` (loaded by `nicetext.html` and
`tests/node/test-suite.html`) registers the SW and reloads once on first
visit. After the reload, the page is cross-origin isolated and SAB
works.

Behavior in each environment:

- **Local dev under `tools/serve.py`**: server sets the headers; SW
  registers but reload isn't needed (page is already isolated).
- **Local dev under plain `python3 -m http.server`**: SW registers,
  page reloads once, then isolated.
- **GitHub Pages**: same as plain http.server. First visit reloads
  once; subsequent visits hit the SW immediately.
- **Browser without ServiceWorker support** (rare modern; some
  in-app webviews, Safari Private Browsing pre-16): SW registration
  silently skips, engine falls back to per-worker `ArrayBuffer`
  copies, ~100-500 ms structured-clone overhead per job. Functional,
  just slower.

The SW + ArrayBuffer-fallback layering means SAB perf is
opportunistic: the engine uses it when available, gracefully
degrades when not, and the user-facing progress modal in
`nicetext.html` shows which path is active so a slow job's cause is
diagnosable.

Without isolation, the SAB-only browser test (the
`SharedArrayBuffer arrives without copy` smoke) skips via
`{skip: 'requires cross-origin isolation (COOP/COEP)'}`. All other
tests pass via the ArrayBuffer fallback path.

**TextDecoder + SharedArrayBuffer caveat.** `TextDecoder.decode`
refuses to read views over a `SharedArrayBuffer` (security
constraint: shared memory could mutate during decode). The string
pool readers in `dictionary.js`, `modeltable.js`, and
`grammar/expand.js` use `Uint8Array.slice()` (which copies into a
fresh non-shared `ArrayBuffer`) before passing to `TextDecoder`,
not `subarray()` (which shares the underlying buffer). Per-call
allocation is small (one short string at a time); the alternative
would be one bulk-copy of the whole pool at wrap time per worker,
trading allocations for fixed RAM cost.

### Node

`node:worker_threads` supports `SharedArrayBuffer` natively, no header
configuration required. `Atomics`, transferable streams, and SAB all
work the same as in the browser.

### Read-only access

The dict SAB is read-only after the parent thread (or loading worker)
finishes packing it. Workers only read; no `Atomics` synchronization
needed in the lookup hot path. The build pipeline is the only writer,
and it owns the SAB exclusively until pack completes.

## Design journey: raof to Map to SAB

Paper-bound material, and the authoritative home for this narrative:
`docs/architecture-overview.md` points here rather than retelling it.
This section is written with §7 of `whats-new.html` ("the modern JS
port") in mind. The story is the technical decision arc, fairly
accounted. For the labeled Map-vs-SAB measurement snapshot (startup,
retained memory, lookup throughput), see Table 1 in §7.4 of
`whats-new.html`; the numbers below are cited from that snapshot, not
re-measured here.

### 1995: raof and friends

The OG NiceText shipped a hand-crafted binary on-disk format
(`.dat` / `.jmp` / `.alt` files) built by `raofmake`, `raofmalt`,
`raofread` plus the supporting class hierarchy (`mtc++/raof*`,
`bst`, `rbt`, `mstring`, `mmstring`, `list`, `strlst`, `heap`,
`initfile`). The motivation was disk-and-memory scarcity: hard
drives were small, RAM was small, dictionaries had to fit on disk
and load fast. A red-black-tree-on-disk supported O(log W) lookup
without loading the whole dict into RAM. Multiple processes that
ran the OG tools also benefited implicitly from the OS page cache:
shared pages of the `.dat` file were not duplicated in physical
memory across processes.

The binary format was excellent engineering for its constraints. It
was also a lot of code: a substantial fraction of the OG sources is
the binary-format machinery.

### 2026: Map

The first JS port collapsed all of that. `String`, `Array`, `Map`,
and `Uint8Array` are built-in and cheap; "load the whole dict into
RAM as a Map" is acceptable; the on-disk-tree machinery has no reason
to exist. The thesis-era five formal dictionary properties
(power-of-2 word counts per type, lowercase uniqueness, etc.) survive
verbatim, but now they are invariants enforced by the JSON builders,
not by a B-tree on disk.

This was the right call for a single-threaded utility. The dict lives
in one process, in one Map, accessed by one event loop. Lookup is
`Map.get`. Memory is fine: a master-style base dict is about 13.8 MB
of Map heap per the §7.4 Table 1 snapshot, nothing on modern hardware
for a single process.

### 2026 part two: SAB

Workers reintroduce a problem the OG had implicitly solved with the
OS page cache: multiple isolates that each need the same read-only
data. A naive port pays N times the dict-RAM cost (every worker
holds its own Map) and N times the JSON parse cost (every worker
parses on boot). Per-worker copies undo the "memory is fine"
assumption from the previous step.

`SharedArrayBuffer` is the modern equivalent of the OS page cache:
one copy of the bytes, all isolates see them, no per-isolate ceremony
beyond sharing the reference. Reintroducing a binary in-RAM format
is the cost of admission. The shape of that format echoes the OG:
header, indexed sections, string pool, byte-offset lookups. The
destination changed from `fwrite` to `Uint8Array.set`, but the
algorithm reads almost identically to `raofmake`.

### The fair accounting

This is not a victory lap and not a confession. The OG team made the
right call for 1995, given disk and RAM constraints. The first JS
port made the right call for a single-threaded port: collapse
everything that was solving a problem JS no longer has. The third
move reintroduces the binary-format machinery in a transformed way,
motivated by a concurrency problem that did not exist in the original
problem space.

Same algorithm, different storage tier. Same author writing the same
lookup three different ways across thirty years, with different
language guarantees and different concurrency models, ends up at
three different shapes. That itself is worth recording.

## Companion document

`docs/architecture-workers.md` covers the worker pool and
parent-as-broker registry that distribute SAB references. The two
documents are paired.
