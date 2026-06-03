import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';
import { parseGrammar } from '../../js/src/grammar/parser.js';
import { loadGrammar, makeModel, modelStream } from '../../js/src/grammar/expand.js';
import { createFormatter } from '../../js/src/grammar/format.js';
import { emitMRules } from '../../js/src/grammar/expgram.js';
import { mulberry32 } from '../../js/src/random.js';
import { loadDictionary } from '../../js/src/dictionary.js';
import { encodeToString, decodeToBytes, loadDictFixture, fixtureURL } from './_helpers.js';

test('parser: simple rule with one alternative', () => {
  const g = parseGrammar('S: a b c ;');
  assert.equal(g.startSymbol, 'S');
  const alts = g.rules.get('S');
  assert.equal(alts.length, 1);
  assert.equal(alts[0].weight, 1);
  assert.deepEqual(alts[0].tokens.map(t => t.value), ['a', 'b', 'c']);
});

test('parser: multiple alternatives with @weights', () => {
  const g = parseGrammar('S: a @5 | b c @3 | d ;');
  const alts = g.rules.get('S');
  assert.equal(alts.length, 3);
  assert.deepEqual(alts.map(a => a.weight), [5, 3, 1]);
});

test('parser: punct tokens preserved verbatim', () => {
  const g = parseGrammar('S: {Cap} word {. n} ;');
  const tokens = g.rules.get('S')[0].tokens;
  assert.deepEqual(tokens.map(t => t.kind), ['punct', 'ref', 'punct']);
  assert.deepEqual(tokens.map(t => t.value), ['Cap', 'word', '. n']);
});

test('parser: comments stripped', () => {
  const g = parseGrammar('// hello\nS: a ; // trailing\n');
  assert.equal(g.rules.size, 1);
});

test('parser: identifiers with hyphens, digits, commas', () => {
  const g = parseGrammar('R-1: name_male,name_female num_cardinal_digits ;');
  const tokens = g.rules.get('R-1')[0].tokens;
  assert.equal(tokens[0].value, 'name_male,name_female');
  assert.equal(tokens[1].value, 'num_cardinal_digits');
});

test('parser: first rule is start symbol', () => {
  const g = parseGrammar('A: x ; B: y ; C: z ;');
  assert.equal(g.startSymbol, 'A');
});

test('parser: errors on unterminated punct, missing ;', () => {
  assert.throws(() => parseGrammar('S: {oops ;'), /unterminated/);
  assert.throws(() => parseGrammar('S: a'), /expected/);
});

test('expand: terminals pass through, nonterminals recurse', () => {
  const g = loadGrammar(parseGrammar('S: A B ; A: foo ; B: {Cap} bar ;'));
  const m = makeModel(g, { random: () => 0 });
  // Expanded model: foo (type) -> Cap (punct) -> bar (type)
  assert.deepEqual(m.map(x => x.kind), ['type', 'punct', 'type']);
  assert.deepEqual(m.map(x => x.kind === 'type' ? x.name : x.value), ['foo', 'Cap', 'bar']);
});

test('expand: weighted choice respects weights', () => {
  const g = loadGrammar(parseGrammar('S: low @1 | high @99 ;'));
  // With random→0, picks first alternative (cumulative weight 1 > 0).
  // With random→0.5, picks second.
  let m = makeModel(g, { random: () => 0 });
  assert.equal(m[0].name, 'low');
  m = makeModel(g, { random: () => 0.5 });
  assert.equal(m[0].name, 'high');
});

test('expand: skip+retry on overlong recursive grammars', () => {
  const g = loadGrammar(parseGrammar('S: a S @99 | x @1 ;'));
  // With our deterministic-ish RNG, eventually picks the terminator.
  const m = makeModel(g, { random: mulberry32(42), maxLength: 50 });
  assert.ok(m.length <= 50);
});

test('formatter: Cap, CAPSLOCKON, capslockoff, basic punct', () => {
  const f = createFormatter();
  f.emitWord('hello');
  f.emitPunct(',');
  f.emitWord('world');
  f.emitPunct('. n');
  f.emitPunct('Cap');
  f.emitWord('next');
  f.emitPunct(' ');
  f.emitPunct('CAPSLOCKON');
  f.emitWord('big');
  f.emitWord('shout');
  f.emitPunct('capslockoff');
  f.emitWord('quiet');
  const text = f.flush();
  assert.ok(text.includes('hello, world.'));
  assert.ok(text.includes('Next'));
  assert.ok(text.includes('BIG SHOUT') || text.includes('BIG') && text.includes('SHOUT'));
  assert.ok(text.includes('quiet'));
});

test('formatter: {^literal^} emits verbatim', () => {
  const f = createFormatter();
  f.emitWord('hello');
  f.emitPunct('^!! WAIT !!^');
  f.emitWord('done');
  assert.ok(f.flush().includes('!! WAIT !!'));
});

