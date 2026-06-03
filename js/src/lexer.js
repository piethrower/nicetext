// Word/sentence tokenizer, port of OG-NiceText-C++/nicetext-1.0/gendict/src/lexword.l.
// Same lexer is used for listword (corpus → WLIST) and for scramble (cover text → bits),
// so encode/decode round-trips depend on this matching the C++ behavior.
//
// Browser-safe ESM. No Node deps.

export const TOKEN = Object.freeze({
  WORD: 'word',
  PUNCT: 'punct',
  EOS: 'eos',
  // Inter-WORD whitespace runs that are anything other than a single
  // space (multiple spaces, tabs, mid-sentence newlines, indentation
  // runs). Single spaces stay implicit, the formatter's pending-space
  // flag handles them. Genmodel records WHITESPACE token values via
  // the same quoted-literal punct path as EOS values, preserving the
  // corpus's original layout in encoded covers.
  WHITESPACE: 'whitespace',
  // Modern Project Gutenberg markers (paired): everything between START
  // and END is body. Either may appear without the other in malformed
  // files; consumers that want boilerplate skipped should set
  // opts.skipBoilerplate.
  GUTENBERG_START: 'gutenberg-start',
  GUTENBERG_END: 'gutenberg-end',
  // Legacy 1990s "END THE SMALL PRINT!" marker. Different semantics from
  // modern END: the body comes AFTER this marker (it closes the legal
  // preamble rather than the body).
  GUTENBERG_END_LEGACY: 'gutenberg-end-legacy',
});

// Patterns are tried at the current position; longest match wins (lex semantics).
// Ties broken by source order. All patterns use the sticky `y` flag.
//
// WORD: optional name-prefix + core word + zero or more (apostrophe-suffix | hyphen-extension).
// The original lex grammar (lexword.l line 68) constrains contractions per consonant
// (e.g. n't only after n) using DFA backtracking. JS regex doesn't naturally backtrack
// across CORE+SUFFIX boundaries, so we use a permissive apostrophe-suffix that covers
// all real English contractions ('s, 't, 've, 're, in', s', etc.) without harming
// natural-language input.
//   PREFIX     : (D'|d'|O'|o'|L'|l' | '(?=Latin))*
//               : names like D'Artagnan, plus a bare leading
//                apostrophe when followed by a Latin letter so
//                dialect/archaic forms like 'tis, 'twas, 'cause,
//                'em, 'til, 'bout keep the apostrophe. The
//                Latin-script lookahead keeps stray closing
//                quotes from getting absorbed into a following
//                WORD.
//   CORE       : [A-Za-z0-9&#@$%*+_]+
//   APOS_SUFFIX: ' followed by any latin-script run (no upper bound). Covers
//                everyday contractions ('s 't 've 're), dialect / archaic
//                forms ('twas → t'was-style chains, fish'n'chips,
//                rock'n'roll, y'all'd've), and multi-segment apostrophe
//                names. The total token length is still clamped by the
//                outer 128-char CORE atom plus the ABSOLUTE_TOKEN_CAP
//                belt-and-suspenders cap.
//   EXT        : (.|-|://) followed by another CORE : e-mail, http://x, version.1.2
// A word = PREFIX CORE ( APOS_SUFFIX | EXT )*.
//
// HARD CAP on the CORE atom (`{1,128}` instead of `+`) protects against memory
// blowups on garbage input, e.g. a 10 MB binary file pasted into the cover area
// would otherwise have the regex engine try to match a 10 MB "word".
//
// Note: '_' is NOT in WORD_CHAR because Project Gutenberg plain-text uses
// `_word_` for italics. Treating `_` as a word char would tokenize `_above_`
// as a single token (and create thousands of self-defined-singleton "italic"
// types). Instead we treat `_` as punctuation and let the formatter handle
// the italics-pair semantics.
// WORD_CHAR was originally ASCII-only (`[A-Za-z0-9&#@$%*+]`), which dropped
// accented Latin words like `café`, `naïve`, `Dvořák` at lex time and made
// the dictionary monolingual. Step 3 of the phrase-and-charset arc widens
// this to `\p{Script=Latin}` so the lexer admits every Latin-script letter
// (Western + Central + Northern + extended Romanization) while still
// excluding CJK, Cyrillic, Greek, Arabic, Hebrew, Devanagari, etc., those
// scripts ride through as catch-all PUNCT (preserved-literal) and never
// enter the dictionary. Emoji become WORD via §C; in this step they're
// recognized as a single PUNCT cluster so a multi-codepoint emoji
// (variation selector, ZWJ family, regional-indicator flag) doesn't split.
const WORD_CHAR = '[\\p{Script=Latin}0-9&#@$%*+]';
const WORD_RE = new RegExp(
  `(?:[DdOoLl]'|'(?=\\p{Script=Latin}))*` +
  `${WORD_CHAR}{1,128}` +
  `(?:'[\\p{Script=Latin}]*|(?:\\.|-|:\\/\\/)${WORD_CHAR}{1,128})*`,
  'uy'
);
// Belt and suspenders: even if the regex matches 128+128+contraction, we still
// cap the total token length at this many characters. Anything longer is
// definitely not a dictionary word. Unit is UTF-16 code units (JavaScript's
// `.length`), not UTF-8 bytes, relevant once emoji clusters enter the
// picture (a ZWJ family like `👨‍👩‍👧‍👦` measures 11 code units, well below 256).
const ABSOLUTE_TOKEN_CAP = 256;

