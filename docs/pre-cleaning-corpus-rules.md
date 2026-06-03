# Corpus Pre-Cleaning Rules

Standalone preprocessing pass over corpus text before `genmodel` and
`listword` (frequency counter) see it. Lives in `js/src/builder/`
as a single function callable by both. Runs every rule each
iteration, loops until the text is idempotent (no rule changes
anything). The loop is insurance against rules whose output triggers
another rule's condition, not strictly required for today's rules
but cheap and future-proof.

The framing is round-trip-first (see `docs/research-notes.md` §19):
every pre-clean decision is "if this shape COULD cause lexer
round-trip mismatch, drop or normalize it." Believability impact is
weighed but is always the tiebreaker, never the deciding factor.

## Rules (run in order, looped to fixed-point)

| # | Rule | Motivation | Impact on model | Action |
|---|---|---|---|---|
| 1 | Non-printable bytes → single space | Strips control / format / PUA / unassigned bytes. Supersedes earlier ideas of separate BOM-strip and ASCII-control rules. | Invisible | Replace any run of non-printable bytes with one U+0020 space |
| 2 | Curly quotes → straight ASCII | Smart `'`/`"` (U+2018/2019/201C/201D) don't match WORD_RE's apostrophe-suffix; words containing them split unpredictably | More believable: matches plain-ASCII prose; no beacon | Replace U+2018/2019 with `'`, U+201C/201D with `"` |
| 3 | NBSP / thin spaces → regular space | Non-breaking space and thin/figure spaces don't match the lexer's `\s` class; they become PUNCT_CATCHALL tokens | Invisible | Replace U+00A0, U+2009, U+200A, U+202F, U+205F, U+3000 with U+0020 |
| 4 | Em/en dashes → space | `—` (U+2014) and `–` (U+2013) become PUNCT_CATCHALL; high-signal typography that draws attention if it survives into cover | Slight believability loss for literary text; no beacon | Replace `—`/`–` with `<space>-<space>` or single space |
| 5 | Mixed-script → Latin via TR39 confusables | A word like `pаper` (Cyrillic `а`) splits at the script boundary in `WORD_RE`'s Latin-only `WORD_CHAR` class, breaking round-trip | More believable | Normalize using the Unicode TR39 `confusables.txt` table from `https://www.unicode.org/Public/security/latest/`. License: Unicode License v3 (permissive, attribute in `attribute.html`). |
| 6 | Stray ZWJ/ZWNJ outside emoji clusters | Earlier cleanup steps may shift adjacency around a ZWJ. Orphan ZWJ between Latin chars fragments the WORD via PUNCT_CATCHALL | Invisible | Strip U+200D and U+200C when not flanked by emoji building blocks |
| 7 | Long period-EXT chains | `WORD_RE`'s period-EXT can absorb `a.b.c.d.e.f.g` as one bit-bearing 1-of-1 WORD that beacons in cover | More believable: rare in real prose | Inner-split (`1.2.3` → `1 2 3`) |

## Status

All seven rules are implemented in
`js/src/builder/precleanCorpus.js` and called from
`js/src/builder/genmodel.js` and `js/src/builder/listword.js`.

Rule 5 uses a filtered subset of Unicode TR39 v15.1.0
`confusables.txt`. The raw table is fetched (by
`fixture-src/confusables/fetch.js`) into the gitignored
`fixture-src/confusables/raw/`; `tools/build-confusables-map.js` reads
it offline and emits `fixture-src/confusables/cooked/confusables-data.js`
(committed) as a `Map<sourceCodePoint, latinReplacement>`, which
`build-all-fixtures.js` copies to `fixtures/confusables-data.js` (the
path `precleanCorpus.js` imports). The filter keeps only
entries whose SOURCE is in a real non-Latin script (Cyrillic, Greek,
Cherokee, Armenian, &c., never Script=Common or Script=Inherited)
and whose TARGET is entirely WORD_CHAR. Common-script confusables
like `|` → `l` and `×` → `x` are deliberately excluded because
pipes / multiplication signs / similar punctuation carry intentional
meaning in plain text; folding them would merge tokens. Generated
map: 520 entries.

Rule 7's heuristic, fire only on 3+ pure-digit segments
(`/(?<![\w.])\d+(?:\.\d+){2,}(?![\w.])/`), was chosen for
conservatism. Acronyms (`U.S.A.`), abbreviations (`e.g.`),
domains (`www.example.com`), and version strings (`version.1.2.3`)
all share the period-EXT lex shape but stay intact. IPs
(`192.168.1.1`) do split; intentional per the round-trip-over-
believability framing.

To bump the Unicode version: edit `VERSION` in
`fixture-src/confusables/fetch.js`, run it to pull the new release into
`raw/`, then re-run `node tools/build-confusables-map.js` (it rebuilds
`cooked/` because `raw/` is now newer) and commit the regenerated
`cooked/confusables-data.js`. Update the attribution version string in
`attributions.html`.

## Considered and dropped

**Long punctuation runs.** Considered collapsing `!!!!!!!!!!!!!!`,
`**********`, `==========`, etc. The lexer's `EOS_RE` has no length
cap, so they round-trip cleanly as one EOS token; the rule would
only have saved model-literal size and made covers slightly less
stylized. Aesthetic-only gains don't clear the round-trip-only bar.

**Long tokens / long sentences.** The lexer already caps tokens at
`maxWordLength`; sentences run until natural EOS. Adding a parallel
cap in pre-clean creates an asymmetric surface (two caps to keep in
sync). The over-cap silent-skip behavior was fixed in the lexer
itself (see `git log` for `lexer.js` truncate-instead-of-skip).

**Apostrophe-suffix and leading-apostrophe handling.** Earlier
`WORD_RE` caps that fragmented `'tis` / `y'all'd've` /
`shouldn't've` were fixed in the lexer itself (apostrophe-suffix
unbounded, leading `'` allowed when followed by Latin). Pre-clean
deliberately doesn't try to know about lexer caps.

## Loop and idempotence

`precleanCorpus` applies every rule once per pass and re-runs the
full set until a pass produces no change (`text === prev` exits
the loop). JS string `===` on the largest corpus we ship (Shakespeare
~5.4 MiB) is a single C++-level memcmp, cheaper than any
per-rule short-circuit check. Build-time only, never on the
encode/decode hot path. Expected pass count for the current
rules: 2 (one productive pass plus one confirming pass).

## Callers

- `js/src/builder/genmodel.js`: wraps its `text` input in
  `precleanCorpus()` before calling `tokenize`.
- `js/src/builder/listword.js` (frequency counter): same wrap, so
  word counts come from the same byte stream genmodel sees.
- `js/src/builder/preclean-async.js`: browser-only wrapper that
  forwards the call to `js/src/worker/preclean-worker.js` so the
  UI thread stays responsive on multi-MB corpora (including binary
  files loaded into the BYOS Custom Corpus textarea). Worker posts
  one `progress` message per rule completion (`{ pass, ruleIndex,
  ruleCount, chars }`); the main thread surfaces this in the
  "Cleaning Corpus" modal. `precleanCorpusAsync(text, { signal,
  onProgress })` honours the modal's `AbortSignal`, on cancel the
  worker is terminated and the next call respawns it.

If a third corpus-consuming module appears, it MUST call
`precleanCorpus()` too. The invariant is "every place that
tokenizes corpus text sees the same precleaned bytes."

Today this means each corpus is pre-cleaned twice during a build
(once in `genmodel`, once in `listword`). The function is pure and
fast; if that overhead ever shows up in build profiles, memoize
upstream at the corpus-load layer rather than relaxing the
invariant.
