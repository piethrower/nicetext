# Command-Line Reference

The CLIs in the repo, what they do, and how to drive them. This is a
reference, not a tutorial. It covers the user-facing transforms,
builders, and tooling; a handful of single-purpose internal build
scripts under `tools/` are listed by name at the end rather than
documented flag-by-flag.

## What Node is for here

Node runs the same JavaScript engine the browser runs, from the
command line. We use it as a runtime for the encode/decode engine, the
dictionary/model builders, and the test suite. We do **not** use Node
as a web server, a bundler, a transpiler, or a package manager.

The repo has one HTTP server, `tools/serve.sh`, and it is **python3**.
See "Dev server" at the bottom of this file.

### Requirements

- Node ≥ 20 (for native `node:test`, fetch, web streams, and
  `Uint8Array` / `TextEncoder`).
- Zero install. `package.json` carries no dependencies, and never
  will. Everything the CLIs use is either a Node built-in (`node:fs`,
  `node:stream`, `node:zlib`, `node:test`, `node:worker_threads`) or
  a web-platform built-in available in modern Node.

### Conventions

- Run from the repo root. Paths in this doc are repo-relative.
- Long flags accept `--name=value` or `--name value`; short flags use
  `-x value`.
- Most CLIs default to stdout; pass `-o` / `--out` to write a file.
- Exit code 0 on success, non-zero on user error or engine failure.

## The two transforms

These are the round-trip CLIs. Same engine as the browser UI, same
dictionaries, same model tables.

### `js/bin/nicetext.js`, encode (bits → cover text)

```
node js/bin/nicetext.js -d <dict.json> -i <input> [options]
```

Required:

- `-d`, `--dict`: dictionary JSON (built by gendict or one of the
  fixture builders below). `.json` and `.json.gz` both work; the
  shared resource-loader gunzips transparently.
- `-i`, `--in`: input file (any bytes).

Optional:

- `-g`, `--grammar`: CFG grammar file (`.def`). Without `-g`, falls
  back to a weighted random type stream.
- `-o`, `--out`: output file (default: stdout).
- `--seed=N`: PRNG seed for SIZER's random tail (default `0xC0FFEE`).
- `--stream-seed=N`: PRNG seed for the grammar/type stream
  (default `0xBEEF`).
- `--max-length=N`: skip & retry sentence models longer than N
  (default 1024).
- `--no-validate`: skip the round-trip self-check. **Default is on**:
  the encoder runs the cover through a concurrent decoder and aborts
  if recovered bytes don't fingerprint-match the source. Disable only
  for benchmarks.

Example:

```
node js/bin/nicetext.js \
  -d fixtures/aesop.dict.json \
  -i secret.bin \
  -o cover.txt
```

### `js/bin/scramble.js`, decode (cover text → bytes)

```
node js/bin/scramble.js -d <dict.json> -i <cover.txt> -o <out.bin>
```

All three flags are required. The dict must be the same one the
encoder used. Example:

```
node js/bin/scramble.js \
  -d fixtures/aesop.dict.json \
  -i cover.txt \
  -o recovered.bin
```

## Cover post-processor (wrap / unwrap)

Standalone transforms that sit OUTSIDE the encode/decode core. Wrap
text covers in a user-chosen envelope + format-layer stack for
sharing; auto-strip incoming wrapped artifacts before decode.

### `js/bin/cover-wrap.js`, escape + apply stack on stdin

```
node js/bin/cover-wrap.js [--layers=<csv>] [--filename=<name>] [--subject=<text>] [-i <input>] [-o <output>]
```

- `--layers`: comma-separated layer types applied in order. Empty (or
  omitted) emits the cover unchanged after escape. The full set:
    - **Formats** (compress / encode): `base64` (Linux-compatible bare
      form, `base64(1)` decodes it directly), `gzip`, `uuencode`.
    - **Document envelopes**: `eml`, `html`, `html-active`,
      `markdown`, `nroff`, `pdf`, `xml`.
    - **Program envelopes** (functional source files; recipient runs
      with the language's interpreter or compiler and gets the cover
      to stdout): `bash`, `cpp`, `go`, `java`, `javascript` (Node),
      `perl`, `php`, `python`, `ruby`.
- `--filename`: base filename embedded in format-layer metadata
  (gzip FNAME, uuencode begin line) and used by envelopes that
  reference a filename. Each layer appends its own extension. Default:
  `message`.
- `--subject`: subject embedded in envelope content (`<title>`/`<h1>`
  in HTML, `Subject:` in EML, `/Title` in PDF, etc.). Default: `Note`.
