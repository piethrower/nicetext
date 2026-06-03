import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { listWords, listWordsWithCounts } from '../../js/src/builder/listword.js';
import { txtToTwlist, parseWordList } from '../../js/src/builder/txt2dct.js';
import { sortDict } from '../../js/src/builder/sortdct.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { REDACTION_MARKER } from '../../js/src/builder/redaction.js';

// sortDict now auto-prepends the redaction marker singleton (every
// twlist consumer applies redactTwlistEntries, see redaction.js).
// Tests that compare the raw entry list strip the marker here so
// they only assert on the business-logic content. A separate test
// covers the marker injection contract itself.
function stripMarker(entries) {
  return entries.filter(e => e.word !== REDACTION_MARKER);
}

test('listword: extracts and lowercases unique words', async () => {
  const text = 'The cat sat. THE cat ran! The CAT slept.';
  assert.deepEqual(await listWords(text), ['cat', 'ran', 'sat', 'slept', 'the']);
});

test('listword: counts frequencies', async () => {
  const text = 'cat dog cat fish dog cat';
  const counts = await listWordsWithCounts('cat dog cat fish dog cat');
  assert.equal(counts.get('cat'), 3);
  assert.equal(counts.get('dog'), 2);
  assert.equal(counts.get('fish'), 1);
});

test('parseWordList: skips comments and blanks', async () => {
  const text = '# header\nalpha\n\n# mid-comment\nbeta\ngamma\n';
  assert.deepEqual(parseWordList(text), ['alpha', 'beta', 'gamma']);
});

test('txt2dct: rejects type names with comma or whitespace', async () => {
  assert.throws(() => txtToTwlist([{ typeName: 'a,b', words: ['x'] }]), /comma/);
  assert.throws(() => txtToTwlist([{ typeName: 'a b', words: ['x'] }]), /comma|whitespace/);
});

test('txt2dct: produces flat TWLIST', async () => {
  const t = txtToTwlist([
    { typeName: 'name', words: ['Alice', 'Bob'] },
    { typeName: 'verb', words: ['ran', 'jumped'] },
  ]);
  assert.deepEqual(t, [
    { type: 'name', word: 'Alice' },
    { type: 'name', word: 'Bob' },
    { type: 'verb', word: 'ran' },
    { type: 'verb', word: 'jumped' },
  ]);
});

test('sortdct: lowercases words', async () => {
  const out = stripMarker(await sortDict([{ type: 'noun', word: 'Cat' }]));
  assert.deepEqual(out, [{ type: 'noun', word: 'cat' }]);
});

test('sortdct: auto-injects REDACTED marker singleton', async () => {
  const out = await sortDict([{ type: 'noun', word: 'cat' }]);
  const marker = out.find(e => e.word === REDACTION_MARKER);
  assert.ok(marker, 'REDACTED marker singleton should be present');
  assert.equal(marker.type, 'REDACTED');
});

test('sortdct: merges types when a word appears in multiple', async () => {
  const out = await sortDict([
    { type: 'name_male', word: 'chris' },
    { type: 'name_female', word: 'chris' },
    { type: 'name_male', word: 'bob' },
  ]);
  // chris should now be a single entry under "name_female,name_male"
  const chris = out.find(e => e.word === 'chris');
  assert.equal(chris.type, 'name_female,name_male');
  // bob stays under name_male
  const bob = out.find(e => e.word === 'bob');
  assert.equal(bob.type, 'name_male');
});

test('sortdct: keeps multi-word phrases', async () => {
  // Phrases are first-class entries; the lexer's phraseFuse recognizes
  // them on the cover side. sortDict no longer drops whitespace-bearing
  // words.
  const out = stripMarker(await sortDict([
    { type: 'phrase', word: 'good day' },
    { type: 'noun', word: 'cat' },
  ]));
  assert.equal(out.length, 2);
  const phrase = out.find(e => e.word === 'good day');
  assert.ok(phrase, 'phrase entry should be kept');
  assert.equal(phrase.type, 'phrase');
});

