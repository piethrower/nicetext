import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { precleanCorpus } from '../../js/src/builder/precleanCorpus.js';

test('precleanCorpus: plain ASCII is unchanged', () => {
  const t = 'the cat sat on the mat.\nshe said hello.';
  assert.equal(precleanCorpus(t), t);
});

test('precleanCorpus: empty string round-trips', () => {
  assert.equal(precleanCorpus(''), '');
});

test('precleanCorpus: idempotent, second pass is a fixed point', () => {
  const noisy = '﻿don’t “stop”, now please';
  const once = precleanCorpus(noisy);
  const twice = precleanCorpus(once);
  assert.equal(once, twice);
});

test('precleanCorpus rule 1: collapse run of control bytes to one space', () => {
  assert.equal(precleanCorpus('foo\x00\x01\x02bar'), 'foo bar');
});

test('precleanCorpus rule 1: BOM (U+FEFF) is stripped (becomes space when at edge of run)', () => {
  // Single BOM at the very start is a one-char run; collapses to one space.
  assert.equal(precleanCorpus('﻿hello'), ' hello');
});

test('precleanCorpus rule 1: tab / LF are preserved (lexer-significant whitespace)', () => {
  // CR was on this list before Rule 0; Rule 0 now normalizes CR → LF
  // before Rule 1 ever sees it.
  assert.equal(precleanCorpus('foo\tbar\nbaz\nqux'), 'foo\tbar\nbaz\nqux');
});

test('precleanCorpus rule 0: CRLF pairs are normalized to LF', () => {
  assert.equal(precleanCorpus('line1\r\nline2\r\nline3'), 'line1\nline2\nline3');
});

test('precleanCorpus rule 0: bare CR is normalized to LF', () => {
  assert.equal(precleanCorpus('line1\rline2\rline3'), 'line1\nline2\nline3');
});

