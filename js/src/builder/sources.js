// Source readers for the OG twlist pipeline. Pure data transforms, no fs.
// Browser-safe ESM. (The Node-side reader lives in tools/.)

import { parseWordList } from './txt2dct.js';
import { tokenize, TOKEN } from '../lexer.js';

// Parse a TWLIST text into { type, word } records.
//
// Three import-time gates ensure every entry survives encode/decode round-trip:
//   0. Lines starting with `#` are comments, skipped silently.
//   1. A valid line has at least one whitespace run separating the type
//      column from the value column. The first whitespace run is the
//      separator; everything before is the type, everything after is
//      the value. Multi-word values (phrases) are admitted, the value
//      column may contain its own internal whitespace. Spaces in the
//      TYPE column are still forbidden (the merge step assumes
//      whitespace-free type identifiers). Equivalent to a match of
//      /^(\S+)\s+(.+)$/.
//   2. The value must lex as one or more WORD tokens separated only by
//      WHITESPACE: no PUNCT or EOS tokens in the middle. The value
//      canonicalizes to single-space form (the WORD tokens joined by
//      a single space). Same lexer-as-validator contract; same gate
//      that catches embedded punctuation, hyphen patterns the lexer
//      rejects: non-Latin-script characters that lex as catch-all
//      PUNCT: etc.
//
// Phrase admission (Step 4 of the phrase-and-charset arc): the rule-1
// `^\\S+\\s+\\S+$` legacy pattern was a hardcoded single-WORD-only
// gate. With phrase support, the value column may contain internal
// whitespace. Values like `a capella` (two WORDs separated by a single
// space) admit; values like `wow!` (containing a PUNCT terminator)
// still reject via rule 2.
//
// Default return: Array<{type, word}>.
// With { reportRejections: true }: { entries, rejections } where:
//   entries:    [{ type, word, lineIndex }]   (lineIndex added so the
//               UI verify path can rewrite each valid line back to a
//               canonical form in the same row).
//   rejections: [{ lineIndex, line, reason }]
//   reason ∈ { 'malformed' (Rule 1), 'lexer-rejected' (Rule 2) }
// Comments and blank lines are NOT in rejections (they're not errors).
// Used by the UI's verify-and-comment-out path; engine callers that
// only want entries pass no opts and get the legacy shape.
export function parseTwlistLines(text, opts = {}) {
  const { reportRejections = false, redactedSingles = null } = opts;
  const out = [];
  const rejections = reportRejections ? [] : null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line || line.startsWith('#')) continue;
    // Rule 1: type is the first whitespace-free run; value is everything
    // after the first whitespace run (multi-word values OK). Spaces in
    // the type column still reject.
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) {
      if (rejections) rejections.push({ lineIndex: i, line, reason: 'malformed' });
      continue;
    }
    const type = m[1];
    const rawValue = m[2];
    // Rule 2: value lexes as ≥1 WORD tokens separated only by WHITESPACE.
    // Canonicalize to single-space form (the WORD tokens joined by ' ').
    const wordParts = [];
    let lexerOk = true;
    for (const tok of tokenize(rawValue)) {
      if (tok.type === TOKEN.WORD) {
        wordParts.push(tok.value);
      } else if (tok.type === TOKEN.WHITESPACE) {
        // Inter-WORD whitespace runs (multi-space, tabs, etc.) are
        // transparent for phrase admission, they collapse to a single
        // space in the canonical form.
        continue;
      } else {
        // PUNCT or EOS in the value column breaks phrase admission.
        lexerOk = false;
        break;
      }
    }
    if (!lexerOk || wordParts.length === 0) {
      if (rejections) rejections.push({ lineIndex: i, line, reason: 'lexer-rejected' });
      continue;
    }
    // The canonical word is the WORD tokens single-space-joined. Verify
    // that re-lexing the canonical form produces exactly the same WORD
    // sequence: guards against any lexer corner case (e.g. a value
    // whose first char is implicitly consumed by some pattern that
    // doesn't fire on its own).
    const canonical = wordParts.join(' ');
    const reLexed = [];
    for (const tok of tokenize(canonical)) {
      if (tok.type === TOKEN.WORD) reLexed.push(tok.value);
      else if (tok.type !== TOKEN.WHITESPACE) { reLexed.length = -1; break; }
    }
    if (reLexed.length !== wordParts.length || reLexed.some((w, j) => w !== wordParts[j])) {
      if (rejections) rejections.push({ lineIndex: i, line, reason: 'lexer-rejected' });
      continue;
    }
    // Convenience-layer redaction check: when the caller supplies
    // redactedSingles (a Set<string>), any line whose canonical
    // lowercase word is in the set is rejected with reason
    // 'redacted'. UI-visible parallel to 'malformed' and
    // 'lexer-rejected'. The downstream defense-in-depth still applies
    // at sortDict regardless; this is purely so the user sees WHY
    // their input was dropped.
    if (redactedSingles && redactedSingles.has(canonical.toLowerCase())) {
      if (rejections) rejections.push({ lineIndex: i, line, reason: 'redacted' });
      continue;
    }
    out.push(reportRejections ? { type, word: canonical, lineIndex: i } : { type, word: canonical });
  }
  return reportRejections ? { entries: out, rejections } : out;
}