test('sortdct: deduplicates same word in same type', async () => {
  const out = stripMarker(await sortDict([
    { type: 'noun', word: 'cat' },
    { type: 'noun', word: 'CAT' },
    { type: 'noun', word: 'cat' },
  ]));
  assert.equal(out.length, 1);
});

test('sortdct: input with already-merged type (commas) re-merges correctly', async () => {
  const out = stripMarker(await sortDict([
    { type: 'a,b', word: 'x' },
    { type: 'c', word: 'x' },
  ]));
  assert.equal(out[0].type, 'a,b,c');
});

test('dct2mstr: every word reachable via Huffman (no truncation)', async () => {
  // 5 verbs, no frequencies → uniform Huffman → all 5 reachable
  // (3 with 2-bit codes + 2 with 3-bit codes, or similar shape).
  const mtwlist = [
    { type: 'verb', word: 'run' },
    { type: 'verb', word: 'jump' },
    { type: 'verb', word: 'sit' },
    { type: 'verb', word: 'lie' },
    { type: 'verb', word: 'fly' },
  ];
  const dict = buildDictionary(mtwlist, { name: 'test' });
  assert.equal(dict.types.length, 1);
  assert.equal(dict.types[0].wordCount, 5);
  assert.equal(dict.words.length, 5);
  // Every word from input survives.
  assert.deepEqual(dict.words.map(w => w.word).sort(), ['fly', 'jump', 'lie', 'run', 'sit']);
  // Every word has a valid (code, bits) pair.
  for (const w of dict.words) {
    assert.ok(typeof w.code === 'number' && typeof w.bits === 'number');
    assert.ok(w.bits >= 1, `${w.word} should have at least 1 bit`);
  }
});

test('dct2mstr: single-word type has bits 0 and code 0', async () => {
  const dict = buildDictionary([{ type: 'unique', word: 'hello' }]);
  assert.equal(dict.types[0].wordCount, 1);
  assert.equal(dict.words[0].code, 0);
  assert.equal(dict.words[0].bits, 0);
});

test('dct2mstr: type indices are sequential starting at 1', async () => {
  const dict = buildDictionary([
    { type: 'b', word: 'x' },
    { type: 'a', word: 'y' },
    { type: 'c', word: 'z' },
  ]);
  // Types are output sorted alphabetically.
  assert.deepEqual(dict.types.map(t => t.name), ['a', 'b', 'c']);
  assert.deepEqual(dict.types.map(t => t.index), [1, 2, 3]);
});

