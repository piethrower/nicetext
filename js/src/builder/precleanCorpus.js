// precleanCorpus: round-trip-safe normalization of corpus text before
// genmodel / listword tokenize it. Pure, deterministic, no I/O.
//
// Framing (docs/research-notes.md §19): every rule answers "if this
// shape COULD cause lexer round-trip mismatch, drop or normalize it."
// Believability impact is a tiebreaker, not the deciding factor.
//
// Rules are applied in declaration order; the whole set is looped
// until a pass produces no change (string `===` idempotence check).
// JS string `===` is one C++-level memcmp; for the largest corpus
// we ship (~5.4 MiB Shakespeare) that's a couple ms per pass. Far
// cheaper than the alternative `.test()`-per-rule short-circuit
// (which scans the whole buffer for each rule on the terminating
// confirmation pass).
//
// Rules 5 (TR39 mixed-script normalize) and 7 (period-EXT chain
// split) are implemented here alongside the others, as is the
// later-added Rule 0 (line-ending normalization).
//
// Browser-safe ESM. No Node deps.

import { CONFUSABLES } from '../../../fixtures/confusables-data.js';

// Rule 0, normalize Windows / classic-Mac line endings to LF. CRLF
// pairs and bare CR both become LF. Runs FIRST so subsequent rules
// (and the lexer downstream) only see one canonical newline form.
//
// Why: 7 corpora shipped before this rule existed had CRLF endings.
// Without normalization, \r bytes get preserved by Rule 1 (CR is in
// the EXCEPT list as "lexer-significant whitespace"), propagate
// through genmodel's WHITESPACE tokens, and ride into the cover
// output where browsers' textareas strip them on .value get,
// producing a stats / textarea mismatch and slightly larger model
// sizes for no benefit. \r and \n are interchangeable as
// sentence/whitespace boundary signals for the lexer.
const CRLF_OR_BARE_CR_RE = /\r\n?/g;
function rule0_normalizeLineEndings(text) {
  return text.replace(CRLF_OR_BARE_CR_RE, '\n');
}

// Rule 1, collapse any run of non-printable code points to a single
// U+0020 space. Non-printable = Unicode category \p{C} (Cc, Cf, Cs,
// Co, Cn) EXCEPT:
//   - \t \n \v \f      (Cc whitespace controls; carry layout, lexer
//                       uses them for sentence/whitespace boundaries.
//                       \r was on this list; Rule 0 above normalizes
//                       it away before Rule 1 ever sees it.)
//   - U+200D / U+200C  (ZWJ / ZWNJ; emoji-cluster machinery and
//                       rule 6 decide their fate by neighbor context)
// BOM (U+FEFF), zero-width space (U+200B), bidi marks, soft hyphen,
// PUA, surrogates-in-isolation, and unassigned code points all match
// and collapse to one space.
const NON_PRINTABLE_RUN_RE = /(?:(?![\t\n\v\f‌‍])\p{C})+/gu;
function rule1_collapseNonPrintable(text) {
  return text.replace(NON_PRINTABLE_RUN_RE, ' ');
}

// Rule 2, curly quotes → straight ASCII. WORD_RE's apostrophe-suffix
// is ASCII `'` only; smart quotes inside contractions fragment the
// word at the script boundary.
const CURLY_SINGLE_RE = /[‘’]/g;
const CURLY_DOUBLE_RE = /[“”]/g;
function rule2_straightenQuotes(text) {
  return text.replace(CURLY_SINGLE_RE, "'").replace(CURLY_DOUBLE_RE, '"');
}

// Rule 3. NBSP / thin spaces / similar exotic whitespace → U+0020.
// These code points are NOT in the lexer's `\s` class, so they'd
// otherwise become PUNCT_CATCHALL tokens and survive into cover.
const EXOTIC_SPACE_RE = /[     　]/g;
function rule3_normalizeExoticSpace(text) {
  return text.replace(EXOTIC_SPACE_RE, ' ');
}

