// byos.id.test.js: encoding / decoding / round-trip / nickname lookup
// for byosID. Pure tests against js/src/byos.js, no fixtures required.

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';

import {
  generateBYOSID, generateBYOS,
  getBYOSID, formatBYOSID,
  findCardByBYOSID, findCardByName, findCardByCanonicalID,
  getDictPath, getModelPath, getTwlistPath, getCardsPath, FIXTURES_PREFIX,
} from '../../../js/src/byos.js';

const RANDOM = {
  version: 1,
  name: 'random',
  story: { style: 'flat' },
  base: {
    sources: ['impkimmo', 'rhyme', 'impf2p', 'mit', 'num-form-preserved', 'claude2026', 'connectors'],
    frequencies: ['norvig', 'google', 'gutenberg'],
    tieBreak: 'alpha-asc',
  },
  rewriter: { xanax: { enabled: true, intensity: 100 } },
};

const AESOP = {
  version: 1,
  name: 'aesop',
  story: { style: 'aesop', sentence: 'random', vocabulary: 'corpus' },
};

const FULL_CUSTOM = {
  version: 1,
  name: 'custom-test',
  story: { style: 'custom', sentence: 'sequential', vocabulary: 'corpus' },
  base: {
    sources: ['customtw', 'mit'],
    frequencies: ['norvig'],
    tieBreak: 'prefer-shorter',
  },
};

// --- regression literals ---

test('byosID: random-equivalent regression', () => {
  // RANDOM above carries `connectors` alongside `impkimmo`; validate()
  // strips it as part of canonicalization because the engine's _UNIQUE_
  // drop-rule would do the same at build time. The expected byosID
  // therefore matches random.byos.json's actual id (no connectors).
  const id = generateBYOSID(RANDOM);
  assert.equal(
    id,
    'v=1__sty=flat__src=claude2026,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=google,gutenberg,norvig__tb=a__xa=100'
  );
});

test('byosID: aesop-equivalent regression', () => {
  const id = generateBYOSID(AESOP);
  assert.equal(id, 'v=1__sty=aesop__sen=r__voc=c');
});

test('byosID: full-custom regression', () => {
  const id = generateBYOSID(FULL_CUSTOM);
  assert.equal(
    id,
    'v=1__sty=cust__sen=s__voc=c__src=customtw,mit__frq=norvig__tb=p'
  );
});

// --- round-trip identity ---

function roundTrip(byos) {
  const id1 = generateBYOSID(byos);
  const decoded = generateBYOS(id1);
  const id2 = generateBYOSID(decoded);
  assert.equal(id2, id1, `round-trip drifted: ${id1} -> ${id2}`);
  return { id1, decoded };
}

test('round-trip: random', () => roundTrip(RANDOM));
test('round-trip: aesop', () => roundTrip(AESOP));
test('round-trip: full-custom', () => roundTrip(FULL_CUSTOM));

test('round-trip: story-only (no base)', () => {
  roundTrip({
    version: 1, name: 'x',
    story: { style: 'shakespeare', sentence: 'random', vocabulary: 'base' },
  });
});

test('round-trip: base-only (no story)', () => {
  roundTrip({
    version: 1, name: 'x',
    base: {
      sources: ['mit'], frequencies: ['norvig'], tieBreak: 'alpha-asc',
    },
  });
});

// --- rewriter + reformatter cover-transform blocks ---

test('byosID: rewriter shortcodes emit in sorted-by-long-name order', () => {
  // Enabled: typos, xanax, british → emitted alphabetically by long
  // name (british, typos, xanax) so the byosID is stable regardless
  // of how the input object orders its keys.
  const byos = {
    version: 1, name: 'x',
    story: { style: 'flat' },
    rewriter: {
      xanax:   { enabled: true, intensity: 100 },
      british: { enabled: true, intensity:  25, mode: 'us-uk' },
      typos:   { enabled: true, intensity:  50, mode: 'forward' },
    },
  };
  const id = generateBYOSID(byos);
  assert.equal(id, 'v=1__sty=flat__br=25:u__ty=50:f__xa=100');
});

test('byosID: zero-intensity rewriters omitted from byosID', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: {
      xanax:   { enabled: true,  intensity: 100 },
      british: { enabled: true,  intensity:   0, mode: 'us-uk' },
      typos:   { enabled: false, intensity: 100, mode: 'forward' },
    },
  };
  const id = generateBYOSID(byos);
  assert.equal(id, 'v=1__sty=flat__xa=100');
});

test('byosID: empty rewriter block emits nothing', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: {},
  };
  const id = generateBYOSID(byos);
  assert.equal(id, 'v=1__sty=flat');
});

