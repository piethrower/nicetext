import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { tokenize, tokenizeArray, TOKEN } from '../../js/src/lexer.js';

const wordsOf = (text) => tokenizeArray(text).filter(t => t.type === TOKEN.WORD).map(t => t.value);
const typesOf = (text) => tokenizeArray(text).map(t => t.type);

test('lexer: simple words separated by spaces', () => {
  assert.deepEqual(wordsOf('the cat sat on the mat'), ['the', 'cat', 'sat', 'on', 'the', 'mat']);
});

test('lexer: contractions stay attached', () => {
  assert.deepEqual(wordsOf("can't won't they're we've don't"),
    ["can't", "won't", "they're", "we've", "don't"]);
});

test('lexer: multi-segment apostrophe runs stay one word', () => {
  // The earlier `'[Latin]{0,2}` cap split these mid-word; the
  // unbounded latin-after-apostrophe suffix keeps them whole.
  assert.deepEqual(wordsOf("y'all'd've rock'n'roll fish'n'chips"),
    ["y'all'd've", "rock'n'roll", "fish'n'chips"]);
});

test('lexer: apostrophe-suffix segments longer than 2 letters', () => {
  // Suffix length is unbounded (was capped at 2). `'clock`-style
  // suffixes that exceed the old cap stay attached to their CORE.
  assert.deepEqual(wordsOf("ma'amselle could've shouldn't've"),
    ["ma'amselle", "could've", "shouldn't've"]);
});

test('lexer: leading apostrophe is kept when a Latin letter follows', () => {
  // Dialect/archaic forms: the leading `'` was previously skipped
  // by pos++ because WORD_RE required CORE to start. PREFIX now
  // includes `'(?=Latin)` so 'tis, 'twas, 'cause, 'em, 'til, 'bout
  // keep the apostrophe and stay one word.
  assert.deepEqual(wordsOf("'tis 'twas 'cause 'em 'til 'bout"),
    ["'tis", "'twas", "'cause", "'em", "'til", "'bout"]);
});

test('lexer: stray apostrophe with no Latin letter following is unaffected', () => {
  // The lookahead-Latin guard keeps the leading-quote rule from
  // absorbing a stray `'` followed by non-letter content. `'90s`
  // is digit-after-quote (out of scope for the Latin lookahead),
  // and a bare `'` between non-word chars stays a no-match skip.
  assert.deepEqual(wordsOf("'90s"), ["90s"]);
  assert.deepEqual(wordsOf("year ' alone"), ["year", "alone"]);
});

test('lexer: overlong WORD truncates, does not silent-skip bytes', () => {
  // Pathological EXT chain: WORD_RE matches the whole 101-char run.
  // With maxWordLength=20 the earlier behavior nulled the match and
  // pos++'d at every byte, producing a parade of single-`.` EOS
  // tokens AND silently dropping the WORD chars. After the fix the
  // run lexes as a series of length-≤20 WORDs covering every byte
  // in the long span (cap=20, span=101 → 5 full + 1 partial).
  const longSpan = 'a' + '.b'.repeat(50); // length 101
  const mixed = `hello ${longSpan} world`;
  const tokens = [...tokenize(mixed, { maxWordLength: 20 })];
  // No EOS tokens, the bug case used to spam them.
  assert.equal(tokens.filter(t => t.type === TOKEN.EOS).length, 0);
  // Surrounding context survives intact.
  const words = tokens.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.equal(words[0], 'hello');
  assert.equal(words[words.length - 1], 'world');
  // Inner-span WORDs all fit within the cap.
  for (const w of words.slice(1, -1)) {
    assert.ok(w.length <= 20, `inner word "${w}" exceeds cap`);
  }
  // Byte accounting: every char of longSpan is covered by emitted
  // WORD value bytes (no silent drops). Sum of inner-WORD lengths
  // must equal longSpan length.
  const innerLen = words.slice(1, -1).reduce((s, w) => s + w.length, 0);
  assert.equal(innerLen, longSpan.length);
});

test('lexer: D\' / O\' / L\' name prefixes', () => {
  assert.deepEqual(wordsOf("D'Artagnan O'Brien L'Enfant"),
    ["D'Artagnan", "O'Brien", "L'Enfant"]);
});

test('lexer: hyphens and dots inside words', () => {
  assert.deepEqual(wordsOf('e-mail version.1.2 well-known'),
    ['e-mail', 'version.1.2', 'well-known']);
});

