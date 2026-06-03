// byos.schema.test.js: strict-validator behavior. Asserts validate()
// rejects malformed inputs and accepts the canonical example shapes.

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';

import { validate } from '../../../js/src/byos.js';

function expectFail(byos, expectedSubstring) {
  assert.throws(
    () => validate(byos),
    err => {
      assert.match(err.message, /^byos: /, 'must throw a byos: error');
      if (expectedSubstring) {
        assert.match(err.message, new RegExp(expectedSubstring), `expected error to mention "${expectedSubstring}", got: ${err.message}`);
      }
      return true;
    }
  );
}

function expectPass(byos) {
  assert.doesNotThrow(() => validate(byos));
}

// --- required fields ---

test('reject: not an object', () => {
  expectFail(null, 'plain object');
  expectFail('string', 'plain object');
  expectFail([], 'plain object');
});

test('reject: missing version', () => {
  expectFail({ name: 'x', story: { style: 'flat' } }, 'version');
});

test('reject: version not 1', () => {
  expectFail({ version: 0,  name: 'x', story: { style: 'flat' } }, 'version');
  expectFail({ version: 2,  name: 'x', story: { style: 'flat' } }, 'version');
  expectFail({ version: '1', name: 'x', story: { style: 'flat' } }, 'version');
});

test('reject: missing name', () => {
  expectFail({ version: 1, story: { style: 'flat' } }, 'name');
});

test('reject: empty name', () => {
  expectFail({ version: 1, name: '', story: { style: 'flat' } }, 'name');
});

test('reject: notes not a string', () => {
  expectFail({ version: 1, name: 'x', notes: 123, story: { style: 'flat' } }, 'notes');
});

test('reject: neither story nor base', () => {
  expectFail({ version: 1, name: 'x' }, 'story or base');
});

// --- unknown fields ---

test('reject: unknown top-level field', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'flat' }, junk: 1 },
    'unknown top-level field: junk'
  );
});

test('reject: unknown story field', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'flat', junk: 1 } },
    'unknown story field: junk'
  );
});

test('reject: unknown base field', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        junk: 1,
      },
    },
    'unknown base field: junk'
  );
});

test('reject: unknown augment field', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        augment: { junk: 1 },
      },
    },
    'unknown base.augment field: junk'
  );
});

test('reject: unknown build field', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'flat' }, build: { junk: 1 } },
    'unknown build field: junk'
  );
});

// --- bad enums ---

test('reject: bad story.style', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'banana' } },
    'story.style'
  );
});

test('reject: bad story.sentence', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', sentence: 'haphazard', vocabulary: 'corpus' },
    },
    'story.sentence'
  );
});

test('reject: bad story.vocabulary', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', sentence: 'random', vocabulary: 'whatever' },
    },
    'story.vocabulary'
  );
});

test('reject: bad source name', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit', 'banana'],
        frequencies: ['norvig'],
        tieBreak: 'alpha-asc',
      },
    },
    'base.sources contains invalid name'
  );
});

test('reject: bad frequency name', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'],
        frequencies: ['norvig', 'banana'],
        tieBreak: 'alpha-asc',
      },
    },
    'base.frequencies contains invalid name'
  );
});

test('reject: bad tieBreak', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: { sources: ['mit'], frequencies: ['norvig'], tieBreak: 'random' },
    },
    'base.tieBreak'
  );
});

test('reject: augment.vowel rejected as unknown field (retired with cover-transforms)', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        augment: { vowel: true },
      },
    },
    'unknown base.augment field: vowel'
  );
});

test('reject: augment.emojiIntoWords without enabled field', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        augment: { emojiIntoWords: { intensity: 1 } },
      },
    },
    'enabled must be a boolean'
  );
});

test('reject: augment.emojiIntoWords.intensity not an integer', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        augment: { emojiIntoWords: { enabled: true, intensity: 'narrow' } },
      },
    },
    'intensity must be an integer'
  );
});

test('reject: augment.emojiIntoWords.intensity out of range', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        augment: { emojiIntoWords: { enabled: true, intensity: 11 } },
      },
    },
    'intensity must be an integer'
  );
});

test('accept: full emoji augment block (per-aug intensity 7)', () => {
  expectPass({
    version: 1, name: 'x',
    base: {
      sources: ['emoji16', 'mit'],
      frequencies: ['norvig'],
      tieBreak: 'alpha-asc',
      augment: {
        emojiIntoWords: { enabled: true, intensity: 7 },
        wordsIntoEmoji: { enabled: true, intensity: 7 },
      },
    },
  });
});

test('accept: card with rewriter.xanax enabled and no aug block', () => {
  expectPass({
    version: 1, name: 'x',
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
    rewriter: { xanax: { enabled: true, intensity: 100 } },
  });
});

test('accept: rewriter.typos with mode', () => {
  expectPass({
    version: 1, name: 'x',
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
    rewriter: { typos: { enabled: true, intensity: 50, mode: 'forward' } },
  });
});

