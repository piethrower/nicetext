// Eve combination counter. Given a set of Phase I detector verdicts
// and the list of story.style values to consider (typically the 21
// shipped cards, optionally plus 'flat' and 'custom'), report how
// many BYOS combinations remain alive.
//
// Scope (commit 2): the practical BYOS space the brute-force engine
// would actually iterate. Per-card base blocks ride along with the
// card (Eve doesn't enumerate 2^27 source subsets), and the variable
// knobs are the augment toggles + mixedPhrases + sentence/vocabulary
// + tieBreak. The combination counter respects the one cross-knob
// schema constraint Eve cares about: mixedPhrases > 0 requires at
// least one of emojiIntoWords or wordsIntoEmoji to be on.
//
// Detector verdicts the counter understands today:
//   - augment.wordsIntoEmoji
//   - augment.emojiIntoWords
//   - augment.mixedPhrases  (uses verdict.data.max as the lower bound)
// Unrecognized knobs (sources.*, story.style match-rates, etc.) are
// folded in by later commits. The cover-transforms rewriter +
// formatter blocks are similarly future work; augment.vowel was
// retired with the xanax rewriter migration.

const MIX_MAX = 10;

const FULL_INVENTORY = {
  'story.sentence': ['random', 'sequential'],
  'story.vocabulary': ['corpus', 'base'],
  'augment.emojiIntoWords.enabled': [false, true],
  'augment.emojiIntoWords.intensity': Array.from({ length: MIX_MAX + 1 }, (_, i) => i),
  'augment.wordsIntoEmoji.enabled': [false, true],
  'augment.wordsIntoEmoji.intensity': Array.from({ length: MIX_MAX + 1 }, (_, i) => i),
  'tieBreak': ['alpha-asc', 'prefer-shorter'],
};

// story.style values that skip sentence/vocabulary axes. Matches the
// reserved set in byos.js (RESERVED_STORY_STYLES) for the 'flat'
// shape; 'custom' is also card-bound and uses sentence/vocabulary.
const FLAT_STYLES = new Set(['flat']);

function applyVerdicts(verdicts) {
  const surviving = {};
  for (const [knob, values] of Object.entries(FULL_INVENTORY)) {
    surviving[knob] = values.slice();
  }
  for (const v of verdicts) {
    if (v.knob === 'augment.wordsIntoEmoji') {
      if (v.verdict === 'likely') surviving['augment.wordsIntoEmoji.enabled'] = [true];
      else if (v.verdict === 'unlikely') surviving['augment.wordsIntoEmoji.enabled'] = [false];
    } else if (v.knob === 'augment.emojiIntoWords') {
      if (v.verdict === 'likely') surviving['augment.emojiIntoWords.enabled'] = [true];
      else if (v.verdict === 'unlikely') surviving['augment.emojiIntoWords.enabled'] = [false];
    } else if (v.knob === 'augment.maxEmojiCluster') {
      // Max emoji-cluster length observed in the cover. Bounds BOTH
      // per-aug intensities: an enabled aug with cluster L means
      // intensity >= L.
      const max = v.data && typeof v.data.max === 'number' ? v.data.max : null;
      if (max === null) continue;
      if (max === 0 && v.verdict === 'unlikely') {
        // No clusters observed and the detector is confident: only
        // intensity = 0 survives for both augs.
        surviving['augment.emojiIntoWords.intensity'] = [0];
        surviving['augment.wordsIntoEmoji.intensity'] = [0];
      } else if (max > 0) {
        surviving['augment.emojiIntoWords.intensity'] = surviving['augment.emojiIntoWords.intensity']
          .filter(n => n >= max);
        surviving['augment.wordsIntoEmoji.intensity'] = surviving['augment.wordsIntoEmoji.intensity']
          .filter(n => n >= max);
      }
    }
    // Any other knob (sources.*, story.style match, ...) is ignored
    // here; the counter folds them in once those detectors land.
  }
  return surviving;
}

function countAugmentTuples(surviving) {
  let count = 0;
  for (const eiEn of surviving['augment.emojiIntoWords.enabled']) {
    const eiInts = eiEn ? surviving['augment.emojiIntoWords.intensity'] : [0];
    for (const eiInt of eiInts) {
      for (const wiEn of surviving['augment.wordsIntoEmoji.enabled']) {
        const wiInts = wiEn ? surviving['augment.wordsIntoEmoji.intensity'] : [0];
        for (const wiInt of wiInts) {
          if (eiInt > 0 && !eiEn) continue; // intensity is meaningless when disabled
          if (wiInt > 0 && !wiEn) continue;
          count++;
        }
      }
    }
  }
  return count;
}

// Filter the provided styles by per-card story.style.<name>
// verdicts. A style is dropped when its per-card verdict says
// 'unlikely'. 'likely' and 'unknown' both keep the style alive.
// Styles without a per-card verdict (e.g., 'flat') always
// survive.
function filterStylesByVerdicts(styles, verdicts) {
  const unlikely = new Set();
  for (const v of verdicts) {
    const m = /^story\.style\.(.+)$/.exec(v.knob);
    if (!m) continue;
    if (v.verdict === 'unlikely') unlikely.add(m[1]);
  }
  if (unlikely.size === 0) return styles;
  return styles.filter(s => !unlikely.has(s));
}

export function countCombinations(verdicts, opts = {}) {
  const stylesIn = opts.styles ?? [];
  const styles = filterStylesByVerdicts(stylesIn, verdicts);
  const surviving = applyVerdicts(verdicts);
  const augCount = countAugmentTuples(surviving);
  const tbCount = surviving['tieBreak'].length;
  const sentCount = surviving['story.sentence'].length;
  const vocCount = surviving['story.vocabulary'].length;

  let total = 0;
  for (const style of styles) {
    if (FLAT_STYLES.has(style)) {
      total += augCount * tbCount;
    } else {
      total += sentCount * vocCount * augCount * tbCount;
    }
  }
  return {
    total,
    stylesConsidered: styles.length,
    stylesIn: stylesIn.length,
    surviving,
    augCount,
  };
}
