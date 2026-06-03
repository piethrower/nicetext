# a/an agreement: CMU-driven research

Companion to the vowel-augmentation rethink in `whats-new.html` §6. The
rethink proposes dropping the `begins_with_a_vowel` augmentation
(touches ~14K dict entries to enforce a/an agreement structurally) in
favor of a one-token encoder lookahead gated by an `agreement: "a-an"`
byos flag. This note documents the three-phase analysis that picked
the encoder rule and the supporting build artifacts.

## Resources

- **CMU Pronouncing Dictionary** (`fixture-src/pron/cmu/cmudict.dict.gz`,
  ~135K ARPABET pronunciations): BSD 2-clause, redistributed with
  `fixture-src/pron/cmu/LICENSE`. Refreshable via
  `fixture-src/pron/cmu/fetch.js`. Single source of truth for word-onset
  phonology; will also feed planned alliteration / syllable-count /
  rhyme-refresh twlists.
- **Norvig unigram counts** (`fixtures/norvig.freq.tsv.gz`, ~99K
  vocab-intersected subset): used for frequency tiering of the
  exception sets.
- **18 shipped corpora** (`fixtures/*.txt.gz`).
- **Local Project Gutenberg sample** (`fixture-src/freq/gutenberg/raw/`,
  ~60K English books, gitignored).

## Tools

All under `fixture-src/rewriters/xanax/`, zero-dep, Node built-ins
only. (Originally lived in `tools/aan-*`; moved into the xanax
rewriter source dir as part of the cover-transforms arc.)

- `lib.js`: shared primitives.
  - `scanArticles(text)`: walks text yielding `{article, nextWord,
    startIdx, endIdx}` for every standalone "a"/"an".
  - `classifyByLetter(nextWord)`: 'vowel' | 'h' | 'consonant' |
    'nonletter'.
  - `classifyByPhoneme(arpabet)`: 'vowel-onset' | 'consonant-onset'.
  - `VOWEL_PHONEMES` (Set of 15 ARPABET vowels).
  - `loadCmuMap(path)`: returns `Map<lowercased-word, first-phoneme-no-stress>`.
  - `makeSnippet(text, startIdx, endIdx)`: human-readable context.
- `inspect.js`: original orthographic next-letter-class measurement
  (stdin -> JSON). Unchanged across the arc; smoke-tested against
  aesop.txt.
- `derive-exceptions.js`: Phase 1 classifier. Produces exception
  sets, frequency tiers, and coverage curves from CMU + Norvig.
- `corpus-sweep.js`: Phase 2 + 3 corpus comparison. Seedable
  Gutenberg sampler, three-rule scoring, coverage-gap categorization,
  fallback-accuracy measurement.

Reports under `tmp/`:
- `tmp/xanax-derive-exceptions-report.json` + four
  `tmp/xanax-derive-exceptions-{strict,liberal}-{a,an}.tsv`
- `corpus-sweep.js` writes `tmp/xanax-corpus-sweep-{report.json,
  disagreements.tsv, missing.tsv}` on each run; not committed.

## Methodology

Three candidate rules:

1. **strict_ortho**: 'an' if next word starts with [aeiou], else 'a'.
2. **liberal_ortho**: 'an' if next word starts with [aeiouh], else 'a'.
3. **cmu_phonology**: 'an' if next word's first CMU phoneme is in
   `{AA, AE, AH, AO, AW, AY, EH, ER, EY, IH, IY, OW, OY, UH, UW}`,
   else 'a'. Falls back to `strict_ortho` when the next word isn't in
   CMU.

ARPABET note: HH (the H sound), W, and Y are consonants, which is why
"a happy" (HH), "a one" (W), "a united" (Y), and "an hour" (silent h,
AW onset) are all the correct natural-English forms.

**Phase 1** (`derive-exceptions.js`): classify every CMU word's first phoneme.
Surface the words where orthography and phonology disagree. Tier by
Norvig rank. Two orthographic variants reported (strict, liberal) to
bound the impact of either policy.