test('precleanCorpus rule 0: mixed CRLF and bare CR both normalize', () => {
  assert.equal(precleanCorpus('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('precleanCorpus rule 0: no CR in input is a no-op', () => {
  const t = 'no carriage returns here\nat all';
  assert.equal(precleanCorpus(t), t);
});

test('precleanCorpus rule 1: zero-width space (U+200B) is stripped', () => {
  assert.equal(precleanCorpus('foo​bar'), 'foo bar');
});

test('precleanCorpus rule 2: curly quotes flatten to ASCII', () => {
  assert.equal(precleanCorpus('don’t'), "don't");
  assert.equal(precleanCorpus('“hello”'), '"hello"');
  assert.equal(precleanCorpus('he said “don’t”'), 'he said "don\'t"');
});

test('precleanCorpus rule 3: NBSP and exotic spaces normalize to U+0020', () => {
  // NBSP, thin, hair, narrow-nbsp, medium math, ideographic.
  const exotics = '     　';
  assert.equal(precleanCorpus(`a${exotics}b`), 'a      b');
});

test('precleanCorpus rule 4: em / en dashes become a single space', () => {
  assert.equal(precleanCorpus('well—known'), 'well known');
  assert.equal(precleanCorpus('en–dash'), 'en dash');
});

test('precleanCorpus rule 5: Cyrillic confusables fold to Latin look-alikes', () => {
  // Cyrillic а (U+0430) inside a Latin word silently fragments the
  // WORD at the script boundary today; rule 5 folds it to ASCII a.
  assert.equal(precleanCorpus('pаper'), 'paper');
  assert.equal(precleanCorpus('Оil'), 'Oil');  // Cyrillic О → Latin O
});

test('precleanCorpus rule 5: Greek confusables fold to Latin', () => {
  // Greek alpha (U+03B1) → Latin a. Greek capital E (U+0395) → Latin E.
  assert.equal(precleanCorpus('αlpha'), 'alpha');
  assert.equal(precleanCorpus('Εasy'), 'Easy');
});

test('precleanCorpus rule 5: Cherokee confusables fold to Latin', () => {
  // Cherokee letter MI (U+13B7) looks like Latin M.
  // (Pick any uncontroversial alphabet-imitation Cherokee letter
  // from the generated map.)
  assert.equal(precleanCorpus('Ꮇoon'), 'Moon');
});

test('precleanCorpus rule 5: Script=Common chars are NOT folded', () => {
  // `|` (U+007C) maps to `l` in raw TR39 but is Script=Common, so
  // the build script excludes it. Folding pipes/multiplication-signs
  // into word chars would merge tokens that carry real meaning
  // in plain text.
  assert.equal(precleanCorpus('a|b'), 'a|b');
  assert.equal(precleanCorpus('3×5 grid'), '3×5 grid');
});

test('precleanCorpus rule 5: plain ASCII is untouched', () => {
  assert.equal(precleanCorpus('the quick brown fox'), 'the quick brown fox');
});

test('precleanCorpus rule 6: stray ZWJ between Latin letters is stripped', () => {
  assert.equal(precleanCorpus('a‍b'), 'ab');
  assert.equal(precleanCorpus('foo‌bar'), 'foobar');
});

test('precleanCorpus rule 6: ZWJ between emoji is preserved (legitimate ZWJ family)', () => {
  // 👨 + ZWJ + 👩, both flanks are Extended_Pictographic; keep the ZWJ.
  const family = '\u{1F468}‍\u{1F469}';
  assert.equal(precleanCorpus(family), family);
});

test('precleanCorpus rule 6: ZWJ at end of string is stripped (no right neighbor)', () => {
  assert.equal(precleanCorpus('hello‍'), 'hello');
});

test('precleanCorpus rule 6: ZWJ at start of string is stripped (no left neighbor)', () => {
  assert.equal(precleanCorpus('‍hello'), 'hello');
});

test('precleanCorpus rule 7: pure-numeric 3+ chain splits on `.`', () => {
  assert.equal(precleanCorpus('1.2.3'), '1 2 3');
  assert.equal(precleanCorpus('1.2.3.4.5'), '1 2 3 4 5');
});

test('precleanCorpus rule 7: numeric chain inside surrounding text', () => {
  assert.equal(precleanCorpus('Section 1.2.3.4 begins'),
    'Section 1 2 3 4 begins');
  assert.equal(precleanCorpus('see 1.2.3 and 4.5.6 later'),
    'see 1 2 3 and 4 5 6 later');
});

test('precleanCorpus rule 7: IP-like 4-segment chain also splits', () => {
  // Treated the same as any pure-numeric 3+ chain; intentional per
  // round-trip-over-believability framing.
  assert.equal(precleanCorpus('host 192.168.1.1 here'),
    'host 192 168 1 1 here');
});

test('precleanCorpus rule 7: 2-segment numeric chain is left alone', () => {
  assert.equal(precleanCorpus('python 1.2 release'),
    'python 1.2 release');
});

test('precleanCorpus rule 7: alpha/mixed chains are preserved', () => {
  // Acronyms, abbreviations, domain names, version strings, same
  // lex shape as the target, different semantics. Anchors keep
  // the inner `1.2.3` slice in `version.1.2.3` from triggering.
  for (const t of ['U.S.A.', 'e.g.', 'a.m.', 'www.example.com', 'version.1.2.3']) {
    assert.equal(precleanCorpus(t), t, `should not touch ${t}`);
  }
});

test('precleanCorpus rule 7: numeric segment adjacent to word char does not trigger', () => {
  // `foo.1.2.3`, the leading `.` is preceded by `o` (a word char),
  // so `(?<![\w.])` fails at every candidate start. Whole token stays.
  assert.equal(precleanCorpus('foo.1.2.3'), 'foo.1.2.3');
});

test('precleanCorpus: rules compose without conflict', () => {
  // BOM + curly-quoted contraction with NBSP + em-dash.
  const messy = '﻿don’t stop—now';
  assert.equal(precleanCorpus(messy), " don't stop now");
});

// ---- Chunked-progress tests (audit Findings 4 + 5, 2026-05-18) ----
//
// precleanCorpus now slices the input at line boundaries (~512 KB
// chunks, 2 MB hard cap) and applies all rules per chunk. Verifies
// the new onProgress shape, multi-chunk emission, and output identity
// vs single-chunk processing.

test('precleanCorpus: small input is one chunk; onProgress fires once per pass', () => {
  const calls = [];
  precleanCorpus('hello world\nsecond line\n', (info) => calls.push(info));
  assert.ok(calls.length >= 1);
  for (const info of calls) {
    assert.equal(typeof info.pass, 'number');
    assert.equal(typeof info.chunkIndex, 'number');
    assert.equal(typeof info.chunkCount, 'number');
    assert.equal(typeof info.chars, 'number');
    assert.equal(info.chunkIndex >= 0 && info.chunkIndex < info.chunkCount, true);
  }
  // Final chunk index in last call is chunkCount - 1.
  const lastInPass1 = calls.filter(c => c.pass === 1).at(-1);
  assert.equal(lastInPass1.chunkIndex, lastInPass1.chunkCount - 1);
});

test('precleanCorpus: large input splits into multiple chunks at line boundaries', () => {
  // ~1.5 MB of repeated short lines; > the 512 KB target so it must
  // split. Each line is ~50 chars; ~30,000 lines.
  const line = 'this is a normal line of cover-like prose without anything special\n';
  const big = line.repeat(30000);
  const calls = [];
  const out = precleanCorpus(big, (info) => calls.push(info));
  // chunk count from the first-pass progress events
  const pass1 = calls.filter(c => c.pass === 1);
  assert.ok(pass1.length >= 2, `expected multi-chunk pass; saw ${pass1.length} progress events in pass 1`);
  assert.equal(pass1[0].chunkCount, pass1.at(-1).chunkCount);
  assert.ok(pass1[0].chunkCount >= 2);
  // Output should be identical (rule 0/1 are no-ops here).
  assert.equal(out, big);
});

test('precleanCorpus: chunked output equals non-chunked output for multi-rule-firing input', () => {
  // Inputs that fire multiple rules; verify chunking doesn't change
  // the output. Each line independently exercises rules 2/3/4/5/7.
  const oneLine = ' don’t stop—now please. version 1.2.3.4\n';
  const single = precleanCorpus(oneLine);
  const repeated = oneLine.repeat(20000); // ~1.4 MB
  const chunked = precleanCorpus(repeated);
  assert.equal(chunked, single.repeat(20000));
});

test('precleanCorpus: input with no newlines hard-caps to 2 MB chunks', () => {
  // ~3 MB single-line input. With no \n to snap to, the chunker
  // force-splits at PRECLEAN_CHUNK_MAX (2 MB). Verifies the hard cap
  // path doesn't blow up.
  const oneBigLine = 'a'.repeat(3 * 1024 * 1024);
  const calls = [];
  const out = precleanCorpus(oneBigLine, (info) => calls.push(info));
  const pass1 = calls.filter(c => c.pass === 1);
  assert.ok(pass1.length >= 2);
  assert.equal(out, oneBigLine);
});
