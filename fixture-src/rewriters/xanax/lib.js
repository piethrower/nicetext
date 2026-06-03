// fixture-src/rewriters/xanax/lib.js -- shared helpers for the xanax
// (a/an agreement) research and audit tools (inspect.js,
// derive-exceptions.js, corpus-sweep.js).
//
// Two classification axes:
//   - Orthographic: based on the leading letter of the next word.
//   - Phonological: based on the first ARPABET phoneme of the next
//     word, as looked up in the CMU Pronouncing Dictionary.
//
// Plus a scanner that walks a body of text and yields every
// standalone "a" or "an" along with its following word.
//
// Zero deps; Node built-ins only.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// ---- orthographic classification ----------------------------------

// Letter classes used by the strict / liberal orthographic rules.
// "vowel" here means [aeiou]; the h bucket is reported separately
// because corpora and grammars disagree on whether h-leading words
// take "an" (an historic / an honest vs. a historic / a honest).
export function classifyByLetter(nextWord) {
  if (!nextWord) return 'nonletter';
  const ch = nextWord[0].toLowerCase();
  if ('aeiou'.includes(ch)) return 'vowel';
  if (ch === 'h') return 'h';
  if (ch >= 'a' && ch <= 'z') return 'consonant';
  return 'nonletter';
}

// ---- phonological classification ----------------------------------

// ARPABET vowel phonemes (no stress digit). All other ARPABET
// symbols (B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH)
// are consonants. Notably HH (the H sound), W, and Y are consonants
// for a/an agreement -- which is why "a happy" (HH), "a one" (W),
// "a united" (Y), and "an hour" (silent h, AW onset) are all the
// correct natural-English forms.
export const VOWEL_PHONEMES = new Set([
  'AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW',
]);

// Returns 'vowel-onset' | 'consonant-onset' for an ARPABET phoneme
// (with or without trailing stress digit).
export function classifyByPhoneme(phoneme) {
  if (!phoneme) return null;
  const base = phoneme.replace(/\d+$/, '');
  return VOWEL_PHONEMES.has(base) ? 'vowel-onset' : 'consonant-onset';
}

// Reads the CMU Pronouncing Dictionary (gzipped cmudict.dict format)
// and returns Map<lowercase-word, first-phoneme-no-stress>. Apostrophe-
// leading entries ('em, 'twas, ...) are skipped. word(N) variants are
// dropped in favor of the primary entry (or the first variant if no
// primary exists).
export function loadCmuMap(path) {
  const raw = gunzipSync(readFileSync(path)).toString('utf8');
  const lines = raw.split('\n');
  const map = new Map();
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    let word = m[1];
    if (!/^[a-z]/.test(word)) continue;
    const vm = word.match(/^(.+?)\(\d+\)$/);
    const isVariant = !!vm;
    if (isVariant) word = vm[1];
    if (isVariant && map.has(word)) continue;
    const firstPh = m[2].trim().split(/\s+/)[0].replace(/\d+$/, '');
    map.set(word, firstPh);
  }
  return map;
}

// ---- text scanner -------------------------------------------------

// Walks text and yields every standalone "a" or "an" together with
// the next word (next run of Unicode letters) and a short snippet
// for human inspection. Standalone means surrounded by non-letter
// characters; \b on \w handles ASCII neighbors.
const ARTICLE_RE = /\b(a|an)\b/gi;

export function* scanArticles(text) {
  let m;
  while ((m = ARTICLE_RE.exec(text)) !== null) {
    const article = m[1].toLowerCase();
    const startIdx = m.index;
    const afterArticle = startIdx + m[0].length;
    // Skip to next letter (Unicode-aware).
    let i = afterArticle;
    while (i < text.length && !/\p{L}/u.test(text[i])) i++;
    let nextWord = '';
    let endIdx = afterArticle;
    if (i < text.length) {
      let j = i;
      while (j < text.length && /\p{L}/u.test(text[j])) j++;
      nextWord = text.slice(i, j);
      endIdx = j;
    }
    yield { article, nextWord, startIdx, endIdx };
  }
  // Reset for re-use of the regex on subsequent texts.
  ARTICLE_RE.lastIndex = 0;
}

export function makeSnippet(text, startIdx, endIdx) {
  const before = text.slice(Math.max(0, startIdx - 24), startIdx).replace(/\s+/g, ' ');
  const middle = text.slice(startIdx, endIdx);
  const after  = text.slice(endIdx, Math.min(text.length, endIdx + 24)).replace(/\s+/g, ' ');
  return `…${before}[${middle}]${after}…`;
}
