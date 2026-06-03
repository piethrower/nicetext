// Reference implementations of the augmentation passes, kept as
// ground-truth oracles for the SAB-native production paths in
// js/src/builder/aug-impls-sab.js and the orchestrator in
// js/src/builder/aug-pipeline.js. Pure JS-object data transforms; no
// SAB, no workers. The production code never imports these, they
// live under tests/ because their only consumers are the SAB-vs-legacy
// equivalence assertions and the historical tmp/ probes.
//
// Aug A and Aug B follow the spec at docs/phrase-and-charset-spec.md §C
// (mix as int 0..MIX_MAX folded into A/B's per-tuple emit loop). The
// vowel aug mirrors the OG twlist/Makefile awk transform.

const EMOJI_TEST_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const MIX_MAX = 10;

function looksLikeEmoji(v) {
  return EMOJI_TEST_RE.test(v);
}

function clampMix(raw) {
  const n = (raw | 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > MIX_MAX ? MIX_MAX : n;
}

export function applyEmojiAugmentation(entries, opts = {}) {
  const cldr = opts.cldr || null;
  const emojiIntoWords = !!opts.emojiIntoWords;
  const wordsIntoEmoji = !!opts.wordsIntoEmoji;
  const mix = clampMix(opts.mixedPhrases);
  const curated = opts.curatedKeywords instanceof Set ? opts.curatedKeywords : null;

  if (!cldr || (!emojiIntoWords && !wordsIntoEmoji)) return entries;

  const wordTypes = new Map();
  const emojiHomeTypes = new Map();
  for (const e of entries) {
    if (!wordTypes.has(e.word)) wordTypes.set(e.word, new Set());
    wordTypes.get(e.word).add(e.type);
    if (looksLikeEmoji(e.word)) {
      if (!emojiHomeTypes.has(e.word)) emojiHomeTypes.set(e.word, new Set());
      emojiHomeTypes.get(e.word).add(e.type);
    }
  }

  const augmented = [...entries];
  const seen = new Set(entries.map(e => `${e.type}\t${e.word}`));
  function emit(type, word) {
    const key = `${type}\t${word}`;
    if (seen.has(key)) return;
    seen.add(key);
    augmented.push({ type, word });
  }
  function emitMixVariants(T, k, emoji) {
    if (mix <= 0) return;
    let repeated = '';
    for (let n = 1; n <= mix; n++) {
      repeated += emoji;
      emit(T, `${k} ${repeated}`);
      if (n >= 2) emit(T, repeated);
    }
  }

  for (const [emoji, homeTypes] of emojiHomeTypes) {
    const rawKeywords = cldr[emoji] || [];
    const keywords = curated
      ? rawKeywords.filter(k => curated.has(k))
      : rawKeywords;
    if (keywords.length === 0) continue;

    if (emojiIntoWords) {
      for (const k of keywords) {
        const targetTypes = wordTypes.get(k);
        if (!targetTypes) continue;
        for (const T of targetTypes) {
          if (homeTypes.has(T)) continue;
          emit(T, emoji);
          emitMixVariants(T, k, emoji);
        }
      }
    }

    if (wordsIntoEmoji) {
      for (const k of keywords) {
        if (!wordTypes.has(k)) continue;
        for (const T_E of homeTypes) {
          emit(T_E, k);
          emitMixVariants(T_E, k, emoji);
        }
      }
    }
  }

  return augmented;
}

// applyVowelAugmentation removed with the cover-transforms arc; the
// xanax rewriter (js/src/rewriter/xanax.js) now handles a/an
// agreement at encode time rather than via build-time type tagging.
