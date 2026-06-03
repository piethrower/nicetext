// js/src/reformatter/voice.js: model-layer voice reformatter.
//
// Wraps each sentence model with voice-specific inserts. All four
// insertion families share the same safety story: each inserted
// slot resolves to a 0-bit unique-type singleton in the session
// dict (loaded via fixtures/reformatter-voice-<mode>.twlist.sab.gz
// at build time), so the decoder consumes no payload bits for the
// inserted word and round-trip survives byte-for-byte.
//
// Categories consumed today:
//   opener   one word at the start of each sentence model
//   closer   one word at the end of each sentence model
//   aside    one word after each comma-style punct in the model
//   sprinkle one word between WORD slots, with per-boundary coin
//            flip gated by the field's intensity
//
// sub_<word> (lexical substitution of a triggered canonical word
// with a per-voice replacement) belongs in the rewriter layer, not
// here: it mutates an existing emission rather than inserting a
// new one. That arc lands in a follow-up.
//
// The categories fixture stores WORDS, not pre-hash type names,
// sortdct's optional merged-type hashing means the dict's runtime
// type names don't match what the build pipeline emitted. enhance()
// resolves word -> typeIndex via the dict (lookupWord), and the
// encoder consumes the resulting `{kind:'type', typeIndex:N}`
// item the same as any other model slot.

import { lookupWord } from '../dictionary.js';

let voiceData = null;       // Map<category, Set<word>>
let voiceRandom = null;     // () -> [0, 1)
let voiceDict = null;       // dict ref for word->typeIndex lookup
let voiceIntensity = 100;   // % per-boundary fire for sprinkle

// Same wiring shape as the lookup-swap rewriters so encode.js can
// dispatch through the existing setRewriter* fan-out without a
// reformatter-specific code path. setRewriterData here receives the
// categories Map (category -> Set<word>).
export function setRewriterData(map) {
  voiceData = map;
}

// Intensity drives the per-boundary sprinkle coin flip. opener /
// closer / aside fire every time (one per sentence model / per
// comma); their cadence is structural, not probabilistic.
export function setRewriterIntensity(n) {
  voiceIntensity = Number.isInteger(n) && n >= 0 && n <= 100 ? n : 100;
}

export function setRewriterRandom(rng) {
  voiceRandom = typeof rng === 'function' ? rng : null;
}

// Dict dispatch, encode.js calls this with the active dict before
// any enhance() runs so word->typeIndex lookups land on the same
// SAB the encoder consumes.
export function setRewriterDict(dict) {
  voiceDict = dict || null;
}

export function _resetRewriterDataForTests() {
  voiceData = null;
  voiceRandom = null;
  voiceDict = null;
  voiceIntensity = 100;
}

function pickTypeIndexFor(category) {
  if (!voiceData || !voiceDict || !voiceRandom) return null;
  const words = voiceData.get(category);
  if (!words || words.size === 0) return null;
  const arr = [...words];
  const word = arr[Math.floor(voiceRandom() * arr.length)];
  const rec = lookupWord(voiceDict, word);
  if (!rec || rec.typeIndex == null) return null;
  return rec.typeIndex;
}

// True for punct items the lexer would tokenize as a PUNCT (or as
// part of EOS) and whose surface form contains a comma. genmodel
// wraps both PUNCT and EOS terminators in `^...^` quoted-literal
// puncts, so we test by literal inclusion rather than walking the
// lexer.
function isCommaPunct(it) {
  if (!it || it.kind !== 'punct') return false;
  const v = it.value;
  if (typeof v !== 'string') return false;
  // Quoted literals carry the surface comma verbatim.
  if (v.length >= 2 && v[0] === '^' && v[v.length - 1] === '^') {
    return v.includes(',');
  }
  // Bare PUNCT puncts are emitted character-by-character; treat a
  // bare comma value as a comma boundary.
  return v === ',';
}

function isWordItem(it) {
  return it && it.kind === 'type';
}

// Per-model entry point. Returns a NEW model (input is not mutated).
// Skips trivial single-type models (flat-mode emissions with no
// punctuation context) so voice doesn't sprinkle opener/closer
// between every WORD in flat covers.
export function enhance(model, opts) {
  if (!Array.isArray(model) || model.length === 0) return model;
  if (!voiceData || !voiceRandom || !voiceDict) return model;
  const opts_ = opts || {};
  if (opts_.mode == null) return model;
  if (Number.isInteger(opts_.intensity) && opts_.intensity <= 0) return model;

  // Skip flat-mode emissions: a model with no punct items is not a
  // sentence: wrapping it would emit voice tokens around every
  // WORD-slot pick, which reads as noise.
  const hasPunct = model.some(it => it.kind === 'punct');
  if (!hasPunct) return model;

  const out = [];
  // Per-insert coin: opener / closer / aside / sprinkle each pass
  // through the same gate so a low intensity reads as a lighter
  // voice rather than dropping only the sprinkles.
  const fire = () => (
    voiceIntensity >= 100
    || (voiceIntensity > 0 && voiceRandom() * 100 < voiceIntensity)
  );

  // opener at the start of the sentence model.
  if (fire()) {
    const idx = pickTypeIndexFor('opener');
    if (idx != null) out.push({ kind: 'type', typeIndex: idx });
  }

  // Walk the model. After each comma punct, insert an aside (coin
  // gated). Between adjacent WORD slots, sprinkle (coin gated).
  let prevWasWord = false;
  for (let i = 0; i < model.length; i++) {
    const it = model[i];
    if (isWordItem(it) && prevWasWord && fire()) {
      const idx = pickTypeIndexFor('sprinkle');
      if (idx != null) out.push({ kind: 'type', typeIndex: idx });
    }
    out.push(it);
    if (isCommaPunct(it) && fire()) {
      const idx = pickTypeIndexFor('aside');
      if (idx != null) out.push({ kind: 'type', typeIndex: idx });
    }
    if (isWordItem(it)) prevWasWord = true;
    else if (it.kind === 'punct') prevWasWord = false;
  }

  // closer at the end of the sentence model.
  if (fire()) {
    const idx = pickTypeIndexFor('closer');
    if (idx != null) out.push({ kind: 'type', typeIndex: idx });
  }
  return out;
}
