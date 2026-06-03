// reformatter.test.js: node smoke for js/src/reformatter/*.
//
// Covers the model-layer enhancer interface (case / lineBreak /
// sentenceEnd) and the chain wrapper. Pure unit tests, the encoder
// is not invoked. Wiring into encode.js lands in a later commit of
// the cover-transforms arc; this file pins the enhancer contracts
// independently so the next step can plug them in with no doubt
// about per-mode behavior.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import * as caseRf        from '../../js/src/reformatter/case.js';
import * as lineBreakRf   from '../../js/src/reformatter/lineBreak.js';
import * as sentenceEndRf from '../../js/src/reformatter/sentenceEnd.js';
import * as voiceRf       from '../../js/src/reformatter/voice.js';
import { wrapModelStreamWithReformatters, dispatchReformatterSetup } from '../../js/src/reformatter/index.js';
import { buildDictionary } from '../../js/src/builder/dct2mstr.js';
import { loadDictionary } from '../../js/src/dictionary.js';
import { generateModelTable } from '../../js/src/builder/genmodel.js';
import { loadModelTable, modelTableStream } from '../../js/src/modeltable.js';
import { mulberry32 } from '../../js/src/random.js';
import { encodeToString, decodeToBytes } from './_helpers.js';

// Test helpers: build models out of the same item shapes the encoder
// consumes: { kind: 'type', typeIndex|name } or { kind: 'punct',
// value: <string> }. quotedLiteral wraps a surface fragment in the
// `^...^` form genmodel uses to preserve corpus whitespace and EOS
// terminators byte-for-byte.
const T   = (i)  => ({ kind: 'type',  typeIndex: i });
const P   = (v)  => ({ kind: 'punct', value: v });
const QL  = (s)  => P(`^${s}^`);

// ----- case ---------------------------------------------------------

test('case: allLowercase strips Cap/CAPSLOCKON/capslockoff', async () => {
  const out = caseRf.enhance(
    [P('CAPSLOCKON'), P('Cap'), T(0), P('capslockoff'), T(1)],
    { mode: 'allLowercase' });
  assert.deepEqual(out, [T(0), T(1)]);
});

test('case: allCaps strips source case markers and wraps each type with CAPSLOCKON/capslockoff', async () => {
  // allCaps now per-slot wraps every type that passes the intensity
  // coin (default intensity=100 fires every time). This replaces the
  // older "single CAPSLOCKON at the start of the sentence" design so a
  // sub-100 intensity reads as "this type only shouts sometimes"
  // rather than "the whole sentence shouts or doesn't."
  const out = caseRf.enhance(
    [P('Cap'), T(0), T(1), QL('. ')],
    { mode: 'allCaps' });
  assert.deepEqual(out, [
    P('CAPSLOCKON'), T(0), P('capslockoff'),
    P('CAPSLOCKON'), T(1), P('capslockoff'),
    QL('. '),
  ]);
});

test('case: titleCase prefixes every type with Cap, strips existing case', async () => {
  const out = caseRf.enhance(
    [P('CAPSLOCKON'), T(0), P('Cap'), T(1), QL('. ')],
    { mode: 'titleCase' });
  assert.deepEqual(out, [P('Cap'), T(0), P('Cap'), T(1), QL('. ')]);
});

test('case: sentenceCase prefixes only the first type with Cap', async () => {
  const out = caseRf.enhance(
    [P('Cap'), T(0), T(1), T(2)],
    { mode: 'sentenceCase' });
  assert.deepEqual(out, [P('Cap'), T(0), T(1), T(2)]);
});

test('case: randomCaps fires per type slot at the configured rate', async () => {
  // Force the RNG so the assertion is deterministic: alternating
  // 0.0 / 0.99 with intensity 50 → first type fires, second doesn't,
  // third fires, ...
  let i = 0;
  const seq = [0.0, 0.99, 0.0, 0.99];
  const rng = () => seq[i++ % seq.length];
  const out = caseRf.enhance(
    [T(0), T(1), T(2), T(3)],
    { mode: 'randomCaps', intensity: 50, rng });
  assert.deepEqual(out, [P('Cap'), T(0), T(1), P('Cap'), T(2), T(3)]);
});

