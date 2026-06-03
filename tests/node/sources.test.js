// Tests for js/src/builder/sources.js parseTwlistLines: locks the
// rule 0/1/2 ingestion gates (comment lines skipped; exactly one
// whitespace run between type and word; word column lexes to a single
// WORD token equal to itself, i.e. lexer-as-validator). The shipped
// .twlist.tsv.gz fixtures were filtered through these same gates at
// bake time, so this file covers the rules at the unit level rather
// than re-measuring fixture rejection rates.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { parseTwlistLines } from '../../js/src/builder/sources.js';

// Each row: [input line, human label, expected accepted-count (0 or 1)].
//
// Step 4 of the phrase-and-charset arc relaxed rule 1: the value column
// may contain internal whitespace (multi-word phrase entries). The
// FIRST whitespace run still separates type from value; type still
// can't contain whitespace (the regex anchors `\S+` at start). Values
// like `with space\tword` admit as a 3-WORD phrase; values containing
// PUNCT or EOS still reject via rule 2.
const cases = [
  ['# comment line',                 'comment',                 0],
  ['',                                'blank',                   0],
  ['type\tword',                      'plain TSV',               1],
  ['type word',                       'space-delimited',         1],
  ['type   word',                     'column-aligned spaces',   1],
  ['type\t\tword',                    'tab+tab run',             1],
  ['type \tword',                     'space+tab run',           1],
  ['type\ta capella',                 '2-word phrase value',     1],
  ['type\ta la carte',                '3-word phrase value',     1],
  ['type\tword with space',           'multi-word phrase',       1],
  ['type\tword\textra',               'three-column phrase',     1],
  ['type\tword!',                     'punct in word',           0],
  ['type\tword. suffix',              'EOS in middle',           0],
  ['type\tword.suffix',               'period in word',          1],
  ["type\talice's",                   'apostrophe',              1],
  ['type\tatom-bomb',                 'hyphen',                  1],
  ['type\t',                          'empty word',              0],
  ['\tword',                          'empty type',              0],
  ['type\tword\r',                    'trailing CR',             1],
  ['  type\tword',                    'leading whitespace',      0],
];

test('parseTwlistLines: rule 0/1/2 gates', async (t) => {
  for (const [line, label, expected] of cases) {
    await t.test(label, () => {
      assert.equal(
        parseTwlistLines(line).length,
        expected,
        `expected ${expected} for ${JSON.stringify(line)}`,
      );
    });
  }
});

test('parseTwlistLines: reportRejections gives line indices and reasons', () => {
  // Step 4 admits multi-word phrase values, so rule-1 'malformed' now
  // only fires for lines that don't have any whitespace separator at
  // all (or that have leading whitespace, empty type, or empty value).
  const text = [
    '# header',                          // 0
    'noun\tcat',                         // 1
    'noWhitespaceSeparator',             // 2 malformed (rule 1)
    'noun\tword!',                       // 3 lexer-rejected (rule 2)
    'noun\thello',                       // 4
    'adv\ta capella',                    // 5, 2-word phrase, accepted
  ].join('\n');
  const { entries, rejections } = parseTwlistLines(text, { reportRejections: true });
  assert.deepEqual(entries.map(e => e.word), ['cat', 'hello', 'a capella']);
  assert.deepEqual(entries.map(e => e.lineIndex), [1, 4, 5]);
  assert.equal(rejections.length, 2);
  assert.deepEqual(rejections[0], { lineIndex: 2, line: 'noWhitespaceSeparator', reason: 'malformed' });
  assert.deepEqual(rejections[1], { lineIndex: 3, line: 'noun\tword!', reason: 'lexer-rejected' });
});

test('parseTwlistLines: reportRejections does NOT report comments or blanks', () => {
  const text = '# c\n\n# c2\nnoun\tcat\n';
  const { entries, rejections } = parseTwlistLines(text, { reportRejections: true });
  assert.deepEqual(entries.map(e => e.word), ['cat']);
  assert.equal(rejections.length, 0);
});

test('parseTwlistLines: non-Latin word values reject via rule 2 (no special-case code)', () => {
  // Phrase-and-charset Step 3 spec claim: any TW-list line whose word
  // column contains a non-Latin-non-emoji character fails rule 2 (lexer
  // round-trip) automatically, the word would lex as PUNCT (catch-all)
  // rather than as a single WORD token equal to itself. Same gate that
  // rejects multi-word entries today; no per-script logic.
  const text = [
    'noun\thello',     // accepted. Latin
    'noun\tcafé',      // accepted. Latin-script (accented)
    'noun\t你好',       // rejected. CJK lexes as PUNCT
    'noun\tПривет',    // rejected. Cyrillic lexes as PUNCT
    'noun\tΑθήνα',     // rejected. Greek lexes as PUNCT
  ].join('\n');
  const { entries, rejections } = parseTwlistLines(text, { reportRejections: true });
  assert.deepEqual(entries.map(e => e.word), ['hello', 'café']);
  assert.equal(rejections.length, 3);
  for (const r of rejections) {
    assert.equal(r.reason, 'lexer-rejected');
  }
});

test('parseTwlistLines: default shape unchanged when opts absent', () => {
  const text = 'noun\tcat\nbad\n';
  const result = parseTwlistLines(text);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].word, 'cat');
});