test('accept: rewriter.voice with mode', () => {
  expectPass({
    version: 1, name: 'x',
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
    rewriter: { voice: { enabled: true, intensity: 50, mode: 'pirate' } },
  });
});

test('accept: reformatter.case with mode', () => {
  expectPass({
    version: 1, name: 'x',
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
    reformatter: { case: { enabled: true, intensity: 100, mode: 'titleCase' } },
  });
});

test('reject: rewriter.xanax legacy integer shape', () => {
  expectFail(
    {
      version: 1, name: 'x', base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
      rewriter: { xanax: 100 },
    },
    'rewriter\\.xanax must be a plain object',
  );
});

test('reject: rewriter.typos missing mode when enabled', () => {
  expectFail(
    {
      version: 1, name: 'x', base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
      rewriter: { typos: { enabled: true, intensity: 50 } },
    },
    'mode is required',
  );
});

test('reject: rewriter.xanax with mode is rejected (unimodal field)', () => {
  expectFail(
    {
      version: 1, name: 'x', base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
      rewriter: { xanax: { enabled: true, intensity: 100, mode: 'whatever' } },
    },
    'mode is not accepted',
  );
});

test('reject: reformatter.case unknown mode', () => {
  expectFail(
    {
      version: 1, name: 'x', base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
      reformatter: { case: { enabled: true, intensity: 100, mode: 'BIZARRE' } },
    },
    'reformatter\\.case\\.mode must be one of',
  );
});

// --- conditionals ---

test('reject: sentence present when style=flat', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'flat', sentence: 'random' } },
    'story.sentence must be omitted'
  );
});

test('reject: vocabulary present when style=flat', () => {
  expectFail(
    { version: 1, name: 'x', story: { style: 'flat', vocabulary: 'corpus' } },
    'story.vocabulary must be omitted'
  );
});

test('reject: missing sentence when style != flat', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', vocabulary: 'corpus' },
    },
    'story.sentence is required'
  );
});

test('reject: missing vocabulary when style != flat', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', sentence: 'random' },
    },
    'story.vocabulary is required'
  );
});

test('reject: base missing sources', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: { frequencies: ['norvig'], tieBreak: 'alpha-asc' },
    },
    'base.sources'
  );
});

test('reject: base missing frequencies', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: { sources: ['mit'], tieBreak: 'alpha-asc' },
    },
    'base.frequencies'
  );
});

test('reject: base missing tieBreak', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: { sources: ['mit'], frequencies: ['norvig'] },
    },
    'base.tieBreak'
  );
});

// --- absolute paths ---

test('reject: absolute customTwlist path', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['customtw'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        customTwlist: '/etc/passwd',
      },
    },
    'customTwlist'
  );
});

test('reject: absolute customWordfreq path', () => {
  expectFail(
    {
      version: 1, name: 'x',
      base: {
        sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
        customWordfreq: '/var/spool/secrets',
      },
    },
    'customWordfreq'
  );
});

test('reject: absolute build.corpus path', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', sentence: 'random', vocabulary: 'corpus' },
      build: { corpus: '/home/me/aesop.txt' },
    },
    'build.corpus'
  );
});

test('reject: Windows-style absolute path', () => {
  expectFail(
    {
      version: 1, name: 'x',
      story: { style: 'aesop', sentence: 'random', vocabulary: 'corpus' },
      build: { corpus: 'C:\\corpora\\aesop.txt.gz' },
    },
    'build.corpus'
  );
});

// --- accept canonical shapes ---

test('accept: random-shape', () => {
  expectPass({
    version: 1, name: 'random',
    notes: 'Bundled TW-list union.',
    story: { style: 'flat' },
    base: {
      sources: ['claude2026', 'connectors', 'impf2p', 'impkimmo', 'mit', 'num-form-preserved', 'rhyme'],
      frequencies: ['norvig', 'google', 'gutenberg'],
      tieBreak: 'alpha-asc',
    },
    rewriter: { xanax: { enabled: true, intensity: 100 } },
  });
});

test('accept: aesop-shape (story-only with build block)', () => {
  expectPass({
    version: 1, name: 'aesop',
    story: { style: 'aesop', sentence: 'random', vocabulary: 'corpus' },
    build: { corpus: 'fixture-src/aesop.txt.gz' },
  });
});

test('accept: base-only', () => {
  expectPass({
    version: 1, name: 'mit',
    story: { style: 'flat' },
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
  });
});

test('accept: full custom shape', () => {
  expectPass({
    version: 1, name: 'custom-test',
    story: { style: 'custom', sentence: 'sequential', vocabulary: 'corpus' },
    base: {
      sources: ['customtw', 'mit'],
      customTwlist: 'my-words.tsv',
      frequencies: ['norvig', 'style'],
      customWordfreq: 'my-freqs.tsv',
      tieBreak: 'prefer-shorter',
    },
    build: { corpus: 'fixture-src/my-corpus.txt' },
  });
});