test('lexer: URLs', () => {
  assert.deepEqual(wordsOf('visit http://example.com today'),
    ['visit', 'http://example.com', 'today']);
});

test('lexer: end-of-sentence on .?!', () => {
  const types = typesOf('hi! bye? done.');
  assert.equal(types.filter(t => t === TOKEN.WORD).length, 3);
  assert.equal(types.filter(t => t === TOKEN.EOS).length, 3);
});

test('lexer: ellipsis is punctuation, not EOS', () => {
  const toks = tokenizeArray('wait... here');
  // Expect: WORD("wait") PUNCT("...") WORD("here")
  assert.equal(toks[0].type, TOKEN.WORD);
  assert.equal(toks[0].value, 'wait');
  assert.equal(toks[1].type, TOKEN.PUNCT);
  assert.ok(toks[1].value.startsWith('..'));
  assert.equal(toks[2].type, TOKEN.WORD);
  assert.equal(toks[2].value, 'here');
});

test('lexer: blank line is end-of-sentence', () => {
  const types = typesOf('one two\n\nthree four');
  assert.ok(types.includes(TOKEN.EOS));
});

test('lexer: forward slash is a preserved literal PUNCT', () => {
  // Bare '/' between WORDs used to silently pos++; it now lexes as a
  // single-char PUNCT so dates / conjunctions / fractions keep their
  // slashes through round-trip.
  const t = tokenizeArray('1/15/2024 and/or 1/2');
  const types = t.map(x => x.type);
  const values = t.map(x => x.value);
  // Expect 3 numeric dates + slashes, then 'and', '/', 'or', then '1', '/', '2'.
  // (Tokens are interleaved with WHITESPACE only when the gap is >1 space.)
  assert.deepEqual(values.filter((_, i) => types[i] === TOKEN.PUNCT),
    ['/', '/', '/', '/']);
  assert.deepEqual(values.filter((_, i) => types[i] === TOKEN.WORD),
    ['1', '15', '2024', 'and', 'or', '1', '2']);
});

test('lexer: URL `://` EXT still fuses correctly (slash inside WORD)', () => {
  // The URL pattern is matched as one WORD via WORD_RE's `://` EXT
  // alternation; PUNCT_RE doesn't get a turn at those slashes
  // because the longer WORD match wins.
  const t = tokenizeArray('see http://example.com/path now');
  const words = t.filter(x => x.type === TOKEN.WORD).map(x => x.value);
  // 'http://example.com' fuses; then PUNCT '/' then WORD 'path' (the
  // URL path lives outside the `://` alternation).
  assert.equal(words[1], 'http://example.com');
  assert.equal(words[2], 'path');
  const slashes = t.filter(x => x.type === TOKEN.PUNCT && x.value === '/');
  assert.equal(slashes.length, 1);
});

test('lexer: punctuation chars', () => {
  const t = tokenizeArray('one, two; three: four "five" (six)');
  const punct = t.filter(x => x.type === TOKEN.PUNCT).map(x => x.value);
  assert.ok(punct.includes(','));
  assert.ok(punct.includes(';'));
  assert.ok(punct.includes(':'));
  assert.ok(punct.includes('"'));
  assert.ok(punct.includes('('));
  assert.ok(punct.includes(')'));
});

test('lexer: previously-skipped chars become catch-all PUNCT, words unchanged', () => {
  // Pre-Step-3, curly braces fell through to pos++ silently. Step 3's
  // catch-all PUNCT picks them up so corpora preserve them in cover
  // (verbatim, zero bits). The WORD stream is unaffected.
  assert.deepEqual(wordsOf('hello {weird} world'), ['hello', 'weird', 'world']);
  const toks = tokenizeArray('hello {weird} world');
  const punct = toks.filter(t => t.type === TOKEN.PUNCT).map(t => t.value);
  assert.ok(punct.includes('{'), `expected '{' in puncts: ${JSON.stringify(punct)}`);
  assert.ok(punct.includes('}'), `expected '}' in puncts: ${JSON.stringify(punct)}`);
});

test('lexer: numbers count as words', () => {
  assert.deepEqual(wordsOf('I have 3 cats and 27 fish'),
    ['I', 'have', '3', 'cats', 'and', '27', 'fish']);
});

