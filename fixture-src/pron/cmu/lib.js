// fixture-src/pron/cmu/lib.js: shared CMU Pronouncing Dictionary
// loader for build-time twlist derivation (cmu-syllable, cmu-stress,
// cmu-alliteration). Reads cmudict.dict.gz once; callers iterate over
// the returned Map.
//
// xanax/lib.js has its own narrower loadCmuMap (returns just the first
// phoneme per word, for a/an agreement). Once the three new derive
// scripts settle, xanax can migrate to this loader and drop the
// duplicate. Until then both coexist.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// ARPABET vowel phonemes (no stress digit). Same set as xanax/lib.js.
// Syllable count = number of vowel phonemes in a pronunciation.
export const VOWEL_PHONEMES = new Set([
  'AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW',
]);

// Reads cmudict.dict.gz and returns Map<lowercase-word, string[]>
// where each string is one full ARPABET pronunciation with stress
// digits retained (e.g. "B IH0 L OW1"). Multiple-pronunciation
// variants (word(2), word(3), ...) all attach under the base word.
// Apostrophe-leading entries ('em, 'twas, ...) are skipped.
export function loadCmuPronunciations(path) {
  const raw = gunzipSync(readFileSync(path)).toString('utf8');
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    let word = m[1];
    if (!/^[a-z]/.test(word)) continue;
    const vm = word.match(/^(.+?)\(\d+\)$/);
    if (vm) word = vm[1];
    const pron = m[2].trim();
    const existing = map.get(word);
    if (existing) existing.push(pron);
    else map.set(word, [pron]);
  }
  return map;
}

// Count vowel phonemes in a pronunciation string. Stress digits are
// stripped before lookup so AH0, AH1, AH2 all count as AH (vowel).
export function syllableCount(pron) {
  let n = 0;
  for (const ph of pron.split(/\s+/)) {
    if (VOWEL_PHONEMES.has(ph.replace(/\d+$/, ''))) n++;
  }
  return n;
}

// Extract the stress pattern from a pronunciation: concat the stress
// digit of each vowel phoneme in order. "B IH0 L OW1" → "01" (iamb).
// "G AA1 R D AH0 N" → "10" (trochee). Words with no vowels return "".
export function stressPattern(pron) {
  let out = '';
  for (const ph of pron.split(/\s+/)) {
    const base = ph.replace(/\d+$/, '');
    if (!VOWEL_PHONEMES.has(base)) continue;
    const m = ph.match(/(\d+)$/);
    out += m ? m[1] : '0';
  }
  return out;
}

// First phoneme (base, no stress digit). "B IH0 L OW1" → "B".
// "AA1 R K" → "AA". Returns '' for empty input.
export function firstPhoneme(pron) {
  const first = pron.trim().split(/\s+/)[0];
  return first ? first.replace(/\d+$/, '') : '';
}
