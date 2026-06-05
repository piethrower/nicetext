# Architecture Overview

Project design philosophy, target architecture, and the C++ → JS
collapse story. Companion to:

- `docs/architecture-workers.md`: worker enablement
- `docs/architecture-sab.md`: SAB binary formats and the
  raof → Map → SAB design journey
- `docs/builders.md`: corpus and dict builders
- `docs/web-ui.md`: locked-in `nicetext.html` UI state

## What this project is

A modern JavaScript port of **NiceText**, a 1995–2001 linguistic-steganography system by Mark T. Chapman and George Davida (UW-Milwaukee). NiceText converts arbitrary binary files into pseudo-natural-language text and recovers them losslessly. Original C++ source preserved verbatim in the sibling `OG-NiceText-C++` archive repository (read-only). Throughout this codebase, paths like `OG-NiceText-C++/nicetext-1.0/...` name files inside that archive.

Primary references in the archive at `nicetext-0.9/doc/`:
- `thesis.txt` (4782 lines): full M.S. thesis, the design bible
- `icics97.txt`: 16-page conference paper, condensed version

## Target architecture

**Browser-safe core, Node-only CLI shell.** This split is not optional, there's a planned web build where users drop a file into an HTML page and download the result.

**Zero external dependencies.** Pure JS / HTML / CSS only. No npm packages, no CDN scripts, no build toolchain. Node built-ins (in `js/bin/`, `tests/node/`) and web platform built-ins (in `js/src/`) are fine; nothing else.

Layout follows Span-It!'s conventions: HTML pages at the repo root, assets under
sibling top-level dirs (`css/`, `js/`, `img/`), tests under `tests/node/`.

```
./index.html, ./nicetext.html, ...   site pages, served by tools/serve.sh.
./css/        page stylesheets (nicetext.css, penny.css).
./img/        page images and SVG assets (penny.svg, nicetext-logo.svg).
./js/         web app entrypoints (app.js, penny.js, tutorial-script.js).
./js/src/     pure ESM. No fs, no Buffer, no process. Uint8Array everywhere.
              Same code runs in Node ≥20 and any modern browser.
./js/bin/     Node-only CLI wrappers. Read/write files, parse argv, call ./js/src/.
./tests/node/ node --test runner, test files run in Node and via
              tests/node/test-suite.html in the browser.
./fixtures/   gzipped JSON dictionaries / type tables / model tables /
              TWLIST sources / corpus texts (built artifacts + staged
              read-only data; everything is .gz at level 9).
./fixture-src/    raw word lists and natural-language texts (sourced from
              OG examples and bundled open-source distributions).
./tools/      build-time scripts (rebuild dicts from corpora, serve.sh,
              build-all-fixtures.js, etc.).
```

Dictionaries ship as `.dict.sab.gz`: a packed SAB binary, gzipped on
disk. JSON is only a transient build intermediate (the builders emit
JSON, `packDictToSAB` bakes it to the SAB layout). At load time the
gzipped SAB is fetched/read, gunzipped, and wrapped via
`wrapDictionaryFromSAB` into the runtime dict object the encode/decode
core consumes, no `JSON.parse` on the runtime path. The binary layout
and resource-loading mechanics live in `docs/architecture-sab.md`.

## Key design decisions (and why)

1. **No port of RAOF / RBT / BST / mstring / initfile / heap / entropy.** These were 1990s on-disk-tree machinery for fitting dictionaries on small disks and finding entries fast. Replaced with built-in JS data structures, then later re-baked into a packed SAB layout for cross-worker sharing. The full "raof → Map → SAB" design journey lives in `docs/architecture-sab.md` (the authoritative home); don't re-tell it here.

2. **No bit-faithful port of the `.dat`/`.jmp`/`.alt` binary format.** We don't read the OG dictionaries at all. We rebuild from the *source corpora* (texts and word lists in `OG-NiceText-C++/nicetext-1.0/examples/`) using JS-ported builders, producing JSON. The corpora are the source of truth; the binaries were derived artifacts.

3. **The bit-stream layer IS load-bearing.** `BitReader` / `BitWriter` over `Uint8Array`, MSB-first within each byte. Endianness and bit order must be internally consistent for round-trips; they don't need to match the C++ on-disk layout.