**Phase 2** (`corpus-sweep.js` over 18 fixtures + 50 random
Gutenberg books, seed=1, 128,113 article occurrences after artifact
filtering): score each rule against the author's actual choice.

Two artifact filters applied in the sweep (not in `inspect.js`,
which keeps its previously-blessed smoke numbers):

1. **Uppercase "A." is an initial, not an article.** "A. M. Smith"
   matches as article + letter; CMU correctly knows M (em) is
   vowel-onset, but the surface "A" is a first-name initial. Skip
   when `text[startIdx] === 'A' && text[startIdx+1] === '.'`.
2. **Intervening non-whitespace.** "a 30 H.P. motor": the article
   agrees with the spoken "thirty," not the letter we'd capture next.
   Skip when the gap between the article and the next letter-word
   contains any non-whitespace character.

**Phase 3** (same tool, `coverageGap` section): categorize CMU misses
(`proper-noun` if capitalized in source >=70% of the time, `plain`,
`non-ascii`, `has-digit`, `hyphen`) and measure how often
`strict_ortho` fallback agrees with the author on the missing set.

## Findings

### 1. CMU phonology is empirically the right rule.

Author-disagreement rates across the 128K-article sweep:

| Rule          | Disagrees with author |
| ------------- | --------------------: |
| liberal_ortho |                 4.32% |
| strict_ortho  |                 1.01% |
| cmu_phonology |             **0.25%** |

CMU is roughly 3x more author-faithful than the best orthographic rule.
When CMU and `strict_ortho` predict different articles (1,258 tied
cases across the sweep), the author chose CMU's prediction **89% of
the time** overall: 93.5% within modern fixtures, 85% within Gutenberg.
This is direct empirical proof that real writers use phonology, not
orthography. Without this finding, the rest of the work is unmotivated.

### 2. The encoder design is settled, and simpler than expected.

1. Look up next word in the build-time-derived exception wlists. Hit
   in `an-exceptions` -> emit "an". Hit in `a-exceptions` -> emit
   "a". Hit in neither -> step 2.
2. Apply `strict_ortho` fallback: leading [aeiou] -> "an", else "a".

Combined effective accuracy is **99.74%** vs the 98.99% strict-only
baseline. No initialism letter-name table, no phoneme-onset
supplement, no special handling for digits or hyphenated tokens. The
encoder pass is two lookups and a string swap.

**Build-time vs runtime.** CMU is a build-time-only resource. The
encoder does **not** load the 135K-entry CMU dict at runtime; it loads
the small precomputed exception artifacts via the primary session's
standardized `loadResource(type:'wlist', id:'an-exceptions')` API (or,
at the size, simply bakes the exception sets into the encoder source as
JS constants). Reasoning is in
`memory/feedback_small_lists_beat_runtime_dict_scans.md` and reinforced
by `memory/feedback_type_blind_tenet.md`: even if the build pipeline
materializes a "cmu-phoneme-class" twlist as an intermediate, type
strings are opaque at runtime, so the deliverable must be a flat
enumeration of the exception words.

### 3. The liberal "h -> an" rule is unsalvageably wrong.

Of CMU's 6,103 h-leading words, only **74 (1.2%)** are vowel-onset
(silent h: hour, honest, honor, heir, herb, ...). The other **6,029
(98.8%)** are consonant-onset (happy, historic, hospital, hand, ...).
Any rule that classes h-words with vowels for article purposes is
wrong essentially always. The strict rule (no h-bucket) is much closer
to truth; the right answer for h-words is per-word phonology, which is
exactly what CMU provides.

Useful as a rule-OUT finding: it eliminates a tempting wrong path that
future contributors might otherwise re-propose.

### 4. The exception sets derived from CMU are small.

| Rule variant  | an-exceptions | a-exceptions |
| ------------- | ------------: | -----------: |
| strict_ortho  |           463 |          226 |
| liberal_ortho |         6,492 |          152 |