// Ellipsis (3 dots possibly with whitespace between) OR specific single-char punctuation.
// '_' is included so PG italics markup (`_word_`) tokenizes correctly:
// the underscores are punct tokens, the inner word is a normal WORD token.
// '/' is included so dates (`1/15/2024`), conjunctions (`and/or`), and
// other slash-separated constructs lex as <word>/<word> with the slash
// preserved as a literal punct. The earlier behavior silently pos++'d
// on bare slashes, losing them from cover-side reconstruction. URL
// handling stays correct because WORD_RE's `://` EXT is a single
// alternation unit; the lexer matches the longest pattern at each
// position so `http://x` consumes the slashes as part of one WORD
// before PUNCT_RE gets a turn.
const PUNCT_RE = /(?:\.[\s]*){3}|[,;:()<>"=~+_/]/y;

// End-of-sentence: one or more terminators (. ? ! U+2028) followed by
// optional spaces/quotes/newlines, OR a blank line (two consecutive
// newlines). U+2028 LINE SEPARATOR is in the terminator class so
// texting-style corpora (one message per line, no visible . ! ?) get
// sentence boundaries; see tools/load-corpus.js for the substitution.
const EOS_RE = /[.?!\u2028]+["\s]*\n*|\n{2,}/y;

// Inter-WORD whitespace runs worth preserving: 2+ whitespace chars (any
// mix of space/tab/newline/etc.), OR a single non-space whitespace char
// (\t, \n, \r, \f, \v). Single bare spaces are NOT matched here, they
// fall through the lexer's pos++ skip and stay implicit, handled by
// the formatter's pending-space flag at render time. Order in PATTERNS
// matters: this sits AFTER EOS_RE so a `\n{2,}` blank line lexes as
// EOS, not as multi-newline WHITESPACE.
const WHITESPACE_RE = /[ \t\n\r\f\v]{2,}|[\t\n\r\f\v]/y;

// Emoji grapheme cluster. Lexes as WORD (Step 5 §C reclassification): a
// multi-code-point cluster (BMP + variation selector, base + skin tone,
// regional-indicator flag pair, ZWJ family) is one bit-bearing token. Five
// shapes covered:
//   - Single supplementary-plane base (`🌹`)
//   - BMP emoji-symbol with variation selector 16 (`🌧️` = `🌧` + U+FE0F)
//   - Skin-tone-modified (`👋🏽` = `👋` + U+1F3FD)
//   - Regional-indicator flag pair (`🇺🇸` = U+1F1FA + U+1F1F8)
//   - ZWJ sequence (`👨‍👩‍👧‍👦`, `🧑‍🌾`, `👨🏽‍🌾`, etc.)
// Consecutive clusters with no separator (`🔗🔗🔗`, `🧑‍❤️‍🧑🧑‍❤️‍🧑`) fuse into a
// single WORD because emoji-aug emits dict entries with the concatenated
// form (e.g. mix variants `rose 🌹🌹🌹`); the decoder must lex back to that
// form for round-trip lookup. Whitespace between clusters still ends the
// token: those are separate words at the dict level.
const EMOJI_CLUSTER_RE = new RegExp(
  `(?:` +
  `\\p{Regional_Indicator}\\p{Regional_Indicator}` +
  `|` +
  `\\p{Extended_Pictographic}` +
  `(?:\\uFE0F|\\p{Emoji_Modifier})?` +
  `(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*` +
  `)+`,
  'uy'
);

// Catch-all PUNCT for non-Latin-non-emoji UTF-8. Eagerly consumes any run of
// code points that isn't claimed by an earlier pattern: CJK, Cyrillic, Greek,
// Arabic, Hebrew, Devanagari, math symbols, currency symbols, typographic
// quotes (`«»‹›‚„`), and previously-silent-skipped chars like `{}[]`. The
// run becomes one PUNCT token preserved verbatim end-to-end (genmodel stores
// via the standard pushPunct path, encoder emits via fmt.emitPunct, decoder
// skips at decode.js's WORD-only filter), so corpora in any script survive
// into cover with paragraph breaks intact while only Latin + emoji carry
// bits. The negative class enumerates everything claimed by earlier patterns
// (Latin-script + digits + word-extenders + apostrophe / hyphen / period /
// slash / colon for word EXT + specific PUNCT chars + EOS terminators +
// whitespace + emoji building blocks). Capped at ABSOLUTE_TOKEN_CAP UTF-16
// code units so a 10 MB binary file pasted into the cover area can't blow
// the heap.
const PUNCT_CATCHALL_RE = new RegExp(
  `[^\\p{Script=Latin}0-9&#@$%*+'./:,;()<>"=~_?!\\s\\p{Extended_Pictographic}\\p{Regional_Indicator}\\uFE0F\\u200D\\p{Emoji_Modifier}/\\-]{1,${ABSOLUTE_TOKEN_CAP}}`,
  'uy'
);

const GUTENBERG_START_MODERN_RE = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/my;
const GUTENBERG_END_MODERN_RE = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/my;
const GUTENBERG_END_LEGACY_RE = /.END.THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS.Ver.\d+\.\d+\.\d+.END./y;

// Pattern order is load-bearing for tied-length matches (longest wins;
// ties broken by source order). Specific-char PUNCT precedes catch-all
// PUNCT so its members keep identity as distinct one-char tokens (e.g.
// `,` lexes as a comma, not as a 1-char catch-all run). Emoji-cluster
// (also TOKEN.WORD per §C) precedes the Latin WORD_RE so a multi-code-
// point cluster lexes as one token rather than getting partially
// absorbed by adjacent Latin letters.
const PATTERNS = [
  { type: TOKEN.GUTENBERG_START, re: GUTENBERG_START_MODERN_RE },
  { type: TOKEN.GUTENBERG_END, re: GUTENBERG_END_MODERN_RE },
  { type: TOKEN.GUTENBERG_END_LEGACY, re: GUTENBERG_END_LEGACY_RE },
  { type: TOKEN.WORD, re: EMOJI_CLUSTER_RE },
  { type: TOKEN.WORD, re: WORD_RE },
  { type: TOKEN.PUNCT, re: PUNCT_RE },
  { type: TOKEN.EOS, re: EOS_RE },
  { type: TOKEN.WHITESPACE, re: WHITESPACE_RE },
  { type: TOKEN.PUNCT, re: PUNCT_CATCHALL_RE },
];

// Cheap pre-scan helpers used by the boilerplate-skip path.
const HAS_MODERN_OPENER_RE = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG/m;
const HAS_LEGACY_OPENER_RE = /.END.THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS/;
const HAS_MODERN_CLOSER_RE = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/m;

export function* tokenize(text, opts = {}) {
  // opts.maxWordLength: drop WORD tokens longer than this (treat as no-match
  //   and skip 1 char). Defaults to ABSOLUTE_TOKEN_CAP. The decoder passes
  //   the loaded dictionary's longest word, since words longer than that
  //   can't possibly be in the dict anyway.
  // opts.skipBoilerplate: when true, suppress WORD/PUNCT/EOS tokens that
  //   fall outside the body region defined by Project Gutenberg markers,
  //   and never emit the marker tokens themselves. The pre-scan picks one
  //   of three modes:
  //     - 'modern': text contains a modern START marker. Only modern
  //       START/END drive transitions; legacy END markers (which often
  //       appear inside the preamble of dual-marker files) are ignored.
  //       inBody starts false; START opens, END closes.
  //     - 'legacy': no modern START, but a legacy "END THE SMALL PRINT!"
  //       marker is present. inBody starts false; the legacy marker
  //       opens (preamble closes, body follows). A trailing modern END,
  //       if any, closes.
  //     - 'none': no markers. inBody is true throughout.
  //   When skipBoilerplate is false (default), marker tokens are emitted
  //   and consumers see every token including markers.
  const maxWordLength = Math.min(opts.maxWordLength ?? ABSOLUTE_TOKEN_CAP, ABSOLUTE_TOKEN_CAP);
  const skipBoilerplate = opts.skipBoilerplate === true;

  let inBody = true;
  let mode = 'none';
  if (skipBoilerplate) {
    if (HAS_MODERN_OPENER_RE.test(text)) { mode = 'modern'; inBody = false; }
    else if (HAS_LEGACY_OPENER_RE.test(text)) { mode = 'legacy'; inBody = false; }
  }

  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let best = null;
    for (const p of PATTERNS) {
      p.re.lastIndex = pos;
      const m = p.re.exec(text);
      if (m && m.index === pos) {
        if (!best || m[0].length > best.value.length) {
          best = { type: p.type, value: m[0], position: pos };
        }
      }
    }
    // Truncate overlong WORD matches rather than dropping them. The
    // earlier behavior was `best = null; pos++` which silently lost
    // one byte per attempt AND retriggered WORD_RE at the next char,
    // turning a single overlong WORD into a parade of single-char
    // skips. PUNCT_CATCHALL self-limits via `{1,N}` in the regex;
    // WORD can't (CORE+EXT iterations exceed any internal cap on
    // adversarial input), so cap at emit time and advance by the cap
    // so the rest re-lexes cleanly.
    if (best && best.type === TOKEN.WORD && best.value.length > maxWordLength) {
      let cut = maxWordLength;
      // Don't split a surrogate pair: if `cut` lands on a low
      // surrogate, step back one so the emitted slice ends on a
      // complete code point.
      const hiOrLo = best.value.charCodeAt(cut);
      if (hiOrLo >= 0xDC00 && hiOrLo <= 0xDFFF) cut -= 1;
      best = { type: TOKEN.WORD, value: best.value.slice(0, cut), position: pos };
    }
    if (best) {
      switch (best.type) {
        case TOKEN.GUTENBERG_START:
          if (mode === 'modern') inBody = true;
          if (!skipBoilerplate) yield best;
          break;
        case TOKEN.GUTENBERG_END:
          if (mode === 'modern' || mode === 'legacy') inBody = false;
          if (!skipBoilerplate) yield best;
          break;
        case TOKEN.GUTENBERG_END_LEGACY:
          if (mode === 'legacy') inBody = true;
          // In 'modern' mode, legacy markers inside the preamble are
          // intentionally ignored, only the modern START opens the body.
          if (!skipBoilerplate) yield best;
          break;
        default:
          if (inBody || !skipBoilerplate) yield best;
      }
      pos += best.value.length;
    } else {
      pos++; // unknown char, skip silently (matches lex default)
    }
  }
}

export function tokenizeArray(text, opts) {
  return [...tokenize(text, opts)];
}

// Streaming tokenizer over a ReadableStream<string> (typically a byte
// stream piped through TextDecoderStream). Maintains a carry-over
// buffer at the trailing edge of the current chunk so a token cannot
// be split across a chunk boundary. Only WORD tokens carry recoverable
// information for the decoder, but we hold the full ABSOLUTE_TOKEN_CAP
// (the longest possible WORD) to guarantee correctness on any token.
//
// On each chunk: append to buffer, re-tokenize the whole buffer, emit
// tokens whose end position is at least ABSOLUTE_TOKEN_CAP chars before
// the buffer end (those are guaranteed not to extend further), then
// slice off the emitted prefix and keep the rest for the next chunk.
// On stream end: flush all remaining tokens.
export async function* tokenizeStream(textChunkStream, opts = {}) {
  const reader = textChunkStream.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += value;
      let lastEmitEnd = 0;
      const safeBoundary = buffer.length - ABSOLUTE_TOKEN_CAP;
      if (safeBoundary > 0) {
        for (const token of tokenize(buffer, opts)) {
          const endPos = token.position + token.value.length;
          if (endPos <= safeBoundary) {
            yield token;
            lastEmitEnd = endPos;
          } else {
            break;
          }
        }
        if (lastEmitEnd > 0) buffer = buffer.slice(lastEmitEnd);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  // EOF: nothing more can extend, emit everything remaining.
  for (const token of tokenize(buffer, opts)) {
    yield token;
  }
}

// Greedy longest-match phrase fusion (Step 4 of the phrase-and-charset
// arc). Wraps a token iterable produced by `tokenize` / `tokenizeStream`
// and emits a token stream where any sequence of WORD tokens that
// matches a multi-word entry in the dict's phrase index is fused into
// a single WORD token whose value is the canonical single-space form.
//
// Fusion contract:
//   - Inter-WORD WHITESPACE tokens are transparent for matching, so
//     `a la carte`, `a   la   carte`, and `a\nla\ncarte` all fuse
//     identically. Consumed WHITESPACE tokens disappear from the
//     emitted stream when they sit inside a fused span.
//   - PUNCT or EOS between two WORDs is a hard barrier. Fusion never
//     crosses one. The decoder mirrors this with the encoder's
//     phrase-buffer clear-on-PUNCT-or-EOS behavior.
//   - Greedy longest-match: the phrase index sorts buckets by parts
//     length descending, so the first candidate to match in a bucket
//     is the longest phrase starting at the current head WORD.
//
// Two variants for the two consumer flavors: sync `phraseFuse` for
// in-memory use (tokenizeArray-style callers and tests), async
// `phraseFuseAsync` for the streaming decode path (tokenizeStream).
// Both share `matchPhraseInBuffer` and obey the same contract.
//
// `phraseIndex` and `maxPhraseLen` come from `dict.phraseIndex` /
// `dict.maxPhraseLen` (built once at loadDictionary time). When the
// dict has no phrase entries, both helpers short-circuit to a
// passthrough so the cost is one Map.size check per call.
export function* phraseFuse(tokenIterable, phraseIndex, maxPhraseLen) {
  if (!phraseIndex || phraseIndex.size === 0) {
    yield* tokenIterable;
    return;
  }
  const lookahead = maxPhraseLen * 2 + 2;
  const buf = [];
  const iter = tokenIterable[Symbol.iterator]();
  let inputDone = false;
  function fillBuf() {
    while (buf.length < lookahead && !inputDone) {
      const next = iter.next();
      if (next.done) { inputDone = true; break; }
      buf.push(next.value);
    }
  }
  for (;;) {
    fillBuf();
    if (buf.length === 0) break;
    const head = buf[0];
    if (head.type !== TOKEN.WORD) { yield buf.shift(); continue; }
    const candidates = phraseIndex.get(head.value.toLowerCase());
    if (!candidates) { yield buf.shift(); continue; }
    let matched = null, consumeCount = 0;
    for (const cand of candidates) {
      const span = matchPhraseInBuffer(buf, cand);
      if (span !== null) { matched = cand; consumeCount = span; break; }
    }
    if (matched) {
      yield {
        type: TOKEN.WORD,
        value: matched.canonical,
        position: head.position,
        fused: true,
      };
      buf.splice(0, consumeCount);
    } else {
      yield buf.shift();
    }
  }
}

export async function* phraseFuseAsync(tokenIterable, phraseIndex, maxPhraseLen) {
  if (!phraseIndex || phraseIndex.size === 0) {
    for await (const t of tokenIterable) yield t;
    return;
  }
  const lookahead = maxPhraseLen * 2 + 2;
  const buf = [];
  // Manual iterator handle so fillBuf() can be called repeatedly across
  // generator yields without restarting the source. Accept either an
  // async iterable (tokenizeStream) or a sync iterable (tokenizeArray).
  // The try/finally is critical: when a consumer breaks out of a
  // for-await over this generator (e.g., decode finishes on the EOF
  // marker mid-stream), our own return() runs, but the manual `iter`
  // handle would NOT receive its own return(), meaning the inner
  // tokenizeStream's finally (which releases its lock on textStream)
  // never fires. textStream stays locked, decode can't cancel it,
  // upstream backpressure never lifts, the producer hangs. Wrapping
  // in finally and explicitly invoking iter.return() restores the
  // standard cancel propagation chain.
  const iter = tokenIterable[Symbol.asyncIterator]
    ? tokenIterable[Symbol.asyncIterator]()
    : tokenIterable[Symbol.iterator]();
  let inputDone = false;
  async function fillBuf() {
    while (buf.length < lookahead && !inputDone) {
      const next = await iter.next();
      if (next.done) { inputDone = true; break; }
      buf.push(next.value);
    }
  }
  try {
    for (;;) {
      await fillBuf();
      if (buf.length === 0) break;
      const head = buf[0];
      if (head.type !== TOKEN.WORD) { yield buf.shift(); continue; }
      const candidates = phraseIndex.get(head.value.toLowerCase());
      if (!candidates) { yield buf.shift(); continue; }
      let matched = null, consumeCount = 0;
      for (const cand of candidates) {
        const span = matchPhraseInBuffer(buf, cand);
        if (span !== null) { matched = cand; consumeCount = span; break; }
      }
      if (matched) {
        yield {
          type: TOKEN.WORD,
          value: matched.canonical,
          position: head.position,
          fused: true,
        };
        buf.splice(0, consumeCount);
      } else {
        yield buf.shift();
      }
    }
  } finally {
    if (typeof iter.return === 'function') {
      try { await iter.return(); } catch {}
    }
  }
}

// Returns the count of buffer entries (WORDs + transparent WHITESPACEs)
// that this candidate consumes on match, or null on no-match. PUNCT,
// EOS, and WHITESPACE are all hard barriers; encountering one before
// the candidate's last part rejects.
//
// Round-trip safety: the encoder writes a phrase canonical (e.g.
// "ax 🪓🪓🪓") with internal SINGLE spaces, which the lexer doesn't
// tokenize at all (WHITESPACE_RE requires 2+ chars or a non-space
// whitespace char like \n / \t). So any WHITESPACE token between
// two WORDs in cover was emitted as a separate ^literal^ punct or
// 'n'/'p' punct from the model, NOT as part of a phrase. The
// encoder's phrase buffer is drained on every punct, so it never
// emits a phrase canonical that spans cover-side whitespace. Letting
// phraseFuse cross WHITESPACE here would let the decoder fuse
// "the\nax" → "the ax" while the encoder picked "the" + "ax …" as
// independent slots, bit drift, round-trip fail.
function matchPhraseInBuffer(buf, cand) {
  let bufIdx = 0;
  let wordIdx = 0;
  while (wordIdx < cand.parts.length) {
    if (bufIdx >= buf.length) return null;
    const tok = buf[bufIdx];
    if (tok.type !== TOKEN.WORD) return null;
    if (tok.value.toLowerCase() !== cand.parts[wordIdx]) return null;
    bufIdx++;
    wordIdx++;
  }
  return bufIdx;
}