test('byosID: reformatter enabled values emit lb= / cs= pairs', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: {
      lineBreak: { enabled: true, intensity: 100, mode: 'expand' },
      case:      { enabled: true, intensity: 100, mode: 'titleCase' },
    },
  };
  const id = generateBYOSID(byos);
  assert.ok(id.includes('__lb=100:ex'), `expected __lb=100:ex in ${id}`);
  assert.ok(id.includes('cs=100:tc'),   `expected cs=100:tc in ${id}`);
});

test('byosID: disabled reformatter fields omitted from byosID', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: {
      lineBreak: { enabled: false, intensity: 100, mode: 'expand' },
      case:      { enabled: false, intensity: 100, mode: 'titleCase' },
    },
  };
  const id = generateBYOSID(byos);
  assert.equal(id, 'v=1__sty=flat');
});

test('round-trip: rewriter + reformatter combined', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: {
      xanax: { enabled: true, intensity: 100 },
      typos: { enabled: true, intensity:  50, mode: 'forward' },
    },
    reformatter: {
      lineBreak: { enabled: true, intensity: 100, mode: 'expand' },
      case:      { enabled: true, intensity: 100, mode: 'allCaps' },
    },
  };
  roundTrip(byos);
});

test('round-trip: every rewriter shortcode survives', () => {
  // Distinct intensities + modes so a swap-bug would surface as
  // a value mismatch, not just an assert-true that passes either way.
  const block = {
    british: { enabled: true, intensity: 25,  mode: 'us-uk' },
    typos:   { enabled: true, intensity: 99,  mode: 'forward' },
    voice:   { enabled: true, intensity: 10,  mode: 'pirate' },
    xanax:   { enabled: true, intensity: 100 },
  };
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { ...block },
  };
  const { decoded } = roundTrip(byos);
  for (const name of Object.keys(block)) {
    assert.deepEqual(decoded.rewriter[name], block[name],
      `${name} round-trip lost or shifted`);
  }
});

test('round-trip: every reformatter case mode survives', () => {
  const modes = [
    'allCaps', 'allLowercase', 'titleCase', 'sentenceCase',
    'randomCaps', 'sentenceStartLower',
  ];
  for (const c of modes) {
    const byos = {
      version: 1, name: 'x', story: { style: 'flat' },
      reformatter: { case: { enabled: true, intensity: 100, mode: c } },
    };
    const { decoded } = roundTrip(byos);
    assert.equal(decoded.reformatter.case.mode, c);
  }
});

test('round-trip: reformatter sentenceEnd modes survive', () => {
  for (const m of ['uptalk', 'excitement']) {
    const byos = {
      version: 1, name: 'x', story: { style: 'flat' },
      reformatter: { sentenceEnd: { enabled: true, intensity: 50, mode: m } },
    };
    const { decoded } = roundTrip(byos);
    assert.equal(decoded.reformatter.sentenceEnd.mode, m);
    assert.equal(decoded.reformatter.sentenceEnd.intensity, 50);
  }
});

test('byosID: sentenceEnd encodes as se=<intensity>:<mode>', () => {
  const byos = {
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: { sentenceEnd: { enabled: true, intensity: 50, mode: 'uptalk' } },
  };
  const id = generateBYOSID(byos);
  assert.ok(id.includes('se=50:ut'), `expected se=50:ut in ${id}`);
});

test('round-trip: every reformatter lineBreak mode survives', () => {
  for (const lb of ['expand', 'collapse']) {
    const byos = {
      version: 1, name: 'x', story: { style: 'flat' },
      reformatter: { lineBreak: { enabled: true, intensity: 100, mode: lb } },
    };
    const { decoded } = roundTrip(byos);
    assert.equal(decoded.reformatter.lineBreak.mode, lb);
  }
});

test('rewriter validation: unknown field rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { bogus: { enabled: true, intensity: 100 } },
  }), /unknown rewriter field: bogus/);
});

test('rewriter validation: missing enabled rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { xanax: { intensity: 100 } },
  }), /rewriter\.xanax\.enabled must be a boolean/);
});

test('rewriter validation: out-of-range intensity rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { xanax: { enabled: true, intensity: 101 } },
  }), /rewriter\.xanax\.intensity must be an integer 0\.\.100/);
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { xanax: { enabled: true, intensity: -1 } },
  }), /rewriter\.xanax\.intensity must be an integer 0\.\.100/);
});

test('rewriter validation: legacy bare integer rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { xanax: 100 },
  }), /rewriter\.xanax must be a plain object/);
});

