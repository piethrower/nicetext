#!/usr/bin/env node
// fetch.js: generate the per-type source files for every twlist
// rooted under this directory. Named `fetch.js` to mirror the
// convention used by other twlist source dirs (moby-pos,
// moby-thesaurus, wordnet, emoji16) even though this one generates
// rather than downloads; staging convention beats name-fits-action.
//
// Three downstream fixtures will consume these source files (the
// build-twlist-fixtures.js wire-up lands in a separate commit):
//
//   - num-form-preserved.twlist.tsv.gz: cardinal digit-form +
//     cardinal word-form + cardinal numeration + ordinal digit-form +
//     ordinal word-form + ordinal numeration + years + percent.
//     Form-preserving default. 45 types.
//   - num-form-interchangeable.twlist.tsv.gz: cardinal digits+words
//     (unified) + cardinal numeration + ordinal digits+words
//     (unified) + ordinal numeration + years + percent. Interchange
//     mode. 33 types.
//   - num-roman.twlist.tsv.gz: classical lowercase Roman 1..3999.
//     Opt-in (single-letter collision with English pronoun 'i' etc.).
//     6 types.
//
// The per-type source files emitted below are bare-word-per-line and
// keyed by filename = type name. build-twlist-fixtures.js wires
// subsets of these into the three fixtures listed above:
//
//   num-form-preserved <- num_cardinal_digits_*
//                      + num_cardinal_words_*
//                      + num_cardinal_numeration_words_*
//                      + num_ordinal_digits_*
//                      + num_ordinal_words_*
//                      + num_ordinal_numeration_words_*
//                      + num_years_*
//                      + num_percent_*
//
//   num-form-interchangeable <- num_cardinal_digits_words_*
//                             + num_cardinal_numeration_words_*
//                             + num_ordinal_digits_words_*
//                             + num_ordinal_numeration_words_*
//                             + num_years_*
//                             + num_percent_*
//
//   num-roman <- num_roman_digits_*
//
// All entries lowercase per the dict invariant. Word-phrases use
// single ASCII spaces between tokens (the phrase-fusion machinery
// from the phrase-and-charset arc re-pairs them at corpus / cover
// tokenize time).
//
// Re-run with: node fixture-src/twlist/numeric/fetch.js
// Idempotent; overwrites in place.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function emit(typeName, values) {
  const path = join(HERE, typeName);
  const body = values.join('\n') + '\n';
  writeFileSync(path, body);
  process.stderr.write(`wrote ${typeName} (${values.length} entries)\n`);
}

function range(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(String(i));
  return out;
}

// ---- Cardinal digits (0..999, bucketed by digit-count + teens) ----
const digits_0       = ['0'];
const digits_1_9     = range(1, 9);
const digits_10_12   = range(10, 12);
const digits_13_19   = range(13, 19);
const digits_20_99   = range(20, 99);
const digits_100_999 = range(100, 999);

emit('num_cardinal_digits_0',       digits_0);
emit('num_cardinal_digits_1_9',     digits_1_9);
emit('num_cardinal_digits_10_12',   digits_10_12);
emit('num_cardinal_digits_13_19',   digits_13_19);
emit('num_cardinal_digits_20_99',   digits_20_99);
emit('num_cardinal_digits_100_999', digits_100_999);

// ---- Cardinal words (0..999, bucketed in parallel to digits) ----
const ONES  = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const TEENS = ['ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS  = ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function cardinalWord(n) {
  if (n < 10)  return ONES[n];
  if (n < 20)  return TEENS[n - 10];
  const t = TENS[Math.floor(n / 10)];
  const o = n % 10;
  return o === 0 ? t : `${t}-${ONES[o]}`;
}
// Phrase form 100..999: '<ones> hundred [and] <0..99 cardinal>'.
// Round multiples have no 'and' variant; non-round multiples have
// both an American (no 'and') and a British ('and') variant.
function phrase100_999(n, useAnd) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = `${ONES[h]} hundred`;
  if (r === 0) return head;
  const tail = cardinalWord(r);
  return useAnd ? `${head} and ${tail}` : `${head} ${tail}`;
}

const words_0       = ['zero'];
const words_1_9     = ONES.slice(1, 10);              // one..nine
const words_10_12   = TEENS.slice(0, 3);              // ten..twelve
const words_13_19   = TEENS.slice(3, 10);             // thirteen..nineteen
const words_20_99   = (() => {
  const out = [];
  for (let n = 20; n <= 99; n++) out.push(cardinalWord(n));
  return out;
})();
const words_100_999 = (() => {
  const out = [];
  for (let n = 100; n <= 999; n++) out.push(phrase100_999(n, false)); // American
  for (let n = 100; n <= 999; n++) if (n % 100 !== 0) out.push(phrase100_999(n, true)); // British, non-round
  return out;
})();