4. **SIZER/DESIZER, not `MINIMAL_EXTRA_BITS`.** The thesis (Ch. 2.3) defines a clean wrapper: `SIZER(C)` prepends a fixed-length encoding of |C|, then C, then an *infinite* pseudo-random tail. `DESIZER` reads the length and slices C back out. The C++ implements a hack (`extra bits` + 32-bit `0xFFFFFFFF` sentinel); we implement the principled abstraction. Same line count, cleaner semantics.

5. **Build first, then encode/decode.** We port `gendict` before the encoder so we have real dictionaries to test against. This avoids porting throwaway code (we'd otherwise have to read OG binaries just to throw the reader away once gendict works).

## Thesis insights that constrain implementation

These don't appear in the README and aren't obvious from code-skimming. Future sessions: don't rederive these.

- **Five formal dictionary properties (thesis Ch. 2.4):**
  1. ≥2 words in at least one type
  2. **Thesis claim:** "words per type = exact power of 2, fixed-length codes per type, not ceil(log2(n)) Huffman."
     Current implementation **deviates from this**: codes are genuine
     per-word Huffman (variable-length within a single type). See
     `docs/builders.md` for the data shape this actually produces.
     Density wins over thesis-property adherence in our port.
  3. Each word unique when lowercased
  4. Each `(type, code, bits)` triple unique (codes are prefix-free per type)
  5. No required correspondence between `(type, code)` and alphabetical order

- **Type merging:** When the same word appears in multiple types, the builder invents a new merged type (e.g. `name_female,name_male`, alphabetical comma-joined) and puts the word there. Preserves word-uniqueness without losing type information.

- **Power-of-2 enforcement via type splitting:** A 5-word type becomes a 4-word `Type_A` plus a 1-word `Type_B`. The encoder/decoder trust this invariant; the builder is responsible for it.

- **`expgram` and m-rules:** A portable grammar references abstract types like `mPERSON`. `expgram` reads the dictionary, finds all merged types containing `person` as a sub-type, and emits a weighted-alternation rule defining `mPERSON`. The user appends this fragment to their `.def` file. Without expgram, grammars aren't dictionary-portable.

- **`genmodel` produces two artifacts:** From a sample text, (a) a sentence-model table weighted by frequency *and* (b) a **distribution dictionary** D' = D ∩ vocab(sample). Style-source quality collapses without D'.

- **`.def` grammar syntax:** YACC-inspired. `RULE: rhs1 @weight1 --- rhs2 @weight2 ;`, `{Cap}` cap next word, `{CAPSLOCKON}`/`{capslockoff}` for runs, `{,}` / `{. n}` (period + space + newline) / `{?}` punctuation, `{^literal^}` quoted punctuation (output as-is, scrambler skips the contents), `//` line comments, first rule = start symbol.

- **Recursive grammars need `-l maxModelLength`:** Compound-sentence rules can recurse arbitrarily; encoder caps at `-l` and *retries* on overflow. Skip counter `S` is part of standard stat output.

- **`vowel` type is the canonical merging idiom:** `vowel.sh` gives all vowel-initial words an extra `vowel` sub-type so `art_a`/`art_an` rules can agree. Keep this as a reference example.

## Naming gotcha

- `nicetext` (CLI) = bits → text = **embed** (cover-generation). Internally `bits2txt`.
- `scramble` (CLI) = text → bits = **recover**. Internally `txt2bits`.

The names read backward. "Scramble the prose back into binary."

## Phase plan (history)

Original eight-phase plan, all delivered:

| # | Phase | Status |
|---|-------|--------|
| 1 | Verify mtc++ include surface | ✅ done |
| 2 | Scaffold JS project layout (`./js`, `./data`, `./tools`, `./corpora`, `package.json`) | ✅ done |
| 3 | Bit streams + SIZER/DESIZER (browser-safe) | ✅ done |
| 4 | gendict pipeline → JSON dictionaries | ✅ done |
| 5 | Encode/decode core + `nicetext`/`scramble` CLIs | ✅ done |
| 6 | Grammar engine + expgram | ✅ done |
| 7 | genmodel + model-table mode + corpora | ✅ done |
| 8 | Web UI MVP + style-by-example dropdown | ✅ done |

A separate worker-enablement arc (2026-04-29) layered SAB-backed
dicts/model-tables/grammars and on-demand workers on top, see
`docs/architecture-workers.md` and `docs/architecture-sab.md`.

**Phase 5 acceptance:** met. 1000-byte random binary → 8371 bytes cover text → byte-identical recovery on `fixtures/mit.dict.json.gz` (8.37× expansion ratio with the weighted type stream and the place-name-heavy MIT dictionary).

**Phase 4 acceptance:** met. Round-trip via real CFG grammar (`grammars/mit-names.def`) on `fixtures/mit.dict.json.gz` produces fluent prose like:

```
Chem, of Iraq, arrived with Domingo.
Dong-ik, of Honolulu, arrived with Ellary.
Berrin, of Luxembourg, arrived with Hale.
```

Recovered byte-identically.

## Engine module surface (core, current)

This section scopes to the **core encode/decode engine** modules in
`js/src/`. The worker, streaming, SAB, and cover-pipeline layers that
sit on top are not enumerated here, see the pointer at the end of this
section.

Browser-safe ESM in `js/src/`:

- `js/src/bitstream.js`: `BitReader` / `BitWriter` classes (the only classes in the engine).
- `js/src/dictionary.js`: `loadDictionary(json)` packs to SAB and returns `{json, sab, view, bytes, header, maxWordLength, phraseIndex, maxPhraseLen}` (`wrapDictionaryFromSAB(sab)` builds the same wrapper minus `json` straight from a packed SAB, the path workers use). `phraseIndex` / `maxPhraseLen` index multi-word entries for greedy phrase fusion. Lookup functions: `lookupWord`, `lookupType`, `lookupTypeByName`, plus `readTreeNode` for the encoder's per-type Huffman tree walk.
- `js/src/builder/sab-pack.js`: `packDictToSAB(json) → SharedArrayBuffer` (with `ArrayBuffer` fallback when SAB unavailable).
- `js/src/typestream.js`: `weightedTypeStream(dict, opts)` and `roundRobinTypeStream(dict)`. The type stream is the seam where Phase 4's CFG-driven grammar plugs in.
- `js/src/encode.js`: `encode(input, output, dict, opts = {})`. Streaming in/out: reads payload bytes from a `ReadableStream<Uint8Array>`, wraps with SIZER, walks the per-type Huffman tree one bit at a time, and writes UTF-8 cover-text bytes to a `WritableStream<Uint8Array>`. Stops after the EOF marker plus a random-bits tail (no whole-payload buffering).
- `js/src/decode.js`: `decode(input, output, dict, opts = {})`. Streaming in/out: reads cover-text bytes from a `ReadableStream<Uint8Array>` through `TextDecoderStream`, tokenizes via the lexer, looks up each known word via `lookupWord`, writes its `(code, bits)` to a BitWriter, and drives the bytes through DESIZER to the output `WritableStream`. Unknown words and non-word tokens are silently skipped (matches OG scramble behavior).
- `js/src/grammar/parser.js`: recursive-descent parser for `.def` files. Token set: IDENT (with hyphens/digits/commas/+), `{...}` PUNCT, `@N` WEIGHT, `:`, `;`, `|`, `//` line comments. First rule = start symbol.
- `js/src/grammar/expand.js`: `loadGrammar(parsedTree)` packs to SAB; `makeModel(grammar, opts)` produces a sentence model (sequence of `{kind:'type'|'punct', ...}`); `modelStream(grammar, opts)` is the per-call wrapper. Recursive grammars are skip-and-retried past `maxLength` (default 1024).
- `js/src/grammar/format.js`: `createFormatter()` applies format-token semantics to a stream of words+puncts. Implements `Cap`, `CAPSLOCKON`, `capslockoff`, `^literal^`, char-by-char interpretation (`n`=newline, `e`=empty, ` `=conditional space, `(`=space-before, default=emit+set space).
- `js/src/grammar/expgram.js`: `emitMRules(dict, opts)` generates m-rules so portable grammars can reference abstract types (`mPERSON`, `mPLACE`).
- `js/src/modeltable.js`: `loadModelTable(json)` packs to SAB; `modelTableStream(table, opts)` drives random or sequential replay of sentence-model tables.
- `js/src/lexer.js`: see "Lexer" below.

**Format-token quick reference (for `.def` grammars):**
- `{Cap}`: cap next word (one-shot)
- `{CAPSLOCKON}` ... `{capslockoff}`: cap a run of words (matches sentmdl.h spelling)
- `{,}`: comma + auto-space
- `{. n}`: period + space + newline
- `{?}`, `{;}`, `{:}`: single punct + auto-space
- `{(...)}` starting with `(`: auto-space *before*, then emit
- `{^literal text^}`: verbatim, no interpretation, clears pending-space
- `{e}`: no-op

**One deliberate deviation from OG:** after a `{^literal^}` verbatim emit, the formatter clears the pending-space flag (the OG left it untouched). This makes the literal authoritative about its own spacing, write `{^ of ^}` and get exactly that, no double-spaces. The OG behavior produced awkward double spacing in normal use.

**Layers above the core (not enumerated above).** Added after the
worker/streaming refactor, documented in their own files:
- `js/src/worker/*` (`engine-worker.js`, `pool.js`, `spawn.js`,
  `resource-worker.js`, `build-session-worker.js`, `aug-worker.js`,
  `preclean-worker.js`, `jobs.js`, `parent-port.js`, `streams.js`):
  on-demand worker pool and job dispatch. See
  `docs/architecture-workers.md`.
- `js/src/resource-loader.js` (+ `resource-loader-client.js`,
  `sab.js`): single-source-of-truth fetch + gunzip + pack + cache for
  SAB resources across realms. See `docs/architecture-sab.md`.
- The streaming cover pipeline (`js/src/cover-pipeline.js`,
  `cover-streaming.js`, `cover-escape.js`, `cover-markers.js`,
  `stream.js`, `wrappers.js`): the post-processor stack that wraps /
  strips cover text as gzip / base64 / uuencode / html / pdf / eml /
  markdown envelopes.

## CLI surface

Node-only wrappers in `js/bin/`:

- `nicetext -d <dict> -i <in> [-g <grammar.def>] [-o <out>] [--seed=N] [--stream-seed=N] [--max-length=N]`
  - Without `-g`, falls back to the weighted-random type stream.
- `scramble -d <dict.json> -i <cover.txt> -o <output.bin>`

CLI calls `encode()` / `decode()` inline. No workers, a one-shot Node
process is itself the worker. See `docs/architecture-workers.md` §2.

## Lexer

`js/src/lexer.js` is shared between `listword` (corpus → WLIST), `scramble` (cover text → bits), and `genmodel` (sample text → sentence-model table). The exported `TOKEN` set (values are lowercase strings) is `WORD` (`'word'`), `PUNCT` (`'punct'`), `EOS` (`'eos'`), `WHITESPACE` (`'whitespace'`, non-single-space inter-word runs), `GUTENBERG_START` (`'gutenberg-start'`), `GUTENBERG_END` (`'gutenberg-end'`), and `GUTENBERG_END_LEGACY` (`'gutenberg-end-legacy'`, the 1990s "END THE SMALL PRINT!" marker). Longest-match-wins like lex; on ties the earlier pattern wins.

Known divergence from the OG lex: contractions use a permissive `'[A-Za-z]{0,2}` suffix instead of per-consonant constraints, because JS regex doesn't backtrack across CORE+SUFFIX boundaries the way lex's DFA does. Covers all real English contractions; no observed false matches in natural-language input.

## What collapsed away (don't port)

- `mtc++/mstring`, `mmstring`: replaced with `String` / `Uint8Array`
- `mtc++/list`, `strlst`: replaced with `Array`
- `mtc++/bst`, `rbt`, `balance`: replaced with `Map`
- `mtc++/heap`: replaced with `Array.sort` unless profiling demands otherwise
- `mtc++/initfile`: `.ini` reader, replaced with JSON
- `mtc++/errormsg`, `stdermsg`: `console.error` / `throw`
- `mtc++/MTC++.h`: umbrella header, no longer needed
- `mtc++/raof*`, `bst`, `rbt`, related: entire on-disk-format machinery
- `nttpd/`: uninteresting and obsolete (per developer, 2026-04-26)
- All RCS files, dev-only test harnesses (`bsttest`, `heaptest`, `inittest`, `listtest`, `rbttest`, `bitcp`, `numsize`, `raofmake`/`raofmalt`/`raofread`, `smush`)

The OO collapse and the "raof → Map → SAB" design journey are examined in detail in `docs/architecture-sab.md` (the authoritative home for that story).