The strict-orthography exception lists are the ones the encoder rule
would use (the liberal-rule numbers confirm Finding 3: 6,492
an-exceptions is unworkable).

Coverage curves over occurrence-weighted exception volume:

- Strict an-exceptions: top 25 cover 91.05%, top 50 cover 97.30%, top
  100 cover 99.42%, full 463 cover 100%.
- Strict a-exceptions: top 25 cover 94.63%, top 50 cover 99.13%, top
  100 cover 100%.

**Truncation strategy is an open decision.** The data shows the full
lists are small enough to ship in full, and aggressive truncation
(top-25) would still capture the bulk of the wins. The choice between
ship-all vs ship-top-N depends on what the wlist artifact size cost
turns out to be; both are tractable.

### 5. CMU coverage is 96.88%; the gap is archaic vocabulary the orthographic fallback already handles.

Of 128,113 next-word slots, CMU has an entry for **124,109 (96.88%)**.
The 3.12% miss (3,996 occurrences, 2,200 unique words) breaks down as:

- **1,881 plain** (archaic English): tolerably, assagai, kraal,
  leathern, cuckold, twelvemonth, harpooneer, savoury, simpleton, ...
- **290 proper-noun-ish** (mostly 19th-c British colonial-era
  ethnographic terms from old PG texts): kaffir, hottentot, bosjesman,
  bechuana, damara, ...
- **29 non-ASCII**: hyaena, canon, dor, mpongwe, daemon (with accents).
- **0 has-digit, 0 hyphen**: those slots are eliminated by the Phase 2
  filters or by the scanner's `\p{L}+` next-word capture stopping at
  the hyphen.

On the miss set, `strict_ortho` fallback agrees with the author
**99.37%** of the time, with all four populated categories above 99%.
Reframed for the wlist design: the words CMU lacks are overwhelmingly
consonant-onset words orthography handles correctly, so they don't
need to appear in the exception wlists in the first place. The gap is
self-handling.

### 6. The wins concentrate on a handful of high-frequency words.

Of the 1,258 cases across the sweep where CMU and strict-ortho
disagreed and the author broke the tie, the per-word distribution is
extremely top-heavy. CMU's wins are dominated by:

- `hour` (132x), `one` (26x), `honest` (13x), `union` (8x), `useful`
  (6x), `universal` (6x), `united` (6x), `uniform` (6x), `european`
  (6x), `honourable` (4x), `honor` (4x), `herb` (4x).

Two patterns: silent-h (hour, honest, honor, herb, honourable) and
Y-onset U/E words (one is W-onset; useful, universal, united, uniform
are Y; european is Y). This dozen of words accounts for most of CMU's
empirical value-add. Any truncation strategy that keeps the top dozen
captures the bulk of the benefit.

### 7. Per-corpus variance: most styles overwhelmingly favor CMU; a few 19th-c authors split.

Per-fixture CMU-win share when the two rules disagree (Phase 2 totals):

| Corpus               | Disagreements | CMU wins |
| -------------------- | ------------: | -------: |
| shakespeare          |           271 |    94.8% |
| walden               |            41 |   100.0% |
| huck-finn            |            37 |    97.3% |
| tale-of-two-cities   |            37 |    75.7% |
| claude-tasting       |            33 |    93.9% |
| sherlock-holmes      |            31 |   100.0% |
| pride-and-prejudice  |            30 |    90.0% |
| moby-dick            |            23 |    82.6% |
| origin-of-species    |            12 |    75.0% |
| (others, all <= 17)  |               |  91-100% |

Modern Claude-authored fixtures, Shakespeare, Walden, Sherlock Holmes,
War of the Worlds, Wizard of Oz, JFK: 90-100% CMU-wins. The genuine
outliers are Dickens (Tale of Two Cities), Melville (Moby Dick), and
Darwin (Origin of Species) at 75-83%; three mid-19th-c authors who
wrote "an european," "an union," "an honest" with audible h, following
the orthographic conventions of their era.