emit('num_cardinal_words_0',       words_0);
emit('num_cardinal_words_1_9',     words_1_9);
emit('num_cardinal_words_10_12',   words_10_12);
emit('num_cardinal_words_13_19',   words_13_19);
emit('num_cardinal_words_20_99',   words_20_99);
emit('num_cardinal_words_100_999', words_100_999);

// ---- Unified digits + words (opt-in alternative; same buckets) ----
emit('num_cardinal_digits_words_0',       [...digits_0,       ...words_0]);
emit('num_cardinal_digits_words_1_9',     [...digits_1_9,     ...words_1_9]);
emit('num_cardinal_digits_words_10_12',   [...digits_10_12,   ...words_10_12]);
emit('num_cardinal_digits_words_13_19',   [...digits_13_19,   ...words_13_19]);
emit('num_cardinal_digits_words_20_99',   [...digits_20_99,   ...words_20_99]);
emit('num_cardinal_digits_words_100_999', [...digits_100_999, ...words_100_999]);

// ---- Cardinal numeration words, magnitude-split singular/plural pairs ----
emit('num_cardinal_numeration_words_hundred',  ['hundred',  'hundreds']);
emit('num_cardinal_numeration_words_thousand', ['thousand', 'thousands']);
emit('num_cardinal_numeration_words_million',  ['million',  'millions']);
emit('num_cardinal_numeration_words_billion',  ['billion',  'billions']);
emit('num_cardinal_numeration_words_trillion', ['trillion', 'trillions']);

// ---- Classical lowercase Roman numerals 1..3999 ----
// Subtractive notation: 4=iv, 9=ix, 40=xl, 90=xc, 400=cd, 900=cm.
const ROMAN_GLYPHS = [
  ['m', 1000], ['cm', 900], ['d', 500], ['cd', 400],
  ['c',  100], ['xc',  90], ['l',  50], ['xl',  40],
  ['x',   10], ['ix',   9], ['v',   5], ['iv',   4],
  ['i',    1],
];
function toRoman(n) {
  let s = '';
  for (const [glyph, val] of ROMAN_GLYPHS) {
    while (n >= val) { s += glyph; n -= val; }
  }
  return s;
}
function romanRange(lo, hi) {
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(toRoman(n));
  return out;
}
emit('num_roman_digits_1_9',       romanRange(1, 9));
emit('num_roman_digits_10_12',     romanRange(10, 12));
emit('num_roman_digits_13_19',     romanRange(13, 19));
emit('num_roman_digits_20_99',     romanRange(20, 99));
emit('num_roman_digits_100_999',   romanRange(100, 999));
emit('num_roman_digits_1000_3999', romanRange(1000, 3999));