- `--no-escape`: skip the escape pass. Use only when you control both
  ends and know the cover never contains wrapper-marker lines.

Example: pipe a cover through HTML envelope + gzip:

```
cat cover.txt | node js/bin/cover-wrap.js --layers=html,gzip --filename=note --subject="My Note" > note.html.gz
```

### `js/bin/cover-unwrap.js`, auto-strip on stdin

```
node js/bin/cover-unwrap.js [--max-iterations=N] [-i <input>] [-o <output>]
```

Iteratively detects the wrapper at the head of the stream, pipes
through the matching strip transform, and repeats until no known
prefix matches. Terminates with the bare cover. `--max-iterations`
caps the loop (default 10; UI stack depth caps at 5 so 10 is
comfortable headroom).

Example: round-trip the wrap from above:

```
cat note.html.gz | node js/bin/cover-unwrap.js > cover.txt
```

## Dictionary builder

### `js/bin/gendict.js`

General-purpose builder. Five subcommands; each one is a stage of the
full build pipeline. `build` runs the whole pipeline in one shot.

```
node js/bin/gendict.js <subcommand> [args]
```

- `listword [--counts] <text-file>`: tokenize a text file and print
  one unique word per line. With `--counts`, print `count\tword`,
  highest count first.
- `txt2dct <type=file> [<type=file>...]`: read one word-list file per
  type, emit a TWLIST (`type\tword` per line) on stdout.
- `sortdct <twlist-file>`: sort a TWLIST and merge duplicate words
  (one word, one type) into an MTWLIST, emitted on stdout. Preserves
  the "one word, one Huffman code" invariant.
- `dct2mstr [--name=NAME] <mtwlist-file>`: emit the final dictionary
  JSON on stdout.
- `build --name=NAME --out=FILE <type=file> [<type=file>...]`: the
  whole pipeline in one call: txt2dct → sortdct → dct2mstr, written
  to `--out`. Prints a one-line stats summary to stderr.

Example (full build):

```
node js/bin/gendict.js build \
  --name=demo --out=demo.dict.json \
  noun=words/nouns.txt verb=words/verbs.txt
```

## Fixture builders (`tools/`)

These read byos.json card specs from `tools/byos/` and emit gzipped
fixtures under `fixtures/`. See `docs/builders.md` for the byos.json
schema and `docs/fixture-src.md` for the corpora layout.

### `tools/build-all-fixtures.js`

```
node tools/build-all-fixtures.js
```

One-shot rebuild of every fixture, driven by all
`tools/byos/*.byos.json`. Emits `fixtures/cards.json` first so per-
card builds can resolve their canonical id, then every per-card dict
and model table. No args; idempotent.

### `tools/build-base-dict.js`

```
node tools/build-base-dict.js <byos.json>
```

Build one flat-style dictionary from a single byos.json (any byos
with `story.style='flat'`, i.e., no story layer). Writes the native
intermediate `fixtures/{byos-id}.dict.json.gz`, where `{byos-id}` is
the canonical BYOS id from `getBYOSID()` (the nickname-rev form, e.g.
`master-1`, for registry-matched cards). This native is **transient**:
`tools/sab.js pack dict` compiles it to the shipped runtime fixture
`fixtures/{byos-id}.dict.sab.gz` and then deletes the native. The
`.sab.gz` is the artifact the engine loads.

### `tools/build-corpus-dict.js`

```
node tools/build-corpus-dict.js <corpus-byos.json>
```

Build a corpus-bound dictionary: vocabulary is restricted to words
that actually appear in the byos's referenced corpus. Writes the
native intermediate `fixtures/{byos-id}.dict.json.gz`, where
`{byos-id}` is the canonical BYOS id from `getBYOSID()` (the
nickname-rev form, e.g. `aesop-1`, for registry-matched cards). This
native is **transient**: `tools/sab.js pack dict` compiles it to the
shipped runtime fixture `fixtures/{byos-id}.dict.sab.gz` and then
deletes the native. The `.sab.gz` is the artifact the engine loads.

### `tools/build-model-table.js`

```
node tools/build-model-table.js <corpus-byos.json>
```

Build the sentence-model table for a corpus byos. The dedupe flag
comes from `byos.story.sentence` (`'random'` → dedupe;
`'sequential'` → preserve source order). Reads the native dict
intermediate and writes the native model intermediate
`fixtures/{byos-id}.model.json.gz`, where `{byos-id}` is the
canonical BYOS id from `getBYOSID()` (e.g. `aesop-1`). This native is
**transient**: `tools/sab.js pack model` compiles it to the shipped
runtime fixture `fixtures/{byos-id}.model.sab.gz` and then deletes the
native. The `.sab.gz` is the artifact the engine loads.