test('case: sentenceStartLower drops the leading Cap, keeps later Caps', async () => {
  const out = caseRf.enhance(
    [P('Cap'), T(0), P('Cap'), T(1), T(2)],
    { mode: 'sentenceStartLower' });
  assert.deepEqual(out, [T(0), P('Cap'), T(1), T(2)]);
});

test('case: sentenceStartLower with no leading Cap is a no-op', async () => {
  const out = caseRf.enhance(
    [T(0), P('Cap'), T(1)],
    { mode: 'sentenceStartLower' });
  assert.deepEqual(out, [T(0), P('Cap'), T(1)]);
});

test('case: enhance does not mutate input', async () => {
  const input = [P('Cap'), T(0), T(1)];
  const snapshot = JSON.stringify(input);
  caseRf.enhance(input, { mode: 'allLowercase' });
  assert.equal(JSON.stringify(input), snapshot);
});

test('case: unknown mode throws', async () => {
  assert.throws(() => caseRf.enhance([T(0)], { mode: 'BIZARRE' }),
    /unknown mode/);
});

// ----- lineBreak ----------------------------------------------------

test('lineBreak: expand doubles every \\n inside ^...^ literals', async () => {
  const out = lineBreakRf.enhance(
    [T(0), QL('. \n'), T(1), QL('\n\n')],
    { mode: 'expand' });
  assert.deepEqual(out, [T(0), QL('. \n\n'), T(1), QL('\n\n\n\n')]);
});

test('lineBreak: collapse merges runs of \\n inside ^...^ literals', async () => {
  const out = lineBreakRf.enhance(
    [T(0), QL('\n\n\n'), T(1)],
    { mode: 'collapse' });
  assert.deepEqual(out, [T(0), QL('\n'), T(1)]);
});

test('lineBreak: leaves Cap / non-literal puncts untouched', async () => {
  const out = lineBreakRf.enhance(
    [P('Cap'), T(0), P('.'), QL('\n')],
    { mode: 'expand' });
  assert.deepEqual(out, [P('Cap'), T(0), P('.'), QL('\n\n')]);
});

test('lineBreak: unknown mode throws', async () => {
  assert.throws(() => lineBreakRf.enhance([T(0)], { mode: 'BIZARRE' }),
    /unknown mode/);
});

// ----- sentenceEnd --------------------------------------------------

test('sentenceEnd: uptalk at intensity 100 swaps every EOS . for ?', async () => {
  const out = sentenceEndRf.enhance(
    [T(0), QL('. '), T(1), QL('. \n')],
    { mode: 'uptalk', intensity: 100 });
  assert.deepEqual(out, [T(0), QL('? '), T(1), QL('? \n')]);
});

test('sentenceEnd: excitement at intensity 100 swaps every EOS . for !', async () => {
  const out = sentenceEndRf.enhance(
    [T(0), QL('. \n')],
    { mode: 'excitement', intensity: 100 });
  assert.deepEqual(out, [T(0), QL('! \n')]);
});

test('sentenceEnd: intensity 0 is a no-op', async () => {
  const out = sentenceEndRf.enhance(
    [T(0), QL('. ')],
    { mode: 'uptalk', intensity: 0 });
  assert.deepEqual(out, [T(0), QL('. ')]);
});

test('sentenceEnd: partial intensity uses the rng coin flip', async () => {
  // Two EOS literals; rng yields 0.1 then 0.9. Intensity 50 fires
  // when rng() * 100 < 50, so only the first swap fires.
  let i = 0;
  const seq = [0.1, 0.9];
  const rng = () => seq[i++];
  const out = sentenceEndRf.enhance(
    [QL('. '), T(0), QL('. ')],
    { mode: 'uptalk', intensity: 50, rng });
  assert.deepEqual(out, [QL('? '), T(0), QL('. ')]);
});

test('sentenceEnd: leaves bare . PUNCT (mid-sentence) alone', async () => {
  // Bare '.' (length 1, not wrapped in ^...^) represents a mid-
  // sentence period; sentenceEnd targets sentence terminators only.
  const out = sentenceEndRf.enhance(
    [T(0), P('.'), T(1)],
    { mode: 'uptalk', intensity: 100 });
  assert.deepEqual(out, [T(0), P('.'), T(1)]);
});