// ---- Ordinal digits (0..999, bucketed in parallel to cardinals) ----
// Suffix rule: 11/12/13 → th; ending in 1 → st, 2 → nd, 3 → rd;
// everything else → th. Each form lexes as one WORD (digits + suffix
// letters are all WORD_CHAR).
function ordinalDigit(n) {
  const s = String(n);
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${s}th`;
  const last = n % 10;
  if (last === 1) return `${s}st`;
  if (last === 2) return `${s}nd`;
  if (last === 3) return `${s}rd`;
  return `${s}th`;
}
function ordDigitRange(lo, hi) {
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(ordinalDigit(n));
  return out;
}
const ord_digits_0       = [ordinalDigit(0)];      // 0th
const ord_digits_1_9     = ordDigitRange(1, 9);
const ord_digits_10_12   = ordDigitRange(10, 12);
const ord_digits_13_19   = ordDigitRange(13, 19);
const ord_digits_20_99   = ordDigitRange(20, 99);
const ord_digits_100_999 = ordDigitRange(100, 999);

emit('num_ordinal_digits_0',       ord_digits_0);
emit('num_ordinal_digits_1_9',     ord_digits_1_9);
emit('num_ordinal_digits_10_12',   ord_digits_10_12);
emit('num_ordinal_digits_13_19',   ord_digits_13_19);
emit('num_ordinal_digits_20_99',   ord_digits_20_99);
emit('num_ordinal_digits_100_999', ord_digits_100_999);

// ---- Ordinal words (0..999, parallel to cardinal words) ----
// 20..99 non-round forms use the cardinal-tens prefix + hyphen +
// ordinal-ones suffix: 'twenty-first', 'forty-third', 'ninety-ninth'.
// 100..999 round forms use 'hundredth' suffix: 'one hundredth',
// 'two hundredth', 'nine hundredth'. Non-round 100..999 use
// 'hundred' + cardinal-tens, then ordinal-ones tail, with optional
// British 'and' separator.
const ORDINAL_ONES  = ['zeroth','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth'];
const ORDINAL_TEENS = ['tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth'];
const ORDINAL_TENS  = ['', '', 'twentieth','thirtieth','fortieth','fiftieth','sixtieth','seventieth','eightieth','ninetieth'];
function ordinalWord(n) {
  if (n === 0) return 'zeroth';
  if (n < 10)  return ORDINAL_ONES[n];
  if (n < 20)  return ORDINAL_TEENS[n - 10];
  const t = Math.floor(n / 10);
  const o = n % 10;
  if (o === 0) return ORDINAL_TENS[t];
  return `${TENS[t]}-${ORDINAL_ONES[o]}`;
}
function phraseOrdinal100_999(n, useAnd) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (r === 0) return `${ONES[h]} hundredth`;
  const tail = ordinalWord(r);
  return useAnd ? `${ONES[h]} hundred and ${tail}` : `${ONES[h]} hundred ${tail}`;
}

const ord_words_0       = ['zeroth'];
const ord_words_1_9     = ORDINAL_ONES.slice(1, 10);
const ord_words_10_12   = ORDINAL_TEENS.slice(0, 3);
const ord_words_13_19   = ORDINAL_TEENS.slice(3, 10);
const ord_words_20_99   = (() => {
  const out = [];
  for (let n = 20; n <= 99; n++) out.push(ordinalWord(n));
  return out;
})();
const ord_words_100_999 = (() => {
  const out = [];
  for (let n = 100; n <= 999; n++) out.push(phraseOrdinal100_999(n, false)); // American
  for (let n = 100; n <= 999; n++) if (n % 100 !== 0) out.push(phraseOrdinal100_999(n, true)); // British, non-round
  return out;
})();

emit('num_ordinal_words_0',       ord_words_0);
emit('num_ordinal_words_1_9',     ord_words_1_9);
emit('num_ordinal_words_10_12',   ord_words_10_12);
emit('num_ordinal_words_13_19',   ord_words_13_19);
emit('num_ordinal_words_20_99',   ord_words_20_99);
emit('num_ordinal_words_100_999', ord_words_100_999);

// ---- Unified ordinal digits + words (opt-in alternative) ----
emit('num_ordinal_digits_words_0',       [...ord_digits_0,       ...ord_words_0]);
emit('num_ordinal_digits_words_1_9',     [...ord_digits_1_9,     ...ord_words_1_9]);
emit('num_ordinal_digits_words_10_12',   [...ord_digits_10_12,   ...ord_words_10_12]);
emit('num_ordinal_digits_words_13_19',   [...ord_digits_13_19,   ...ord_words_13_19]);
emit('num_ordinal_digits_words_20_99',   [...ord_digits_20_99,   ...ord_words_20_99]);
emit('num_ordinal_digits_words_100_999', [...ord_digits_100_999, ...ord_words_100_999]);

// ---- Ordinal numeration words (singletons, magnitude-split) ----
emit('num_ordinal_numeration_words_hundredth',  ['hundredth']);
emit('num_ordinal_numeration_words_thousandth', ['thousandth']);
emit('num_ordinal_numeration_words_millionth',  ['millionth']);
emit('num_ordinal_numeration_words_billionth',  ['billionth']);
emit('num_ordinal_numeration_words_trillionth', ['trillionth']);

// ---- Symbol-form percentages (0%..999%, parallel buckets) ----
// '%' is a WORD_CHAR in WORD_RE, so '5%' lexes as one WORD.
function pctRange(lo, hi) {
  const out = [];
  for (let n = lo; n <= hi; n++) out.push(`${n}%`);
  return out;
}
emit('num_percent_0',       pctRange(0, 0));
emit('num_percent_1_9',     pctRange(1, 9));
emit('num_percent_10_12',   pctRange(10, 12));
emit('num_percent_13_19',   pctRange(13, 19));
emit('num_percent_20_99',   pctRange(20, 99));
emit('num_percent_100_999', pctRange(100, 999));

// ---- Years: bare 4-digit + era-tagged phrases ----
emit('num_years_4_digit', range(1000, 2099));
emit('num_years_bc',  range(1, 1000).map(n => `${n} bc`));
emit('num_years_bce', range(1, 1000).map(n => `${n} bce`));
emit('num_years_ad',  range(1, 2099).map(n => `${n} ad`));
emit('num_years_ce',  range(1, 2099).map(n => `${n} ce`));