// MIT name lists: each file is a wordlist; emit (filename, word) entries.
// The OG NiceText port of mitlist/Makefile applied a possessive augmentor
// (pos.awk / posplr.awk) emitting "<name>_pos" entries for personal names
// and a "name_family_pos_plr" entry for family names. We dropped that:
//   - grammars/mit-names.def (the only consumer of these MIT type names)
//     never references the _pos / _pos_plr types, so the augmentor added
//     nothing the CFG used.
//   - master gets ~16K possessives naturally from kimmo + rhyme, which
//     already cover proper-name possessives like "Achilles'" / "Ada's".
// Result: this function now produces the bare flattened form. No possessive
// expansion. Same shape as build-mit-dict.js's local bareMitlist used to.
export function expandMitlist(named) {
  // named: { name_family: text, name_female: text, ..., place: text }
  const out = [];
  for (const [name, text] of Object.entries(named)) {
    for (const w of parseWordList(text)) out.push({ type: name, word: w });
  }
  return out;
}

// Numeric: each file becomes (filename, word) per line.
export function expandNumeric(named) {
  const out = [];
  for (const [name, text] of Object.entries(named)) {
    for (const w of parseWordList(text)) out.push({ type: name, word: w });
  }
  return out;
}

// Restrict a TWLIST to only entries whose word appears in `vocabSet` (lowercased).
// For vocab words NOT covered by any TWLIST entry, emit a self-defined
// (word, word) entry, they become single-word types after dct2mstr.
// Mirrors the OG wizwords.twl recipe in 1.0 examples/database/Makefile.
export function restrictToVocab(twlist, vocabSet) {
  const out = [];
  const covered = new Set();
  for (const e of twlist) {
    const w = e.word.toLowerCase();
    if (vocabSet.has(w)) {
      out.push(e);
      covered.add(w);
    }
  }
  for (const w of vocabSet) {
    if (!covered.has(w)) out.push({ type: w, word: w });
  }
  return out;
}

// Yielding variant of restrictToVocab. Same shape as sortDictAsync:
// callers that drive a progress modal pass onProgress + optionally a
// signal. yieldEvery is per-iteration count between event-loop yields.
//
// onProgress events:
//   { phase: 'restrict-filter', i, total }   during the twlist pass
//   { phase: 'restrict-cover',  i, total }   during the vocab-coverage pass
//   { phase: 'restrict-end',    total }      at completion
//
// opts.yieldEvery  items per yield (default 50,000)
// opts.signal      optional AbortSignal
export async function restrictToVocabAsync(twlist, vocabSet, opts = {}) {
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const out = [];
  const covered = new Set();
  const inputLen = Array.isArray(twlist) ? twlist.length : 0;
  let i = 0;
  for (const e of twlist) {
    i++;
    const w = e.word.toLowerCase();
    if (vocabSet.has(w)) {
      out.push(e);
      covered.add(w);
    }
    if ((i % yieldEvery) === 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (onProgress) onProgress({ phase: 'restrict-filter', i, total: inputLen });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const coverTotal = vocabSet.size;
  let j = 0;
  for (const w of vocabSet) {
    j++;
    if (!covered.has(w)) out.push({ type: w, word: w });
    if ((j % yieldEvery) === 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (onProgress) onProgress({ phase: 'restrict-cover', i: j, total: coverTotal });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress({ phase: 'restrict-end', total: out.length });
  return out;
}