test('reformatter validation: unknown case mode rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: { case: { enabled: true, intensity: 100, mode: 'BIZARRE' } },
  }), /reformatter\.case\.mode must be one of/);
});

test('reformatter validation: unknown lineBreak mode rejected', () => {
  assert.throws(() => generateBYOSID({
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: { lineBreak: { enabled: true, intensity: 100, mode: 'maximize' } },
  }), /reformatter\.lineBreak\.mode must be one of/);
});

test('empty frequencies array: frq= segment omitted from byosID', () => {
  const byos = {
    version: 1, name: 'x',
    base: {
      sources: ['mit'],
      frequencies: [],
      tieBreak: 'alpha-asc',
    },
  };
  const id = generateBYOSID(byos);
  assert.equal(id, 'v=1__src=mit__tb=a');
  // round-trip: decoded restores frequencies: [], re-encoded matches.
  const decoded = generateBYOS(id);
  assert.deepEqual(decoded.base.frequencies, []);
  assert.equal(generateBYOSID(decoded), id);
});

test('round-trip: with customWordfreq present', () => {
  const byos = {
    version: 1, name: 'x',
    base: {
      sources: ['mit'],
      frequencies: ['norvig'],
      tieBreak: 'alpha-asc',
      customWordfreq: 'my-private-freqs.tsv',
    },
  };
  const id = generateBYOSID(byos);
  assert.match(id, /__cwf__/, 'cwf flag must appear');
  assert.doesNotMatch(id, /my-private-freqs/, 'custom path must not leak');
  const decoded = generateBYOS(id);
  assert.equal(decoded.base.customWordfreq, '<custom>');
  assert.equal(generateBYOSID(decoded), id);
});

// --- sort stability ---

test('sort stability: source array order is irrelevant', () => {
  const a = { ...RANDOM };
  const b = { ...RANDOM, base: {
    ...RANDOM.base,
    sources: ['rhyme', 'num-form-preserved', 'mit', 'impkimmo', 'impf2p', 'connectors', 'claude2026'],
  } };
  assert.equal(generateBYOSID(b), generateBYOSID(a));
});

test('sort stability: frequency array order is irrelevant', () => {
  const a = {
    version: 1, name: 'x',
    base: { sources: ['mit'], frequencies: ['norvig', 'google', 'gutenberg'], tieBreak: 'alpha-asc' },
  };
  const b = {
    version: 1, name: 'x',
    base: { sources: ['mit'], frequencies: ['gutenberg', 'norvig', 'google'], tieBreak: 'alpha-asc' },
  };
  assert.equal(generateBYOSID(b), generateBYOSID(a));
});

// --- custom-flag privacy ---

test('custom corpus: byosID encodes flag, not specifics', () => {
  // Hypothetical: a public-spec byos where story.style is custom.
  // The byosID has `sty=cust` (the flag) and nothing tying it to a
  // specific corpus.
  const a = {
    version: 1, name: 'a',
    story: { style: 'custom', sentence: 'random', vocabulary: 'corpus' },
  };
  const b = {
    version: 1, name: 'b',
    story: { style: 'custom', sentence: 'random', vocabulary: 'corpus' },
  };
  assert.equal(generateBYOSID(b), generateBYOSID(a));
  assert.match(generateBYOSID(a), /sty=cust/);
});

test('custom TW-list: byosID encodes via "customtw" source name', () => {
  const byos = {
    version: 1, name: 'x',
    base: {
      sources: ['mit', 'customtw'],
      frequencies: ['norvig'],
      tieBreak: 'alpha-asc',
      customTwlist: 'my-private-twlist.tsv',
    },
  };
  const id = generateBYOSID(byos);
  assert.match(id, /__src=customtw,mit__/);
  assert.doesNotMatch(id, /my-private-twlist/);
  // customTwlist path is dropped on decode (only the source-name flag survives).
  const decoded = generateBYOS(id);
  assert.equal(decoded.base.customTwlist, undefined);
  assert.deepEqual([...decoded.base.sources].sort(), ['customtw', 'mit']);
});

// vowel-augment shortcode `av` retired with the cover-transforms arc
// (replaced by the xanax rewriter, see byos.rewriter.xanax tests
// above). Old byosIDs containing `__av__` are no longer parseable.

// --- byosID ignores cosmetics + build block ---

test('cosmetics dropped: name, notes, build do not affect byosID', () => {
  const id1 = generateBYOSID(RANDOM);
  const decorated = {
    ...RANDOM,
    name: 'something-else',
    notes: 'a different note here',
    build: { corpus: 'fixture-src/whatever.txt.gz' },
  };
  assert.equal(generateBYOSID(decorated), id1);
});

