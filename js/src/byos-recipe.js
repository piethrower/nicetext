// byos-recipe.js: translate the BYOS modal's advanced-mode recipe
// (the share.js encodeRecipe shape stored on currentSelection.recipe in
// js/app.js) into a public-spec byos.json suitable for generateBYOSID
// and findCardByBYOSID. Browser-safe ESM, zero deps.
//
// The two formats carry the same settings under different field names:
//   recipe.story         → byos.story.style
//   recipe.scope         → byos.story.sentence
//   recipe.useCorpus     → byos.story.vocabulary ('corpus' | 'base')
//   recipe.sources       → byos.base.sources
//   recipe.customTw      → adds 'customtw' flag to base.sources
//   recipe.freqs         → byos.base.frequencies
//   recipe.tieBreak      → byos.base.tieBreak (engine 'length-desc' →
//                          schema 'prefer-shorter')
//   recipe.rewriter      → byos.rewriter (universal cover-transform
//                          field shape, see docs/cover-transforms.md)
//   recipe.reformatter   → byos.reformatter (same universal shape)
//
// Returns null for non-advanced recipes (chip-mode → byos translation
// is a separate concern, handled by callers via findCardByName once it
// lands).

function copyCoverTransformField(value, allowMode) {
  if (!value || typeof value !== 'object') return null;
  if (value.enabled !== true) return null;
  const intensity = value.intensity;
  if (!Number.isInteger(intensity) || intensity <= 0 || intensity > 100) return null;
  const out = { enabled: true, intensity };
  if (allowMode && typeof value.mode === 'string' && value.mode.length > 0) {
    out.mode = value.mode;
  }
  return out;
}

export function recipeToByos(recipe) {
  if (!recipe || recipe.kind !== 'advanced') return null;
  const byos = { version: 1, name: '_runtime' };
  if (recipe.story === 'flat') {
    byos.story = { style: 'flat' };
  } else {
    byos.story = {
      style: recipe.story === 'custom' ? 'custom' : recipe.story,
      sentence: recipe.scope || 'random',
      vocabulary: recipe.useCorpus ? 'corpus' : 'base',
    };
  }
  const sources = [...(recipe.sources || [])];
  // recipe.sources already includes 'customtw' when customTw is on
  // (set by the app.js Build pipeline so share.js's "Check X, Y, Z"
  // recipe text mentions it). Guard against double-pushing here so
  // panelToByos and recipeToByos produce identical sources arrays
  // and therefore identical byosIDs.
  if (recipe.customTw && !sources.includes('customtw')) sources.push('customtw');
  byos.base = {
    sources,
    frequencies: recipe.freqs || [],
    // Engine uses 'length-desc' internally; schema uses 'prefer-shorter'
    // (a more readable surface name). Translate.
    tieBreak: recipe.tieBreak === 'length-desc' ? 'prefer-shorter' : 'alpha-asc',
  };
  const aug = {};
  // Each emoji aug carries {enabled, intensity}: intensity 0..MIX_MAX
  // is the repetition depth layered on top of the single-token swap.
  // Recipe fields use the per-aug-flattened shape (recipe.emojiIntoWords
  // = enabled, recipe.emojiIntoWordsIntensity = N).
  if (recipe.emojiIntoWords) {
    aug.emojiIntoWords = {
      enabled: true,
      intensity: Number.isInteger(recipe.emojiIntoWordsIntensity)
        ? Math.max(0, recipe.emojiIntoWordsIntensity) : 0,
    };
  }
  if (recipe.wordsIntoEmoji) {
    aug.wordsIntoEmoji = {
      enabled: true,
      intensity: Number.isInteger(recipe.wordsIntoEmojiIntensity)
        ? Math.max(0, recipe.wordsIntoEmojiIntensity) : 0,
    };
  }
  if (Object.keys(aug).length > 0) byos.base.augment = aug;
  // Cover-transforms rewriter block, copy each enabled, positive-
  // intensity field. typos / british / voice carry mode; xanax does not.
  if (recipe.rewriter && typeof recipe.rewriter === 'object') {
    const out = {};
    for (const [k, allowMode] of [
      ['british', true], ['typos', true], ['voice', true], ['xanax', false],
    ]) {
      const f = copyCoverTransformField(recipe.rewriter[k], allowMode);
      if (f) out[k] = f;
    }
    if (Object.keys(out).length > 0) byos.rewriter = out;
  }
  // Cover-transforms reformatter block, same universal shape. All
  // current fields (case / lineBreak / sentenceEnd / voice) carry mode.
  if (recipe.reformatter && typeof recipe.reformatter === 'object') {
    const out = {};
    for (const k of ['case', 'lineBreak', 'sentenceEnd', 'voice']) {
      const f = copyCoverTransformField(recipe.reformatter[k], true);
      if (f) out[k] = f;
    }
    if (Object.keys(out).length > 0) byos.reformatter = out;
  }
  return byos;
}