test('lexer: empty input yields no tokens', () => {
  assert.deepEqual(tokenizeArray(''), []);
});

test('lexer: single word, no terminator', () => {
  assert.deepEqual(wordsOf('hello'), ['hello']);
});

test('lexer: single space between words emits no WHITESPACE token', () => {
  const toks = tokenizeArray('one two three');
  assert.equal(toks.filter(t => t.type === TOKEN.WHITESPACE).length, 0);
  assert.equal(toks.filter(t => t.type === TOKEN.WORD).length, 3);
});

test('lexer: multi-space run between words emits one WHITESPACE token', () => {
  const toks = tokenizeArray('one   two');
  const ws = toks.filter(t => t.type === TOKEN.WHITESPACE);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].value, '   ');
});

test('lexer: tab between words emits WHITESPACE token', () => {
  const toks = tokenizeArray('one\ttwo');
  const ws = toks.filter(t => t.type === TOKEN.WHITESPACE);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].value, '\t');
});

test('lexer: mid-sentence single newline emits WHITESPACE token', () => {
  const toks = tokenizeArray('one\ntwo');
  const ws = toks.filter(t => t.type === TOKEN.WHITESPACE);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].value, '\n');
});

test('lexer: indentation run after newline is one WHITESPACE token', () => {
  const toks = tokenizeArray('one\n    two');
  const ws = toks.filter(t => t.type === TOKEN.WHITESPACE);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].value, '\n    ');
});

test('lexer: blank line still lexes as EOS, not WHITESPACE', () => {
  const toks = tokenizeArray('one\n\ntwo');
  // \n{2,} is the EOS alternative; WHITESPACE_RE comes after EOS_RE in
  // PATTERNS, so on tied length EOS wins.
  assert.equal(toks.filter(t => t.type === TOKEN.WHITESPACE).length, 0);
  assert.equal(toks.filter(t => t.type === TOKEN.EOS).length, 1);
});

test('lexer: EOS preserves trailing whitespace verbatim', () => {
  // EOS_RE eagerly consumes whitespace after a terminator via [\"\\s]*\\n*,
  // so .\\n            (period + newline + 12 spaces) is one EOS token.
  const toks = tokenizeArray('hello.\n            world');
  const eos = toks.filter(t => t.type === TOKEN.EOS);
  assert.equal(eos.length, 1);
  assert.equal(eos[0].value, '.\n            ');
});

test('lexer: !!! preserves run length in EOS value', () => {
  const toks = tokenizeArray('wow!!! cool');
  const eos = toks.filter(t => t.type === TOKEN.EOS);
  assert.equal(eos.length, 1);
  assert.equal(eos[0].value.startsWith('!!!'), true);
});

test('lexer: ?\\n\\n is one EOS token via the \\n{2,} alternative', () => {
  const toks = tokenizeArray('really?\n\nyes');
  const eos = toks.filter(t => t.type === TOKEN.EOS);
  assert.equal(eos.length, 1);
  // Could be `?\n\n` (terminator + whitespace alternative) or `?` then \n\n;
  // EOS_RE's first alternative greedily consumes the whitespace, so it
  // should be the full `?\n\n` value.
  assert.equal(eos[0].value, '?\n\n');
});

// Step 3: WORD_CHAR widened to \p{Script=Latin}, accented Latin lexes.
test('lexer: accented Latin words lex as single WORD tokens', () => {
  assert.deepEqual(wordsOf('café naïve Dvořák'), ['café', 'naïve', 'Dvořák']);
});

test('lexer: Latin contraction with accented suffix round-trips', () => {
  // APOS_SUFFIX broadened to allow Latin-script chars after the apostrophe.
  // (Most natural-text contractions are still ASCII; this just protects
  // any accented-Latin contraction the corpus might carry.)
  const toks = tokenizeArray("café's price");
  const words = toks.filter(t => t.type === TOKEN.WORD).map(t => t.value);
  assert.deepEqual(words, ["café's", 'price']);
});

// Step 3: catch-all PUNCT for non-Latin-non-emoji UTF-8.
test('lexer: CJK run lexes as one PUNCT catch-all token', () => {
  const toks = tokenizeArray('hello 你好世界 world');
  const cjk = toks.filter(t => t.type === TOKEN.PUNCT && t.value === '你好世界');
  assert.equal(cjk.length, 1, `expected one PUNCT '你好世界': ${JSON.stringify(toks.map(t => [t.type, t.value]))}`);
});

