// redaction: single source of truth for the redaction system.
//
// One marker constant, one type constant, three functions every call
// site uses. Belt-and-suspenders: redaction runs at twlist producers
// (build-time fixture creation + runtime custom uploads), at twlist
// consumers (sortDict), and at corpus tokenization (genmodel/listword
// via phraseFuse against a combined dict + redacted phrase index).
//
// Function naming uses "Redact"/"Redacted" so call sites are
// unambiguous about what they're doing.
//
// Scope: ONLY cover-generation inputs (corpus text, twlist entries).
// Never the user's secret payload or decoded output, those are
// untouched ([[redaction-scope]] memory).
//
// Lexer constraint: WORD_CHAR is `[\p{Script=Latin}0-9&#@$%*+]` per
// js/src/lexer.js. Underscores are deliberately PUNCT (PG `_italics_`
// markup), so an `_x_` wrapper splits into three tokens. Any wrapper
// built from the WORD_CHAR class (`*`, `#`, `&`, `$`, `%`, `+`)
// tokenizes as ONE WORD. `**redacted**` uses markdown-bold framing
// for human readability, recognizable as a censored marker on
// sight, renders correctly through any markdown surface.

import { loadResource } from '../resource-loader.js';
import { wrapPackedStrings } from '../eve/packed-strings-sab.js';

export const REDACTION_MARKER = '**redacted**';
export const REDACTED_TYPE = 'REDACTED';

// Marker entry (REDACTED, **redacted**). Returned fresh each call so
// callers can safely include it in a mutable array. Built from the
// constants above; never hardcoded.
export function getRedactedTwlistEntry() {
  return { type: REDACTED_TYPE, word: REDACTION_MARKER };
}

// Load + cache the parsed redacted list. Shared across getRedactedSingles
// and getRedactedMatcher so a single loadResource serves both.
let _parseCache;   // undefined = not loaded; object once loaded
let _parsePromise; // in-flight; await once for concurrent callers
async function loadParsed() {
  if (_parseCache !== undefined) return _parseCache;
  if (_parsePromise) return _parsePromise;
  _parsePromise = (async () => {
    const sab = await loadResource('redacted', 'wlist');
    const entries = [...wrapPackedStrings(sab).iterate()];
    if (entries.length === 0) {
      throw new Error('redaction: fixtures/redacted.wlist.sab.gz is empty; refusing to proceed');
    }
    const singles = new Set();
    const phrases = [];
    for (const w of entries) {
      if (!w) continue;
      if (/\s/.test(w)) phrases.push(w);
      else singles.add(w);
    }
    // phraseFuse uses greedy longest-match within each head-word
    // bucket via sort-by-parts-length-desc; mirror that here.
    phrases.sort((a, b) => b.length - a.length);
    _parseCache = { singles, phrases };
    return _parseCache;
  })();
  return _parsePromise;
}

// Load the single-word redactions as a Set<string>. Used by every
// twlist seam (producer + consumer) via redactTwlistEntries, and by
// parseTwlistLines's convenience layer to surface 'redacted'
// rejections in the UI.
export async function getRedactedSingles() {
  const { singles } = await loadParsed();
  return singles;
}

// Load the redaction matcher shaped for the lexer's phraseFuse.
// Returns { singles, phraseIndex, maxPhraseLen }. genmodel/listword
// merge phraseIndex with dict.phraseIndex into one combined index
// passed to a single phraseFuse pass during corpus tokenization.
//
// phraseIndex shape matches js/src/dictionary.js's buildPhraseIndex
// output: Map<headWordLower, Array<{parts: string[], canonical: string}>>.
// Every redacted entry (single or phrase) gets canonical =
// REDACTION_MARKER so phraseFuse always emits the marker.
export async function getRedactedMatcher() {
  const { singles, phrases } = await loadParsed();
  const phraseIndex = new Map();
  let maxPhraseLen = 0;
  // Singles are length-1 "phrases" with canonical = marker.
  for (const w of singles) {
    addIndexEntry(phraseIndex, w, [w]);
    if (maxPhraseLen < 1) maxPhraseLen = 1;
  }
  for (const phrase of phrases) {
    const parts = phrase.split(/\s+/);
    if (parts.length === 0) continue;
    addIndexEntry(phraseIndex, parts[0], parts);
    if (maxPhraseLen < parts.length) maxPhraseLen = parts.length;
  }
  // Each bucket sorted longest-first so phraseFuse's first-match-wins
  // loop gives greedy longest behavior.
  for (const arr of phraseIndex.values()) {
    arr.sort((a, b) => b.parts.length - a.parts.length);
  }
  return { singles, phraseIndex, maxPhraseLen };
}

function addIndexEntry(index, head, parts) {
  let arr = index.get(head);
  if (!arr) { arr = []; index.set(head, arr); }
  arr.push({ parts, canonical: REDACTION_MARKER });
}

// Apply the twlist redaction at any producer or consumer seam.
// Drops every entry whose lowercase word is in the redacted singles
// set, then prepends one (REDACTED, **redacted**) marker entry. Pure
// (does not mutate input).
//
// Callers MUST pre-load `singles` via getRedactedSingles() once and
// pass it in, keeps this function sync at the inner loop so it can
// be called at hot paths without an async wrapper everywhere.
export function redactTwlistEntries(entries, singles) {
  const out = [getRedactedTwlistEntry()];
  for (const e of entries) {
    const w = (e.word ?? '').toLowerCase();
    if (singles.has(w)) continue;
    out.push(e);
  }
  return out;
}