// Rule 4, em dash / en dash → single space. Both become
// PUNCT_CATCHALL today (`-` is excluded from PUNCT_CATCHALL's
// negative class for word-EXT reasons), high-signal typography that
// would otherwise survive into cover unchanged. Slight believability
// loss in literary text; no beacon.
const EM_EN_DASH_RE = /[–—]/g;
function rule4_dashesToSpace(text) {
  return text.replace(EM_EN_DASH_RE, ' ');
}

// Rule 5, fold non-Latin confusables to their Latin look-alikes.
// Data comes from `fixtures/confusables-data.js` (copied at build time
// from fixture-src/confusables/cooked/), generated offline from
// Unicode TR39 v15.1.0 (`tools/build-confusables-map.js`). The
// filter at generation time keeps only entries whose SOURCE is in
// a real non-Latin script (Cyrillic, Greek, Cherokee, etc., never
// Script=Common or Inherited) and whose TARGET is entirely in
// WORD_CHAR. So Cyrillic `а` (U+0430) folds to ASCII `a`, but
// `|` (U+007C, Script=Common) stays as-is, intentional, because
// pipes/multiplication-signs/etc. carry real meaning in plain
// text and folding them would merge tokens.
const CONFUSABLES_RE = new RegExp(
  '[' + [...CONFUSABLES.keys()].map(cp => `\\u{${cp.toString(16)}}`).join('') + ']',
  'gu'
);
function rule5_normalizeConfusables(text) {
  return text.replace(CONFUSABLES_RE, m => CONFUSABLES.get(m.codePointAt(0)) ?? m);
}

// Rule 7, split pure-numeric period-EXT chains of 3+ segments.
// `WORD_RE`'s period-EXT happily absorbs `1.2.3.4.5` as one
// bit-bearing WORD that beacons in cover (1-of-1 dict entry). We
// only fire on chains that are unambiguously NOT a meaningful
// single token:
//   - 3+ segments (so `e.g.`, `a.m.`, `Mr.`, plain `1.2` stay one
//     WORD; 2-segment shapes are too often legit abbreviations)
//   - every segment is pure digits (so `U.S.A.`, `www.example.com`,
//     `version.1.2.3` all stay one WORD, mixed-content chains
//     usually carry meaning we want to preserve)
//   - `(?<![\w.])` / `(?![\w.])` anchors keep the match from biting
//     into surrounding word chars or further periods, so
//     `version.1.2.3` doesn't trigger on the trailing `1.2.3` slice.
// On match, the segments survive verbatim and only the inner `.`s
// flip to U+0020. IPs (`192.168.1.1`) fall through this gate;
// rare in literary corpora and a split IP is less of a beacon than
// a 1-of-1 IP WORD.
const NUMERIC_CHAIN_RE = /(?<![\w.])\d+(?:\.\d+){2,}(?![\w.])/g;
function rule7_splitNumericChains(text) {
  return text.replace(NUMERIC_CHAIN_RE, m => m.replace(/\./g, ' '));
}

// Rule 6, strip stray ZWJ / ZWNJ. Keep them only when BOTH adjacent
// code points are emoji building blocks (Extended_Pictographic,
// Regional_Indicator, Emoji_Modifier, or U+FE0F variation selector
// 16). Edge of string counts as "not emoji". This matches the
// lexer's EMOJI_CLUSTER_RE, so a legitimate ZWJ family (`👨‍👩‍👧‍👦`)
// keeps its joiners while an orphan ZWJ between two Latin letters
// (which would otherwise fragment a WORD via PUNCT_CATCHALL) is
// removed.
const ZWJ_OR_ZWNJ_RE = /[‌‍]/g;
const EMOJI_BUILDING_BLOCK_RE =
  /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}️]/u;

function isEmojiBuildingBlockAt(text, idx) {
  if (idx < 0 || idx >= text.length) return false;
  // If idx lands on a low surrogate, step back to the high
  // surrogate so codePointAt reads the full code point.
  let start = idx;
  const cu = text.charCodeAt(idx);
  if (cu >= 0xDC00 && cu <= 0xDFFF && idx > 0) start = idx - 1;
  return EMOJI_BUILDING_BLOCK_RE.test(String.fromCodePoint(text.codePointAt(start)));
}