test('sentenceEnd: unknown mode throws', async () => {
  assert.throws(() => sentenceEndRf.enhance([T(0)],
    { mode: 'BIZARRE', intensity: 100 }), /unknown mode/);
});

// ----- chain wrapper -----------------------------------------------

function constantStream(model) {
  let n = 0;
  return {
    next() {
      n++;
      return model.map(it => ({ ...it }));
    },
    _count() { return n; },
  };
}

test('wrap: no reformatter returns the same stream object', async () => {
  const stream = constantStream([T(0)]);
  assert.strictEqual(wrapModelStreamWithReformatters(stream, null, null), stream);
  assert.strictEqual(wrapModelStreamWithReformatters(stream, undefined, null), stream);
  assert.strictEqual(wrapModelStreamWithReformatters(stream, {}, null), stream);
});

test('wrap: every-field-disabled returns the same stream object', async () => {
  const stream = constantStream([T(0)]);
  const cfg = {
    case:      { enabled: false, intensity: 100, mode: 'titleCase' },
    lineBreak: { enabled: false, intensity: 100, mode: 'expand'    },
  };
  assert.strictEqual(wrapModelStreamWithReformatters(stream, cfg, null), stream);
});

test('wrap: chain runs voice -> lineBreak -> sentenceEnd -> case in order', async () => {
  const stream = constantStream([P('Cap'), T(0), QL('. \n')]);
  const cfg = {
    case:        { enabled: true, intensity: 100, mode: 'allLowercase' },
    lineBreak:   { enabled: true, intensity: 100, mode: 'expand' },
    sentenceEnd: { enabled: true, intensity: 100, mode: 'excitement' },
  };
  const wrapped = wrapModelStreamWithReformatters(stream, cfg, () => 0.0);
  const out = wrapped.next();
  assert.deepEqual(out, [T(0), QL('! \n\n')]);
});

test('wrap: zero-intensity field is treated as disabled', async () => {
  const stream = constantStream([P('Cap'), T(0)]);
  const cfg = {
    case: { enabled: true, intensity: 0, mode: 'allLowercase' },
  };
  assert.strictEqual(wrapModelStreamWithReformatters(stream, cfg, null), stream);
});

// ----- voice --------------------------------------------------------

function resetVoice() {
  voiceRf._resetRewriterDataForTests();
}

// Synthetic dict for voice tests: includes the pirate voice
// singletons (one type per word) so voice.enhance can resolve
// word -> typeIndex via lookupWord. The actual session-build dict
// pipeline produces equivalent singletons; this test dict lets us
// exercise enhance() without spinning up the full builder.
import { lookupWord } from '../../js/src/dictionary.js';
const VOICE_TWLIST = [
  { type: 'reformatter_voice_pirate_opener_0', word: 'arr' },
  { type: 'reformatter_voice_pirate_opener_1', word: 'avast' },
  { type: 'reformatter_voice_pirate_opener_2', word: 'yarr' },
  { type: 'reformatter_voice_pirate_closer_0', word: 'matey' },
  { type: 'reformatter_voice_pirate_closer_1', word: 'yarrr' },
];
const VOICE_DICT = loadDictionary(buildDictionary(VOICE_TWLIST, { name: 'voice-test-dict' }));
function voiceWordTypeIndex(word) {
  return lookupWord(VOICE_DICT, word).typeIndex;
}

test('voice: enhance is a no-op without data', async () => {
  resetVoice();
  voiceRf.setRewriterRandom(() => 0.0);
  voiceRf.setRewriterDict(VOICE_DICT);
  const model = [T(0), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.deepEqual(out, model);
});

test('voice: enhance is a no-op without rng', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  const model = [T(0), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.deepEqual(out, model, 'no rng -> bail');
});

test('voice: enhance is a no-op without dict', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
  ]));
  voiceRf.setRewriterRandom(() => 0.0);
  // setRewriterDict deliberately omitted
  const model = [T(0), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.deepEqual(out, model, 'no dict -> bail');
});

test('voice: enhance skips flat-mode models (no puncts present)', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  const model = [T(0), T(1), T(2)];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.deepEqual(out, model, 'punct-free model should pass through');
});