test('formatter: {^literal^} cannot fuse with neighbor WORD at decode time', () => {
  // Regression: the lexer's WORD_CHAR class is `[\p{Script=Latin}0-9&#@$%*+]`
  // and WORD-extender chars are `',.-:` (per WORD_RE EXT). A `^&^` or `^@k^`
  // quoted-literal followed directly by a dict-WORD used to glue into one
  // not-in-dict mega-WORD at decode time, dropping the bits the encoder
  // consumed for the adjacent slot, instant round-trip failure.
  const cases = [
    // [first emit, second emit, must-not-contain]
    [{ kind: 'word', v: 'hello' }, { kind: 'punct', v: '^&^' },     'hello&'],
    [{ kind: 'punct', v: '^&^' },  { kind: 'word', v: 'zero' },     '&zero'],
    [{ kind: 'word', v: 'q' },     { kind: 'punct', v: '^@k^' },    'q@k'],
    [{ kind: 'punct', v: '^@k^' }, { kind: 'word', v: 'q' },        '@kq'],
    [{ kind: 'word', v: 'd' },     { kind: 'punct', v: '^#^' },     'd#'],
    [{ kind: 'punct', v: '^*^' },  { kind: 'word', v: 'foo' },      '*foo'],
    // EXT chars: `.WORD_CHAR`, `-WORD_CHAR`, `'Latin` extend a preceding WORD
    [{ kind: 'word', v: 'theta' }, { kind: 'punct', v: '^.gamma^' }, 'theta.gamma'],
    [{ kind: 'word', v: 'foo' },   { kind: 'punct', v: "^'bar^" },   "foo'bar"],
    // Trailing-fusion: a literal's trail absorbs a following WORD via
    // WORD_RE prefix `[DdOoLl]'` / `'(?=Latin)` (apostrophe) or via
    // EXT `.WORD_CHAR` / `-WORD_CHAR` / `://WORD_CHAR` (after CORE).
    [{ kind: 'punct', v: "^l'^" },     { kind: 'word', v: 'fm' },    "l'fm"],
    [{ kind: 'punct', v: "^abc'^" },   { kind: 'word', v: 'def' },   "abc'def"],
    [{ kind: 'punct', v: "^'^" },      { kind: 'word', v: 'x' },     "'x"],
    [{ kind: 'punct', v: '^abc.^' },   { kind: 'word', v: 'def' },   'abc.def'],
    [{ kind: 'punct', v: '^abc-^' },   { kind: 'word', v: 'def' },   'abc-def'],
    [{ kind: 'punct', v: '^http://^' },{ kind: 'word', v: 'x' },     'http://x'],
    // Emoji-cluster fusion: adjacent pictographics (and RI/ZWJ/VS-16/
    // skin-tone modifier) collapse to one WORD via EMOJI_CLUSTER_RE.
    // A phrase like `pc 💻💻💻💻💻💻💻` followed by `^❤^` literal used
    // to glue an 8-emoji cluster that broke the phrase match.
    [{ kind: 'word', v: 'pc 💻💻💻💻💻💻💻' }, { kind: 'punct', v: '^❤^' }, '💻❤'],
    [{ kind: 'punct', v: '^❤^' },              { kind: 'word', v: '💻' },  '❤💻'],
    [{ kind: 'punct', v: '^💻^' },             { kind: 'punct', v: '^❤^' }, '💻❤'],
  ];
  for (const [a, b, banned] of cases) {
    const f = createFormatter();
    if (a.kind === 'word') f.emitWord(a.v); else f.emitPunct(a.v);
    if (b.kind === 'word') f.emitWord(b.v); else f.emitPunct(b.v);
    const out = f.flush();
    assert.ok(!out.includes(banned),
      `fusion regression: emit(${a.v}) + emit(${b.v}) produced "${out}" which contains "${banned}"`);
  }
  // Non-fusable starts (`.` followed by non-WORD_CHAR, e.g. `\n`) must NOT
  // get a preceding space, preserves the natural `word.\n` cover layout.
  const f = createFormatter();
  f.emitWord('foo');
  f.emitPunct('^.\n^');
  const out = f.flush();
  assert.ok(/foo\.\n/.test(out),
    `non-fusable EOS literal got over-eager spacing: "${out}"`);
});

test('expgram: emits rules for each atomic type', () => {
  const dict = loadDictionary({
    version: 2, name: 't',
    types: [
      { index: 1, name: 'a',   wordCount: 2 },
      { index: 2, name: 'b',   wordCount: 2 },
      { index: 3, name: 'a,b', wordCount: 4 },
    ],
    words: [],
  });
  const out = emitMRules(dict);
  assert.ok(out.includes('ma:'));
  assert.ok(out.includes('mb:'));
  // ma should reference both 'a' and 'a,b'; mb should reference both 'b' and 'a,b'.
  const maSection = out.split('ma:')[1].split(';')[0];
  assert.ok(maSection.includes('a @2'));
  assert.ok(maSection.includes('a,b @4'));
});

test('end-to-end: round-trip via real grammar on the mit card dict', async () => {
  const dict = loadDictFixture(fixtureURL('mit', import.meta.url));
  const grammar = loadGrammar(parseGrammar(readFileSync(new URL('../../grammars/mit-names.def', import.meta.url), 'utf8')));
  const payload = new Uint8Array(50);
  for (let i = 0; i < 50; i++) payload[i] = (i * 31 + 7) & 0xff;
  const stream = modelStream(grammar, { random: mulberry32(7) });
  const cover = await encodeToString(payload, dict, { modelStream: stream, randomSeed: 99 });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, payload);
});