function rule6_stripStrayZeroWidthJoiners(text) {
  return text.replace(ZWJ_OR_ZWNJ_RE, (match, offset) => {
    const leftEmoji = isEmojiBuildingBlockAt(text, offset - 1);
    const rightEmoji = isEmojiBuildingBlockAt(text, offset + 1);
    return (leftEmoji && rightEmoji) ? match : '';
  });
}

const RULES = [
  rule0_normalizeLineEndings,
  rule1_collapseNonPrintable,
  rule2_straightenQuotes,
  rule3_normalizeExoticSpace,
  rule4_dashesToSpace,
  rule5_normalizeConfusables,
  rule6_stripStrayZeroWidthJoiners,
  rule7_splitNumericChains,
];

// Per-chunk processing parameters (audit Findings 4 + 5, 2026-05-18).
// Chunks the input at line boundaries so each rule's per-chunk regex
// call is bounded:
//   - Firefox's Irregexp recursion limit (Finding 5) is never reached
//     on individual chunks (~512 KB << the 20-30 MB threshold where
//     `too much recursion` was firing).
//   - Per-chunk onProgress emit keeps the modal's ≥1 Hz contract
//     (Finding 4) even on 200 MB corpora.
//
// All seven rules are safe at line boundaries: Rule 0 (CR/CRLF→LF) is
// per-char; Rule 1's non-printable run can't cross \n (\n is in the
// EXCEPT list); Rules 2/3/4/5 are per-char; Rule 6 (ZWJ) at a chunk
// start has \n as its left neighbor (correctly stripped); Rule 7's
// numeric chain can't cross \n.
//
// PRECLEAN_CHUNK_TARGET sized for ~10 chunks/sec on a typical machine
// for the worst-case rule 5 (confusables); empirically chosen.
const PRECLEAN_CHUNK_TARGET = 512 * 1024;   // 512 KB
const PRECLEAN_CHUNK_MAX = 2 * 1024 * 1024; // 2 MB hard cap (when no
                                            // newline found near target)

function chunkPrecleanInput(text) {
  const chunks = [];
  if (text.length === 0) return chunks;
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + PRECLEAN_CHUNK_TARGET, text.length);
    if (end < text.length) {
      // Snap to next \n if within the hard cap; otherwise force-split.
      const nl = text.indexOf('\n', end);
      if (nl >= 0 && nl + 1 - pos <= PRECLEAN_CHUNK_MAX) {
        end = nl + 1;
      } else if (pos + PRECLEAN_CHUNK_MAX < text.length) {
        end = pos + PRECLEAN_CHUNK_MAX;
      } else {
        end = text.length;
      }
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

// Optional onProgress callback fires once per chunk after all rules
// have run on that chunk. Shape: { pass, chunkIndex, chunkCount, chars }
// where `chars` is the cumulative processed length so far in this pass.
// Callers in a worker post these to the main thread for UI updates;
// sync callers (genmodel, tests) typically pass nothing and the loop
// runs silently.
//
// Redaction is NOT a precleanCorpus concern, it runs at the lexer-
// aligned phraseFuse pass in genmodel/listword (see redaction.js's
// getRedactedMatcher) rather than as a pre-tokenize regex sweep.
export function precleanCorpus(text, onProgress) {
  let prev;
  let pass = 0;
  do {
    pass++;
    prev = text;
    const chunks = chunkPrecleanInput(text);
    const totalChunks = chunks.length;
    const processed = new Array(totalChunks);
    let cumChars = 0;
    for (let ci = 0; ci < totalChunks; ci++) {
      let chunk = chunks[ci];
      for (let i = 0; i < RULES.length; i++) {
        chunk = RULES[i](chunk);
      }
      processed[ci] = chunk;
      cumChars += chunk.length;
      if (onProgress) {
        try {
          onProgress({
            pass,
            chunkIndex: ci,
            chunkCount: totalChunks,
            chars: cumChars,
          });
        } catch {}
      }
    }
    text = processed.join('');
  } while (text !== prev);
  return text;
}