### `tools/build-twlist-fixtures.js`

```
node tools/build-twlist-fixtures.js
```

Sweep `fixture-src/twlist/` and emit per-source TWLIST fixtures under
`fixtures/*.twlist.tsv.gz` for the session-base-dictionary feature.
No args.

### `tools/build-freq-fixtures.js`

```
node tools/build-freq-fixtures.js                # all sources
node tools/build-freq-fixtures.js norvig         # one source
node tools/build-freq-fixtures.js norvig google
```

Read raw frequency sources from `fixture-src/freq/<source>/raw/`,
cook them (prune to the vocab union of the current dict + wlist
fixtures) into the committed cache
`fixture-src/freq/<source>/cooked/<source>.freq.tsv.gz`, then pack
that cooked TSV into the runtime SAB fixture
`fixtures/<source>.freq.sab.gz` (the shipped artifact; not a `.tsv`).
Mtime-driven caching skips each step when its target is current.
Sources skip silently when both their raw input and cooked cache are
missing.

The `gutenberg` source tokenizes ~37 K books and exhausts Node's
default V8 heap. Run it (or "all") with `--max-old-space-size`:

```
node --max-old-space-size=8192 tools/build-freq-fixtures.js gutenberg
node --max-old-space-size=8192 tools/build-freq-fixtures.js
```

`norvig` and `google` fit in the default heap. The orchestrator
(`tools/build-all-fixtures.js`) passes the flag through automatically;
ad-hoc CLI runs must supply it.

### `tools/build-confusables-map.js`

```
node tools/build-confusables-map.js
```

Regenerate `fixture-src/confusables/cooked/confusables-data.js` from
`fixture-src/confusables/raw/confusables.txt`. No-op unless `raw/`
(gitignored, fetched by `fixture-src/confusables/fetch.js`) is newer
than the committed `cooked/`, so it only does work after a Unicode
version bump. `build-all-fixtures.js` copies the cooked artifact to
`fixtures/confusables-data.js`. Output is committed and marked
do-not-hand-edit.

### `tools/build-font.js`

```
node tools/build-font.js
```

Promote a refreshed font from `fixture-src/font/raw/` to
`fixture-src/font/cooked/`. No-op unless `raw/` (gitignored, placed by
hand per `fixture-src/font/fetch.js`) is newer than the committed
`cooked/`, so it only does work after a manual font refresh. A font
isn't transformed, so this is a verbatim copy. `build-all-fixtures.js`
copies the cooked font to `fixtures/font/`.

### `tools/sab.js` (native ↔ SAB pack/unpack)

```
node tools/sab.js pack <type>       # native → fixtures/<id>.<type>.sab.gz
node tools/sab.js unpack <type>     # fixtures/<id>.<type>.sab.gz → native
```

The native-to-SAB compiler the whole fixture pipeline depends on.
Every per-card dict/model builder, the twlist/wlist/freq builders, and
the emoji-cldr builder emit a **native** intermediate (gzipped JSON,
TSV, or text); `sab.js pack <type>` enumerates those natives, packs
each into its runtime SharedArrayBuffer fixture
(`fixtures/<id>.<type>.sab.gz`), and then deletes the native. `unpack`
reverses it for inspection. `<type>` is one of: `twlist`, `dict`,
`model`, `freq`, `emoji-cldr`, `emoji-keywords`. `build-all-fixtures.js`
runs the pack passes as its final stage, so a full build leaves only
SAB fixtures in `fixtures/`.

### Other `tools/` build CLIs

These are runnable (`#!/usr/bin/env node`, each with a usage/purpose
header) but single-purpose enough that they are driven by
`build-all-fixtures.js` or run by hand only during a corpus / wordlist
refresh. Read each file's header comment for specifics.

- `tools/build-corpus-wlist.js`: derive per-corpus `.wlist` natives
  from the shipped corpus texts (one per unique corpus a card
  references); packed to `fixtures/<stem>.wlist.sab.gz`.
- `tools/build-twlist-wlist.js`: derive per-twlist-source `.wlist`
  natives from the shipped `.twlist` sources (drops the type column);
  packed to `fixtures/<name>.wlist.sab.gz`.
- `tools/build-master-wlist.js`: union every word-bearing source in the
  repo into `fixture-src/wlist/master.wlist.gz`, the input pool for the
  impkimmo2026 rebuild.
- `tools/build-englex-wlist.js`: enumerate every surface form ENGLEX +
  PC-KIMMO can generate into `fixture-src/wlist/englex.wlist.gz` (an
  additional input to `build-master-wlist.js`). Requires an
  out-of-repo PC-KIMMO install.
