// Style-recipe share helpers. Browser-safe ESM, no deps.
//
// A recipe captures the inputs needed to reproduce the active Decoder
// Dictionary on a recipient's page, not the dictionary contents
// (rule 27, no persistence; the dict is derivable from the recipe by
// running the same build pipeline).
//
// Recipe shapes (used internally by js/app.js):
//
//   { kind: 'chip', chipId: 'aesop' }
//
//   { kind: 'advanced', story: 'shakespeare',
//     sources: ['impf2p', 'mit'],
//     useCorpus: true, scope: 'random',
//     rewriter:    { xanax: { enabled: true, intensity: 100 } },
//     reformatter: { lineBreak: { enabled: true, intensity: 100, mode: 'expand' } } }
//
//   { kind: 'advanced', story: 'custom', sources: [...], ... }
//   Custom corpus carries no filename or content hash. The corpus
//   file is the recipient's responsibility; sender hands it over via
//   whatever channel they prefer. A hash in the URL would smell like
//   a crypto-key handshake; the framing here is "try this style,"
//   not "verify this artifact."
//
// URL emission: there is one URL form: nicetext.html#${getBYOSID(byos, cards)}.
// js/app.js's shareURL function builds it via js/src/byos.js getBYOSID; the
// result is either a rev-suffixed nickname (e.g. "aesop-1") or the
// long-form byosID (e.g. "v=1__sty=..."). This module no longer encodes
// recipes into URLs -- only the "describe in plain English" function below
// remains, used for the share-modal text instructions.

// Render a plain-text English description of the recipe in a casual
// "try this style" voice. Never crypto-flavored ("recipe" / "key" /
// "hash"). The output is the recipient-facing payload: it's what gets
// pasted into chat, used as a mailto body, etc. Sender-facing chrome
// (warnings, button labels) is handled in the modal HTML/JS, not here.
//
// Curated chip:      single line, "Try this style on NiceText, pick the X card."
// Built-in advanced: multi-line steps, "Try this style on NiceText. / Open ... / Check ... / ..."
// Custom corpus:     same shape, with "Upload the corpus file I sent you." (no name, no hash).

// Casual short-name for each story style. Card-bound styles read
// card.casualLabel from cards.data.js; reserved 'flat' and 'custom'
// are hand-cased. The page dropdown shows the long form ("Shakespeare
// Style"); the short form here ("Shakespeare") matches the salient
// prefix of the dropdown option, which is enough for the recipient to
// find it.
import cardsRegistry from '../../fixtures/cards.data.js';
function casualLabel(style) {
  if (style === 'flat') return 'Flat';
  if (style === 'custom') return 'Custom';
  const card = cardsRegistry.find(c => c.story?.style === style);
  return card?.casualLabel || style;
}

// SOURCE_LABELS: share-URL human-readable labels for twlist sources.
// One of FOUR hardcoded lists that must stay in sync when adding a new
// twlist source:
//   1. js/src/byos.js               SOURCE_NAMES          (byos schema validation)
//   2. js/src/share.js              SOURCE_LABELS         (this file, share-URL labels)
//   3. js/app.js                    ADV_SOURCE_KEYS       (Pro tab picker render allowlist)
//   4. js/src/worker/build-session-worker.js  KNOWN_TWLIST_KEYS  (runtime accept check)
// Missing entries here fall back to the raw key (not fatal, but ugly).
const SOURCE_LABELS = {
  impf2p: 'Synonyms (Frog2Prince)',
  impkimmo: 'Morphology (KIMMO)',
  impkimmo2026: 'Morphology (KIMMO2026)',
  ['impkimmo2026-cform']: 'Contractions (KIMMO2026)',
  ['impkimmo2026-root']: 'Word roots (KIMMO2026)',
  ['impkimmo2026-rootpos']: 'Source POS (KIMMO2026)',
  ['impkimmo2026-drvstem']: 'Derivation flag (KIMMO2026)',
  mit: 'Names and Places (MIT)',
  ['num-form-preserved']: 'Numbers (form preserved)',
  ['num-form-interchangeable']: 'Numbers (form interchangeable)',
  ['num-roman']: 'Roman Numerals',
  rhyme: 'Rhymes',
  ['cmu-syllable']: 'Syllable Count',
  ['cmu-stress']: 'Stress Pattern',
  ['cmu-alliteration']: 'Alliteration',
  claude2026: 'Modern Words',
  connectors: 'Example Connector Words',
  ['proglang-keywords']: 'Programming Keywords',
  ['moby-pos']: 'Parts of Speech (Moby)',
  ['moby-thesaurus']: 'Synonyms (Moby)',
  wordnet: 'Parts of Speech (WordNet)',
  ['wordnet-synonyms']: 'Synonyms (WordNet)',
  emoji16: 'Emoji (Unicode 16)',
  ['emoji-cldr-names-16']: 'Emoji Names (CLDR 48)',
  ['emoji16-curated-keywords']: 'Emoji Curated Keywords (CLDR 48)',
  ['emoji-curated-phrases-16']: 'Curated Emoji Phrases',
  customtw: 'Custom',
};