test('dct2mstr: every word in the output has a unique (typeIndex, bits, code)', async () => {
  const mtwlist = [];
  for (let i = 0; i < 100; i++) mtwlist.push({ type: 'big', word: `w${i.toString().padStart(3, '0')}` });
  for (let i = 0; i < 7; i++) mtwlist.push({ type: 'small', word: `s${i}` });
  const dict = buildDictionary(mtwlist);
  const seen = new Set();
  for (const w of dict.words) {
    const key = `${w.typeIndex}:${w.bits}:${w.code}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
});

test('dct2mstr: frequency-weighted gives shorter codes to common words', async () => {
  const mtwlist = [
    { type: 'noun', word: 'the' },
    { type: 'noun', word: 'rare1' },
    { type: 'noun', word: 'rare2' },
    { type: 'noun', word: 'rare3' },
  ];
  const freq = new Map([['the', 1000], ['rare1', 1], ['rare2', 1], ['rare3', 1]]);
  const dict = buildDictionary(mtwlist, { frequencies: freq });
  const theEntry = dict.words.find(w => w.word === 'the');
  const otherEntries = dict.words.filter(w => w.word !== 'the');
  for (const o of otherEntries) {
    assert.ok(theEntry.bits < o.bits,
      `"the" (bits=${theEntry.bits}) should be shorter than "${o.word}" (bits=${o.bits})`);
  }
});

test('dct2mstr: tieBreak=alpha-asc (default) gives alpha-late words shallow slots', async () => {
  // 3 words, lengths 1/2/3, all uniform weight=1. Per the heap's
  // `order ASC` tie-break, alpha-asc input puts "ccc" last → shallow.
  const dict = buildDictionary([
    { type: 't', word: 'a' },
    { type: 't', word: 'bb' },
    { type: 't', word: 'ccc' },
  ]);
  const byWord = Object.fromEntries(dict.words.map(w => [w.word, w.bits]));
  assert.equal(byWord.ccc, 1, 'alpha-late "ccc" should be at depth 1');
  assert.equal(byWord.a,   2, '"a" deeper');
  assert.equal(byWord.bb,  2, '"bb" deeper');
});

test('dct2mstr: tieBreak=length-desc gives shorter words shallow slots', async () => {
  // Same 3 words, length-desc input: "ccc" inserted first (deepest),
  // "a" inserted last (shallowest). Reverses the alpha-asc bias.
  const dict = buildDictionary([
    { type: 't', word: 'a' },
    { type: 't', word: 'bb' },
    { type: 't', word: 'ccc' },
  ], { tieBreak: 'length-desc' });
  const byWord = Object.fromEntries(dict.words.map(w => [w.word, w.bits]));
  assert.equal(byWord.a,   1, 'shortest "a" should be at depth 1');
  assert.equal(byWord.bb,  2, '"bb" deeper');
  assert.equal(byWord.ccc, 2, '"ccc" deeper');
});

test('dct2mstr: tieBreak=length-desc preserves Kraft + every word reachable', async () => {
  // Larger sanity: 7 words spread across lengths, mixed weights.
  const mtwlist = [
    { type: 'verb', word: 'run' },
    { type: 'verb', word: 'jump' },
    { type: 'verb', word: 'sit' },
    { type: 'verb', word: 'lie' },
    { type: 'verb', word: 'fly' },
    { type: 'verb', word: 'amble' },
    { type: 'verb', word: 'sprint' },
  ];
  const dict = buildDictionary(mtwlist, { tieBreak: 'length-desc' });
  assert.equal(dict.words.length, 7);
  // Every word has a valid (code, bits) pair.
  for (const w of dict.words) {
    assert.ok(typeof w.code === 'number' && typeof w.bits === 'number');
    assert.ok(w.bits >= 1, `${w.word} should have at least 1 bit`);
  }
  // Kraft equality holds (verifyHuffman runs inside buildDictionary).
  let kraft = 0;
  for (const w of dict.words) kraft += Math.pow(2, -w.bits);
  assert.ok(Math.abs(kraft - 1) < 1e-9, `Kraft sum = ${kraft}`);
});

test('end-to-end: txt2dct → sortdct → dct2mstr produces a valid dict', async () => {
  const fileWords = [
    { typeName: 'name_male', words: ['Bob', 'Tom', 'chris', 'Ned'] },
    { typeName: 'name_female', words: ['Jody', 'Tracy', 'Chris', 'Lisa'] },
  ];
  const twlist = txtToTwlist(fileWords);
  const mtwlist = await sortDict(twlist);
  const dict = buildDictionary(mtwlist, { name: 'mit-mini' });

  // chris should be under merged type "name_female,name_male"
  const chrisEntry = dict.words.find(w => w.word === 'chris');
  const chrisType = dict.types.find(t => t.index === chrisEntry.typeIndex);
  assert.equal(chrisType.name, 'name_female,name_male');

  // No truncation: every input word survives.
  // Inputs: name_male={Bob, Tom, Ned} after chris merges out,
  // name_female={Jody, Tracy, Lisa}, merged={chris}. Lowercased and
  // de-duped: 7 words. Plus sortDict's auto-injected REDACTED
  // singleton (REDACTION_MARKER) = 8 total.
  assert.equal(dict.words.length, 8);
  assert.ok(dict.words.some(w => w.word === REDACTION_MARKER),
    'REDACTED marker should ride through to the dict');
  // Every word has a (code, bits) pair.
  for (const w of dict.words) {
    assert.equal(typeof w.code, 'number');
    assert.equal(typeof w.bits, 'number');
  }
});