- `tools/build-redacted-wlist.js`: concatenate the redacted-wlist
  sources into the native `fixtures/redacted.wlist.txt.gz`; packed to
  `fixtures/redacted.wlist.sab.gz`.
- `tools/build-monotyped-models.js`: per-corpus monotyped-model
  precompute for Eve; emits `fixtures/<corpus>.monotyped-model.sab.gz`.
- `tools/build-rewriter-fixtures.js`: production build for the
  cover-transforms rewriter fixtures (twlist + data SABs per rewriter).
- `tools/run-impkimmo2026.js [--shards N]`: rebuild
  `impkimmo2026.twlist.gz` and its four variant twlists from
  `master.wlist.gz`, sharding the recognize pass. Requires the
  out-of-repo PC-KIMMO + ENGLEX install.

### Internal helpers (not standalone CLIs)

`tools/byos-build-helpers.js` and `tools/load-corpus.js` are imported
by the builders above and have no shebang or argv handling of their
own.

## Tests

### Full Node suite

```
node --test 'tests/node/**/*.test.js'
```

Runs every `*.test.js` under `tests/node/` (recursively, including
subdirectories), each in its own process. Returns in seconds. No
setup, no install. This is the first thing to run after touching
engine code. Quote the glob so the shell passes it through to Node.

(Note: the bare-directory form `node --test tests/node/` does NOT
work on current Node, it tries to resolve the directory as a module.
The manifest-driven `node tests/node/run-node.mjs` runs the same
files in a single shared process and is what the browser test page
mirrors, but it can hang on the worker-spawn tests in that shared
process, so the per-file glob above is the canonical Node command.)

### Single test file

```
node --test tests/node/encode-validate.test.js
```

### Stress runner

```
node tests/node/stress/run.mjs                              # default: snip-mode, 1 MB synthetic corpus
node tests/node/stress/run.mjs --max-size=65536 --reps=3
node tests/node/stress/run.mjs --corpus-file=/path/to/file.deb
node tests/node/stress/run.mjs --corpus-mode=random --corpus-bytes=4194304
node tests/node/stress/run.mjs --sweeps=1
node tests/node/stress/run.mjs --duration=10m
```

Continuous encode/decode sweeps in three corpus modes:

- `snip` (default): synthesize the corpus from random byte ranges
  of fixtures (gzipped and inflated). Realistic mix of binary noise,
  prose, dict JSON, and tsv.
- `random`: pure mulberry32 random bytes; stresses thin-model paths.
- `--corpus-file=PATH`: load any real file (a `.deb`, ELF, photo,
  etc.) and sweep against it. Reproduces real BYOD failures.

`--sweeps` and `--duration` combine: whichever bound trips first
wins. Failures dump to `tmp/stress-failure-<timestamp>-<size>-<rep>/`
with forensics (source bytes, cover, decoded output, dict, model).

### Browser test pages

The Node suite covers the engine. Browser-only plumbing (Service
Worker, real `crypto.subtle`, real `Blob`, SAB shape under COOP/COEP)
has its own HTML pages, served via the dev server:

- `http://localhost:8888/tests/node/test-suite.html`: runs the same
  `tests/node/*.test.js` files in-browser via shims.
- `http://localhost:8888/tests/node/stress-test.html`: browser-side
  stress mode.

Per the rules of engagement: Node smoke first, browser page second,
full UI integration last.

## Dev server (python3, not Node)

### `tools/serve.sh [PORT]`

```
tools/serve.sh           # default port 8888
tools/serve.sh 9000
```

Local HTTP server for the browser UI. Defers to `tools/serve.py`,
which is `python3` `http.server` with three response headers set:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

These enable cross-origin isolation, which makes
`new SharedArrayBuffer(n)` work in the page. Without them the engine
silently falls back to per-worker ArrayBuffer copies and the SAB-
only browser test skips.

Browse `http://localhost:8888/nicetext.html` after starting.

This is the only HTTP server in the repo. Node is not used as one.

## Throwaway probes

Throwaway test scripts live in two places, both git-tracked and fine
to commit:

- `tmp/probe-*.mjs`: Playwright-driven browser harnesses (open a
  page, drive the UI, assert outcomes).
- `tests/node/tmp/`: Node-level scratch (one-off `.test.js` or
  `.mjs` that import directly from `../../src/...`).

Run with bare `node`:

```
node tmp/probe-foo.mjs
node --test tests/node/tmp/check-foo.test.js
```

Default is "keep, then prune", these double as a knowledge archive
future sessions can mine.