Useful as a byos surface hint, not a blocker: the `agreement: "a-an"`
flag defaults ON for almost every card (CMU wins 90-100% in modern
voices), and the few deliberately-archaic cards (Dickens, Melville,
Darwin) could opt out to preserve period voice. Or leave it on
universally: even on those outliers, CMU is wrong only ~25% of the
disagreement cases, which themselves are a small fraction of 1% of all
article occurrences.

### 8. Tokenization caveats worth knowing for sibling work.

The naive "find `\b(a|an)\b` and look at the next letter-run" scan
produces false positives that an a/an analyzer (or anything else
parsing article-context) must anticipate. The two filters above are
mandatory; two more are worth noting:

3. **Hyphens silently truncate the "next word."** `\p{L}+` stops at
   the hyphen, so "self-conscious" becomes just "self". For a/an this
   doesn't matter (the article agrees with the leading part), but
   sibling tools that need the full token (rhyme, syllable-count)
   will trip on this.
4. **Compass-letter abbreviations as words.** "in a N. and S.
   direction" matches as "a N" but the author spoke "north." Not
   filtered in the sweep (rule is fuzzy: "an N-shaped" is legitimate).
   Live with residual noise.

The planned alliteration / syllable / rhyme-refresh tooling should
import `fixture-src/rewriters/xanax/lib.js` and apply filters 1 and
2 at scan time.

## Encoder design recommendation

Implementation order when picked up (after the primary session's SAB
arc clears):

1. **Builder coupling.** `derive-exceptions.js` (invoked by
   `tools/build-rewriter-fixtures.js`) produces two wlist artifacts:
   `fixture-src/wlist/an-exceptions.wlist.*` and `a-exceptions.wlist.*`,
   using the strict-ortho exception sets from Phase 1. Truncation
   strategy: open decision (see Finding 4); start with ship-all (689
   total entries combined) and revisit if SAB size matters.
2. **byos schema field.** Add `agreement: "a-an"` (boolean / enum)
   to the byos.json schema. Builder couples flag value to wlist
   inclusion: when on, dict-build pipeline references the exception
   wlists; when off, encoder skips the lookahead.
3. **Encoder lookahead pass.** When the encoder is about to emit "a"
   or "an", peek at the next token. If next-token is in the
   an-exceptions wlist -> emit "an". If in a-exceptions -> emit "a".
   Otherwise apply strict-ortho on the leading letter. Round-trip is
   preserved because the decoder is dict-only: it looks up the
   surface word, gets zero bits, contributes nothing to the recovered
   bit stream (the two articles end up as singleton-tagged 0-bit dict
   entries via the `agreementavsan.twlist` plumbing in the `whats-new`
   §6 design).
4. **Per-card flag audit.** Run `fixture-src/rewriters/xanax/inspect.js`
   (or the sweep) against
   each shipped corpus to confirm the default-on choice per card. Tag
   the three 19th-c outliers (Dickens, Melville, Darwin) explicitly if
   they ship as standalone cards.

## Open decisions

- **Truncation strategy** for the exception wlists. Ship-all (689
  entries) vs top-N (e.g. 50 = ~95% coverage). Depends on SAB cost.
- **Per-card byos default.** Default-on universally vs default-on with
  explicit opt-out for archaic-style cards.
- **Agreement-aware-style mode**: future option to use the exception
  wlists in reverse to deliberately introduce period-accurate
  archaic forms ("an europe", "an union") for stylistic cards. Not
  in scope for the rethink.

## Pointers

- Memory: `feedback_small_lists_beat_runtime_dict_scans.md`,
  `feedback_type_blind_tenet.md`, `feedback_word_to_code_invariant.md`,
  `project_round_trip_is_critical.md`.
- whats-new.html section 6 ("Considered: replacing the vowel aug with a
  one-token lookahead") for the original design proposal.