// --- decoded form contains no cosmetics ---

test('generateBYOS output has no name / notes / build', () => {
  const decoded = generateBYOS(generateBYOSID(RANDOM));
  assert.equal(decoded.name, undefined);
  assert.equal(decoded.notes, undefined);
  assert.equal(decoded.build, undefined);
  assert.equal(decoded.version, 1);
});

// --- nickname helpers ---

const SAMPLE_CARDS = [
  { name: 'random', version: 1, byosID: generateBYOSID(RANDOM) },
  { name: 'aesop',  version: 1, byosID: generateBYOSID(AESOP) },
];

test('findCardByBYOSID: returns matching card', () => {
  const card = findCardByBYOSID(generateBYOSID(RANDOM), SAMPLE_CARDS);
  assert.equal(card?.name, 'random');
});

test('findCardByBYOSID: returns null on miss', () => {
  assert.equal(findCardByBYOSID('v=1__sty=flat', SAMPLE_CARDS), null);
});

test('findCardByBYOSID: tolerates null/non-array cards', () => {
  assert.equal(findCardByBYOSID('whatever', null), null);
  assert.equal(findCardByBYOSID('whatever', undefined), null);
});

test('findCardByName: returns matching card by nickname', () => {
  const card = findCardByName('random', SAMPLE_CARDS);
  assert.equal(card?.name, 'random');
});

test('findCardByName: returns null on miss', () => {
  assert.equal(findCardByName('does-not-exist', SAMPLE_CARDS), null);
});

test('findCardByName: tolerates null/non-array cards or non-string name', () => {
  assert.equal(findCardByName('random', null), null);
  assert.equal(findCardByName('random', undefined), null);
  assert.equal(findCardByName(42, SAMPLE_CARDS), null);
  assert.equal(findCardByName(null, SAMPLE_CARDS), null);
});

test('getBYOSID: returns rev-suffixed nickname when card matches', () => {
  assert.equal(getBYOSID(RANDOM, SAMPLE_CARDS), 'random-1');
  assert.equal(getBYOSID(AESOP, SAMPLE_CARDS), 'aesop-1');
});

test('getBYOSID: returns long byosID when no card matches', () => {
  const stranger = {
    version: 1, name: 'x',
    base: { sources: ['mit'], frequencies: ['norvig'], tieBreak: 'prefer-shorter' },
  };
  const id = getBYOSID(stranger, SAMPLE_CARDS);
  assert.equal(id, generateBYOSID(stranger));
  assert.match(id, /^v=1__/);
});

test('getBYOSID: cosmetic differences (name/notes) still resolve to nickname', () => {
  const renamed = { ...RANDOM, name: 'overridden', notes: 'foo' };
  assert.equal(getBYOSID(renamed, SAMPLE_CARDS), 'random-1');
});

test('formatBYOSID: back-compat alias for getBYOSID', () => {
  assert.equal(formatBYOSID(RANDOM, SAMPLE_CARDS), getBYOSID(RANDOM, SAMPLE_CARDS));
});

// --- canonical-id lookup ---

test('findCardByCanonicalID: rev-suffixed nickname → card', () => {
  assert.equal(findCardByCanonicalID('random-1', SAMPLE_CARDS)?.name, 'random');
});

test('findCardByCanonicalID: long-form byosID → card', () => {
  assert.equal(
    findCardByCanonicalID(generateBYOSID(AESOP), SAMPLE_CARDS)?.name,
    'aesop'
  );
});

test('findCardByCanonicalID: raw nickname without rev does NOT match', () => {
  // 'random' (without -1) is not the canonical id; only 'random-1' is.
  assert.equal(findCardByCanonicalID('random', SAMPLE_CARDS), null);
});

test('findCardByCanonicalID: unknown id → null', () => {
  assert.equal(findCardByCanonicalID('foo-1', SAMPLE_CARDS), null);
  assert.equal(findCardByCanonicalID('v=1__sty=flat', SAMPLE_CARDS), null);
});

// --- path helpers ---

test('getDictPath: card hit → fixtures/{nickname-rev}.dict.sab.gz', () => {
  // getDictPath returns the canonical (SAB) runtime fixture path. The
  // native intermediate path used by build tools is getDictNativePath.
  assert.equal(getDictPath(RANDOM, SAMPLE_CARDS), 'fixtures/random-1.dict.sab.gz');
});