const SCOPE_LABELS = {
  random: 'Random pick from sentence patterns',
  sequential: 'Replay patterns in original order',
};

function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Map a freq-picker key to the label the recipient sees on the
// checkbox. The 'style' key is dynamic, it follows the recipe's
// story choice, and lines up with the BYOS UI's "<Style> frequencies"
// checkbox.
function freqSourceLabel(key, story) {
  if (key === 'norvig') return 'Norvig (web)';
  if (key === 'google') return 'Google Books';
  if (key === 'gutenberg') return 'Project Gutenberg';
  if (key === 'style') {
    return `${casualLabel(story)} frequencies`;
  }
  return null;
}

export function describeRecipe(recipe) {
  if (!recipe) return '';
  if (recipe.kind === 'chip') {
    const label = recipe.chipLabel || recipe.chipId;
    return `Try this style on NiceText, pick the "${label}" card.`;
  }
  if (recipe.kind === 'advanced') {
    const lines = [];
    lines.push('Try this style on NiceText.');
    lines.push('Open "Build Your Own Style".');
    if (Array.isArray(recipe.sources) && recipe.sources.length) {
      const srcLabels = [...recipe.sources]
        .map((s) => SOURCE_LABELS[s] || s)
        .sort();
      lines.push(`Check ${joinList(srcLabels)}.`);
    }
    if (recipe.emojiIntoWords) {
      const n = Number.isInteger(recipe.emojiIntoWordsIntensity)
        ? recipe.emojiIntoWordsIntensity : 0;
      lines.push(`Tick "Emoji into word types" (intensity ${n}).`);
    }
    if (recipe.wordsIntoEmoji) {
      const n = Number.isInteger(recipe.wordsIntoEmojiIntensity)
        ? recipe.wordsIntoEmojiIntensity : 0;
      lines.push(`Tick "Words into emoji types" (intensity ${n}).`);
    }
    lines.push(`Set Story Style to ${casualLabel(recipe.story)}.`);
    // Integrate both custom uploads into one line when both are active,
    // so the recipient gets a single "you'll also need these files" beat
    // instead of two separate "and also..." asides.
    const needsCorpus = recipe.story === 'custom';
    const needsTwlist = !!recipe.customTw;
    if (needsCorpus && needsTwlist) {
      lines.push('Upload the corpus file and the word-list file I sent you.');
    } else if (needsCorpus) {
      lines.push('Upload the corpus file I sent you.');
    } else if (needsTwlist) {
      lines.push('Upload the word-list file I sent you.');
    }
    if (recipe.story !== 'flat') {
      lines.push(
        recipe.useCorpus
          ? 'Set Vocabulary Scope to "Only use words from the story".'
          : 'Set Vocabulary Scope to "Expand the vocabulary to include words from the base dictionary".'
      );
      lines.push(`Set Sentence Scope to "${SCOPE_LABELS[recipe.scope] || recipe.scope}".`);
    }
    // Word Frequencies picker. Recipe.freqs is null when the picker
    // was hidden (useCorpus=true case), skip the line entirely.
    // Otherwise render exactly what the sender ticked, including the
    // empty-array case (deliberate uniform Huffman).
    if (Array.isArray(recipe.freqs)) {
      // Render in the same left-to-right order as the BYOS picker
      // (norvig, google, gutenberg, style) so the recipient can scan
      // the row top-to-bottom while following the instruction.
      const FREQ_DISPLAY_ORDER = ['norvig', 'google', 'gutenberg', 'style'];
      const fLabels = FREQ_DISPLAY_ORDER
        .filter((k) => recipe.freqs.includes(k))
        .map((k) => freqSourceLabel(k, recipe.story))
        .filter(Boolean);
      if (fLabels.length === 0) {
        lines.push('Under Word Frequencies, untick everything.');
      } else {
        lines.push(`Under Word Frequencies, tick ${joinList(fLabels)}.`);
      }
    }
    // BYOS "Prefer shorter words" tie-break, off by default. Only
    // mention it when on so unchanged-from-default recipes stay terse.
    if (recipe.tieBreak === 'length-desc') {
      lines.push('Tick "Prefer shorter words".');
    }
    lines.push('Hit Build.');
    return lines.join('\n');
  }
  return '';
}