test('lexer: Cyrillic run lexes as one PUNCT catch-all token', () => {
  const toks = tokenizeArray('hello Привет world');
  const cyr = toks.filter(t => t.type === TOKEN.PUNCT && t.value === 'Привет');
  assert.equal(cyr.length, 1);
});

test('lexer: long CJK paragraph caps at ABSOLUTE_TOKEN_CAP code units', () => {
  // 300-char CJK run, well over the 256 cap. Should split into multiple
  // PUNCT tokens, none longer than 256 UTF-16 code units.
  const cjk = '中'.repeat(300);
  const toks = tokenizeArray(cjk);
  for (const t of toks) {
    assert.ok(t.value.length <= 256, `token length ${t.value.length} exceeds cap`);
  }
  // All chars accounted for in PUNCT tokens (no silent skip).
  const recovered = toks.filter(t => t.type === TOKEN.PUNCT).map(t => t.value).join('');
  assert.equal(recovered, cjk);
});

test('lexer: mixed Latin + CJK + Latin produces WORD + PUNCT + WORD', () => {
  const toks = tokenizeArray('hello 中文 world');
  const types = toks.filter(t => t.type === TOKEN.WORD || t.type === TOKEN.PUNCT)
                    .map(t => [t.type, t.value]);
  assert.deepEqual(types, [
    [TOKEN.WORD, 'hello'],
    [TOKEN.PUNCT, '中文'],
    [TOKEN.WORD, 'world'],
  ]);
});

// Step 5: emoji clusters lex as WORD (§C reclassification).
test('lexer: single supplementary-plane emoji is one WORD cluster', () => {
  // 🌹 = U+1F339, one grapheme cluster, 2 UTF-16 code units, 4 UTF-8 bytes.
  const toks = tokenizeArray('a 🌹 b');
  const emoji = toks.filter(t => t.type === TOKEN.WORD && t.value === '🌹');
  assert.equal(emoji.length, 1);
});

test('lexer: BMP emoji + variation selector is one WORD cluster', () => {
  // 🌧️ = U+1F327 + U+FE0F, one cluster, 3 UTF-16 code units.
  const toks = tokenizeArray('a 🌧️ b');
  const emoji = toks.filter(t => t.type === TOKEN.WORD && t.value === '🌧️');
  assert.equal(emoji.length, 1, `expected single 🌧️ cluster; got ${JSON.stringify(toks.map(t => t.value))}`);
});

test('lexer: skin-tone-modified emoji is one WORD cluster', () => {
  // 👋🏽 = U+1F44B + U+1F3FD, one cluster, 4 UTF-16 code units.
  const toks = tokenizeArray('a 👋🏽 b');
  const emoji = toks.filter(t => t.type === TOKEN.WORD && t.value === '👋🏽');
  assert.equal(emoji.length, 1);
});

test('lexer: regional-indicator flag pair is one WORD cluster', () => {
  // 🇺🇸 = U+1F1FA + U+1F1F8, one cluster, 4 UTF-16 code units.
  const toks = tokenizeArray('a 🇺🇸 b');
  const flag = toks.filter(t => t.type === TOKEN.WORD && t.value === '🇺🇸');
  assert.equal(flag.length, 1);
});

test('lexer: ZWJ family emoji is one WORD cluster', () => {
  // 👨‍👩‍👧‍👦 = U+1F468 ZWJ U+1F469 ZWJ U+1F467 ZWJ U+1F466,
  // one cluster, 11 UTF-16 code units, 25 UTF-8 bytes.
  const toks = tokenizeArray('a 👨‍👩‍👧‍👦 b');
  const family = toks.filter(t => t.type === TOKEN.WORD && t.value === '👨‍👩‍👧‍👦');
  assert.equal(family.length, 1, `expected one ZWJ-family cluster; got ${JSON.stringify(toks.map(t => t.value))}`);
});

test('lexer: gender-variant ZWJ emoji is one WORD cluster', () => {
  // 🧑‍🌾 = U+1F9D1 ZWJ U+1F33E (gender-neutral farmer)
  const toks = tokenizeArray('a 🧑‍🌾 b');
  const farmer = toks.filter(t => t.type === TOKEN.WORD && t.value === '🧑‍🌾');
  assert.equal(farmer.length, 1);
});