test('voice: enhance wraps a sentence model with opener and closer', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  const model = [T(0), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.equal(out.length, 4, 'expected opener + type + punct + closer');
  assert.equal(out[0].kind, 'type');
  assert.equal(typeof out[0].typeIndex, 'number');
  // Position 1 is the original T(0); 2 is the punct; 3 is closer.
  assert.deepEqual(out[1], T(0));
  assert.deepEqual(out[2], QL('. '));
  assert.equal(out[3].kind, 'type');
  assert.equal(typeof out[3].typeIndex, 'number');
});

test('voice: enhance picks deterministically with the supplied rng', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr', 'avast', 'yarr'])],
    ['closer', new Set(['matey', 'yarrr'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  // First rng draw is for opener (3 candidates -> index 0 with
  // sorted array: ['arr', 'avast', 'yarr']); second is for closer
  // (2 candidates -> index 1 with 0.6 -> 'yarrr').
  // Note: Set iteration order is insertion order, so the array
  // built inside enhance is the same as the Set's insertion order.
  let i = 0;
  const seq = [0.0, 0.6];
  voiceRf.setRewriterRandom(() => seq[i++]);
  const model = [T(0), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  // The opener should resolve to 'arr' (Set index 0), closer to
  // 'yarrr' (Set index 1 of 2, 0.6 * 2 = 1.2 -> floor 1).
  assert.equal(out[0].typeIndex,           voiceWordTypeIndex('arr'));
  assert.equal(out[out.length - 1].typeIndex, voiceWordTypeIndex('yarrr'));
});

test('voice: enhance does not mutate the input model', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  const model = [T(0), QL('. ')];
  const snapshot = JSON.stringify(model);
  voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  assert.equal(JSON.stringify(model), snapshot);
});

test('voice: enhance inserts aside after each comma punct', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
    ['aside',  new Set(['yarr'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  // Model: WORD, ", ", WORD, ". " (one comma in the middle).
  const model = [T(0), QL(', '), T(1), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  // Expected: opener, T(0), ",", aside, T(1), ".", closer
  assert.equal(out.length, 7);
  assert.equal(out[0].typeIndex, voiceWordTypeIndex('arr'));     // opener
  assert.deepEqual(out[1], T(0));
  assert.deepEqual(out[2], QL(', '));
  assert.equal(out[3].typeIndex, voiceWordTypeIndex('yarr'));    // aside
  assert.deepEqual(out[4], T(1));
  assert.deepEqual(out[5], QL('. '));
  assert.equal(out[6].typeIndex, voiceWordTypeIndex('matey'));   // closer
});

test('voice: aside ignored when only sentence-end punct (no comma)', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener', new Set(['arr'])],
    ['closer', new Set(['matey'])],
    ['aside',  new Set(['yarr'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  // Sentence ends with `^. ^` (no comma). aside should not fire.
  const model = [T(0), T(1), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  // opener, T(0), T(1), ".", closer, no aside.
  assert.equal(out.length, 5);
  assert.equal(out[0].typeIndex, voiceWordTypeIndex('arr'));
  assert.equal(out[4].typeIndex, voiceWordTypeIndex('matey'));
});

test('voice: sprinkle inserts between adjacent WORD slots when intensity fires', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener',   new Set(['arr'])],
    ['closer',   new Set(['matey'])],
    ['sprinkle', new Set(['yarr'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  // The voice reformatter coin-gates every insertion (opener, closer,
  // aside, sprinkle) by voiceIntensity so a low intensity reads as a
  // lighter voice rather than dropping only the sprinkles. Each
  // insertion that fires consumes TWO randoms: one for the coin, one
  // for the word pick. At intensity=50 the coin fires iff r*100 < 50.
  //
  // RNG sequence consumed in order:
  //   opener  coin (0.0 < 50 -> fire) + pick (0.0 -> 'arr')
  //   T(0)-T(1) sprinkle coin (0.1 < 50 -> fire) + pick (0.0 -> 'yarr')
  //   T(1)-T(2) sprinkle coin (0.9 >= 50 -> skip; no pick consumed)
  //   closer  coin (0.0 < 50 -> fire) + pick (0.0 -> 'matey')
  let i = 0;
  const seq = [0.0, 0.0, 0.1, 0.0, 0.9, 0.0, 0.0];
  voiceRf.setRewriterRandom(() => seq[i++]);
  voiceRf.setRewriterIntensity(50);
  const model = [T(0), T(1), T(2), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 50 });
  // Expected: opener, T(0), sprinkle, T(1), T(2), ".", closer
  assert.equal(out.length, 7);
  assert.equal(out[0].typeIndex, voiceWordTypeIndex('arr'));
  assert.deepEqual(out[1], T(0));
  assert.equal(out[2].typeIndex, voiceWordTypeIndex('yarr'));
  assert.deepEqual(out[3], T(1));
  assert.deepEqual(out[4], T(2));
  assert.deepEqual(out[5], QL('. '));
  assert.equal(out[6].typeIndex, voiceWordTypeIndex('matey'));
});

test('voice: nothing fires at module intensity 0 (sprinkle, opener, and closer all coin-gated)', async () => {
  resetVoice();
  voiceRf.setRewriterData(new Map([
    ['opener',   new Set(['arr'])],
    ['closer',   new Set(['matey'])],
    ['sprinkle', new Set(['yarr'])],
  ]));
  voiceRf.setRewriterDict(VOICE_DICT);
  voiceRf.setRewriterRandom(() => 0.0);
  voiceRf.setRewriterIntensity(0);
  const model = [T(0), T(1), T(2), QL('. ')];
  const out = voiceRf.enhance(model, { mode: 'pirate', intensity: 100 });
  // opts.intensity=100 prevents the top-level bail at the start of
  // enhance(), but every insertion (opener / closer / sprinkle / aside)
  // is then gated by the module-level voiceIntensity coin. With
  // voiceIntensity=0 the coin never fires, so the output is the model
  // unchanged: T(0), T(1), T(2), '.' = 4 items.
  assert.equal(out.length, 4);
});

// ----- dispatchReformatterSetup ------------------------------------

test('dispatch: voice receives data + rng + dict via setRewriter*', async () => {
  resetVoice();
  const reformatter = {
    voice: { enabled: true, intensity: 100, mode: 'pirate' },
  };
  const data = {
    voice: new Map([
      ['opener', new Set(['arr'])],
      ['closer', new Set(['matey'])],
    ]),
  };
  const rng = () => 0.0;
  dispatchReformatterSetup(reformatter, data, rng, VOICE_DICT);
  const out = voiceRf.enhance(
    [T(0), QL('. ')],
    { mode: 'pirate', intensity: 100 });
  assert.equal(out.length, 4, 'expected opener + type + punct + closer');
  assert.equal(out[0].kind, 'type');
});

// ----- end-to-end round-trip via encode()/decode() -----------------
//
// Confirms each reformatter mode preserves round-trip correctness
// (the only critical function of NiceText, see memory
// project_round_trip_is_critical). Builds a tiny dict + corpus once,
// then encodes a payload with each reformatter config and verifies
// the decoded bytes match the source exactly.

const RT_TWLIST = [
  { type: 'noun', word: 'apple' },  { type: 'noun', word: 'banana' },
  { type: 'noun', word: 'cherry' }, { type: 'noun', word: 'date' },
  { type: 'verb', word: 'eats' },   { type: 'verb', word: 'tastes' },
  { type: 'adj',  word: 'fresh' },  { type: 'adj',  word: 'ripe' },
];
const RT_DICT  = loadDictionary(buildDictionary(RT_TWLIST, { name: 'reformatter-rt' }));
const RT_CORPUS = 'The fresh apple tastes ripe. A banana eats cherry. Ripe date.';
const RT_MODEL  = loadModelTable(await generateModelTable(RT_CORPUS, RT_DICT, { name: 'reformatter-rt-corpus' }));
const RT_PAYLOAD = new Uint8Array([0x42, 0x13, 0xa7, 0x55, 0x91, 0x2c, 0xff, 0x00]);

function rtModelStream(seed) {
  return modelTableStream(RT_MODEL, { random: mulberry32(seed), dict: RT_DICT });
}

async function rtRoundTrip(reformatter, seed = 1) {
  const cover = await encodeToString(RT_PAYLOAD, RT_DICT, {
    modelStream: rtModelStream(seed),
    reformatter,
  });
  const recovered = await decodeToBytes(cover, RT_DICT);
  return { cover, recovered };
}

const RT_CASE_MODES = [
  'allCaps', 'allLowercase', 'titleCase', 'sentenceCase',
  'randomCaps', 'sentenceStartLower',
];

for (const mode of RT_CASE_MODES) {
  test(`round-trip via encode: case mode "${mode}"`, async () => {
    const { recovered } = await rtRoundTrip({
      case: { enabled: true, intensity: 100, mode },
    });
    assert.deepEqual(recovered, RT_PAYLOAD,
      `case=${mode}: decoded bytes diverge`);
  });
}

for (const mode of ['expand', 'collapse']) {
  test(`round-trip via encode: lineBreak mode "${mode}"`, async () => {
    const { recovered } = await rtRoundTrip({
      lineBreak: { enabled: true, intensity: 100, mode },
    });
    assert.deepEqual(recovered, RT_PAYLOAD,
      `lineBreak=${mode}: decoded bytes diverge`);
  });
}

for (const mode of ['uptalk', 'excitement']) {
  test(`round-trip via encode: sentenceEnd mode "${mode}"`, async () => {
    const { recovered } = await rtRoundTrip({
      sentenceEnd: { enabled: true, intensity: 100, mode },
    });
    assert.deepEqual(recovered, RT_PAYLOAD,
      `sentenceEnd=${mode}: decoded bytes diverge`);
  });
}

test('round-trip via encode: voice (pirate) inserts opener + closer', async () => {
  // Build a synthetic dict that includes voice singletons alongside
  // the corpus vocabulary. Each voice typename is unique to its word,
  // matching the build-pipeline output shape from
  // tools/build-rewriter-fixtures.js for voice mode 'pirate'.
  const twlistWithVoice = [
    ...RT_TWLIST,
    { type: 'reformatter_voice_pirate_opener_0', word: 'arr' },
    { type: 'reformatter_voice_pirate_opener_1', word: 'avast' },
    { type: 'reformatter_voice_pirate_closer_0', word: 'matey' },
    { type: 'reformatter_voice_pirate_closer_1', word: 'yarrr' },
  ];
  const dict  = loadDictionary(buildDictionary(twlistWithVoice, { name: 'voice-rt' }));
  const model = loadModelTable(await generateModelTable(RT_CORPUS, dict, { name: 'voice-rt-corpus' }));
  const voiceData = new Map([
    ['opener', new Set(['arr', 'avast'])],
    ['closer', new Set(['matey', 'yarrr'])],
  ]);
  const cover = await encodeToString(RT_PAYLOAD, dict, {
    modelStream: modelTableStream(model, { random: mulberry32(1), dict }),
    reformatter: {
      voice: { enabled: true, intensity: 100, mode: 'pirate' },
    },
    reformatterData: { voice: voiceData },
  });
  const recovered = await decodeToBytes(cover, dict);
  assert.deepEqual(recovered, RT_PAYLOAD, 'voice round-trip diverged');
  // At least one of the four voice words should land in the cover,
  // voice fires on every sentence model the corpus produced.
  const voiceWords = ['arr', 'avast', 'matey', 'yarrr'];
  const hits = voiceWords.filter(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(cover));
  assert.ok(hits.length > 0,
    `expected at least one voice word in cover; cover head: ${cover.slice(0, 200)}`);
});

test('round-trip via encode: full chain (case + lineBreak + sentenceEnd)', async () => {
  const { cover, recovered } = await rtRoundTrip({
    case:        { enabled: true, intensity: 100, mode: 'titleCase' },
    lineBreak:   { enabled: true, intensity: 100, mode: 'expand'    },
    sentenceEnd: { enabled: true, intensity: 100, mode: 'excitement' },
  });
  assert.deepEqual(recovered, RT_PAYLOAD);
  // titleCase + excitement: cover should contain uppercased word
  // starts and at least one '!' EOS-style terminator. Belt-and-
  // suspenders sanity check that the enhancers actually fired.
  assert.match(cover, /[A-Z][a-z]/, 'expected at least one titleCase word');
  assert.match(cover, /!/, 'expected at least one ! from excitement mode');
});