test('getDictPath: card miss → fixtures/{long-byosID}.dict.sab.gz', () => {
  const stranger = {
    version: 1, name: 'x',
    base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
  };
  const id = generateBYOSID(stranger);
  assert.equal(getDictPath(stranger, SAMPLE_CARDS), `fixtures/${id}.dict.sab.gz`);
});

test('getModelPath: card hit → fixtures/{nickname-rev}.model.sab.gz', () => {
  // getModelPath returns the canonical (SAB) runtime fixture path.
  // The native intermediate path used by build-model-table.js is
  // getModelNativePath.
  assert.equal(getModelPath(AESOP, SAMPLE_CARDS), 'fixtures/aesop-1.model.sab.gz');
});

test('getTwlistPath / getCardsPath / FIXTURES_PREFIX', () => {
  // getTwlistPath returns the canonical (SAB) runtime fixture path
  // (entries-SAB / NTEN). The native intermediate path used by build
  // tools is getTwlistNativePath.
  assert.equal(getTwlistPath('mit'), 'fixtures/mit.twlist.sab.gz');
  assert.equal(getCardsPath(), 'fixtures/cards.data.js');
  assert.equal(FIXTURES_PREFIX, 'fixtures/');
});

// ---- intensity-default canonicalization ----------------------------
//
// Cards may omit the `intensity` field on any rewriter / reformatter /
// emoji-aug block; the field then resolves to DEFAULT_INTENSITIES at
// the engine boundary, and generateBYOSID emits the same id whether
// the field is present-at-default or absent. This pins that
// equivalence for every transform field that has a default.

const DEFAULTS = {
  rewriter: { british: 100, typos: 17, voice: 100, xanax: 100 },
  reformatter: { case: 100, lineBreak: 100, sentenceEnd: 100, voice: 29 },
  augment: { emojiIntoWords: 1, wordsIntoEmoji: 1 },
};

const REWRITER_MODES = {
  british: 'us-uk', typos: 'forward', voice: 'pirate',
  // xanax has no mode
};
const REFORMATTER_MODES = {
  case: 'titleCase', lineBreak: 'expand', sentenceEnd: 'uptalk', voice: 'pirate',
};

function makeRewriterByos(name, withIntensity) {
  const field = withIntensity
    ? { enabled: true, intensity: DEFAULTS.rewriter[name] }
    : { enabled: true };
  if (REWRITER_MODES[name]) field.mode = REWRITER_MODES[name];
  return {
    version: 1, name: 'x', story: { style: 'flat' },
    rewriter: { [name]: field },
  };
}

function makeReformatterByos(name, withIntensity) {
  const field = withIntensity
    ? { enabled: true, intensity: DEFAULTS.reformatter[name], mode: REFORMATTER_MODES[name] }
    : { enabled: true, mode: REFORMATTER_MODES[name] };
  return {
    version: 1, name: 'x', story: { style: 'flat' },
    reformatter: { [name]: field },
  };
}

function makeAugByos(name, withIntensity) {
  const field = withIntensity
    ? { enabled: true, intensity: DEFAULTS.augment[name] }
    : { enabled: true };
  return {
    version: 1, name: 'x', story: { style: 'flat' },
    base: {
      sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc',
      augment: { [name]: field },
    },
  };
}

for (const name of Object.keys(DEFAULTS.rewriter)) {
  test(`intensity default: rewriter.${name} present-at-default == absent`, () => {
    const a = generateBYOSID(makeRewriterByos(name, true));
    const b = generateBYOSID(makeRewriterByos(name, false));
    assert.equal(b, a,
      `rewriter.${name}: byosID with intensity at default (${DEFAULTS.rewriter[name]}) ` +
      `must equal byosID with field omitted; got a=${a} b=${b}`);
  });
}

for (const name of Object.keys(DEFAULTS.reformatter)) {
  test(`intensity default: reformatter.${name} present-at-default == absent`, () => {
    const a = generateBYOSID(makeReformatterByos(name, true));
    const b = generateBYOSID(makeReformatterByos(name, false));
    assert.equal(b, a,
      `reformatter.${name}: byosID with intensity at default (${DEFAULTS.reformatter[name]}) ` +
      `must equal byosID with field omitted; got a=${a} b=${b}`);
  });
}

for (const name of Object.keys(DEFAULTS.augment)) {
  test(`intensity default: augment.${name} present-at-default == absent`, () => {
    const a = generateBYOSID(makeAugByos(name, true));
    const b = generateBYOSID(makeAugByos(name, false));
    assert.equal(b, a,
      `augment.${name}: byosID with intensity at default (${DEFAULTS.augment[name]}) ` +
      `must equal byosID with field omitted; got a=${a} b=${b}`);
  });
}
