// byos-panel.js: bidirectional translation between byos.json (the
// canonical recipe shape) and a flat "panel controls" object that
// mirrors the Advanced panel's DOM-control layout one-to-one. Pure
// data transforms, browser-safe ESM, no DOM access.
//
// The panel state separates 'customtw' out of base.sources into a
// boolean flag, since the BYOS UI surfaces the custom upload as a
// dedicated control rather than another source checkbox. tieBreak
// translates between the byos schema name ('prefer-shorter') and the
// engine name ('length-desc'); 'alpha-asc' is the same on both sides.
// hasStory / hasBase explicitly carry the optional-block presence so
// the panel can mark a missing block as "not part of this recipe"
// while still holding default values in its DOM controls.
//
// Cover-transforms rewriter + reformatter blocks (docs/cover-transforms
// .md) flatten their universal `{enabled, intensity, mode?}` per-field
// shape into three panel fields per name (Enabled / Intensity /
// Mode). Mode is kept sticky in the panel even when Enabled is false,
// so flipping the toggle back on restores the previous mode choice
// without re-opening a picker. panelToByos drops mode again when
// Enabled is false (or for unimodal fields like xanax).

const DEFAULT_STORY = {
  storyStyle: 'flat',
  sentence: null,
  vocabulary: null,
};

const DEFAULT_BASE = {
  sources: [],
  customTw: false,
  emojiIntoWordsEnabled: false,
  emojiIntoWordsIntensity: 0,
  wordsIntoEmojiEnabled: false,
  wordsIntoEmojiIntensity: 0,
  freqs: [],
  customWordfreq: false,
  tieBreak: 'alpha-asc',
};

const DEFAULT_REWRITER = {
  rewriterBritishEnabled:   false,
  rewriterBritishIntensity: 0,
  rewriterBritishMode:      'us-uk',
  rewriterTyposEnabled:   false,
  rewriterTyposIntensity: 0,
  rewriterTyposMode:      'forward',
  rewriterVoiceEnabled:   false,
  rewriterVoiceIntensity: 0,
  rewriterVoiceMode:      'pirate',
  rewriterXanaxEnabled:   false,
  rewriterXanaxIntensity: 0,
};

const DEFAULT_REFORMATTER = {
  reformatterCaseEnabled:   false,
  reformatterCaseIntensity: 0,
  reformatterCaseMode:      'titleCase',
  reformatterLineBreakEnabled:   false,
  reformatterLineBreakIntensity: 0,
  reformatterLineBreakMode:      'expand',
  reformatterSentenceEndEnabled:   false,
  reformatterSentenceEndIntensity: 0,
  reformatterSentenceEndMode:      'uptalk',
  reformatterVoiceEnabled:   false,
  reformatterVoiceIntensity: 0,
  reformatterVoiceMode:      'pirate',
};

function intensityOf(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 100) return v;
  return 0;
}

function readField(block, name, panelKeys, modeDefault) {
  const f = block?.[name];
  const out = {
    enabled: false,
    intensity: 0,
  };
  if (modeDefault !== null) out.mode = modeDefault;
  if (f && typeof f === 'object') {
    out.enabled = f.enabled === true;
    out.intensity = intensityOf(f.intensity);
    if (modeDefault !== null && typeof f.mode === 'string') out.mode = f.mode;
  }
  return out;
}

function emitField(panel, name, panelKeys, hasMode) {
  const enabled = !!panel[panelKeys.enabled];
  const intensity = intensityOf(panel[panelKeys.intensity]);
  if (!enabled || intensity <= 0) return null;
  const out = { enabled: true, intensity };
  if (hasMode) {
    const mode = panel[panelKeys.mode];
    if (typeof mode === 'string' && mode.length > 0) out.mode = mode;
  }
  return out;
}

// byosToPanel: byos.json (canonical) → flat panel-controls object.
// Returns an object suitable for binding directly to DOM controls.
// hasStory / hasBase carry block presence; absent blocks contribute
// default values (the panel hides or greys those controls).
export function byosToPanel(byos) {
  const panel = {
    hasStory: Boolean(byos && byos.story),
    hasBase: Boolean(byos && byos.base),
    ...DEFAULT_STORY,
    ...DEFAULT_BASE,
    ...DEFAULT_REWRITER,
    ...DEFAULT_REFORMATTER,
  };
  if (byos && byos.story) {
    panel.storyStyle = byos.story.style;
    if (byos.story.style !== 'flat') {
      panel.sentence = byos.story.sentence;
      panel.vocabulary = byos.story.vocabulary;
    }
  }
  if (byos && byos.base) {
    const allSources = byos.base.sources || [];
    panel.sources = allSources.filter(s => s !== 'customtw');
    panel.customTw = allSources.includes('customtw');
    {
      const a = byos.base.augment && byos.base.augment.emojiIntoWords;
      panel.emojiIntoWordsEnabled   = !!(a && a.enabled === true);
      panel.emojiIntoWordsIntensity = a && Number.isInteger(a.intensity) ? Math.max(0, a.intensity) : 0;
    }
    {
      const b = byos.base.augment && byos.base.augment.wordsIntoEmoji;
      panel.wordsIntoEmojiEnabled   = !!(b && b.enabled === true);
      panel.wordsIntoEmojiIntensity = b && Number.isInteger(b.intensity) ? Math.max(0, b.intensity) : 0;
    }
    panel.freqs = [...(byos.base.frequencies || [])];
    panel.customWordfreq = byos.base.customWordfreq !== undefined;
    panel.tieBreak = byos.base.tieBreak;
  }
  if (byos && byos.rewriter) {
    {
      const f = readField(byos.rewriter, 'british', null, panel.rewriterBritishMode);
      panel.rewriterBritishEnabled   = f.enabled;
      panel.rewriterBritishIntensity = f.intensity;
      panel.rewriterBritishMode      = f.mode;
    }
    {
      const f = readField(byos.rewriter, 'typos', null, panel.rewriterTyposMode);
      panel.rewriterTyposEnabled   = f.enabled;
      panel.rewriterTyposIntensity = f.intensity;
      panel.rewriterTyposMode      = f.mode;
    }
    {
      const f = readField(byos.rewriter, 'voice', null, panel.rewriterVoiceMode);
      panel.rewriterVoiceEnabled   = f.enabled;
      panel.rewriterVoiceIntensity = f.intensity;
      panel.rewriterVoiceMode      = f.mode;
    }
    {
      const f = readField(byos.rewriter, 'xanax', null, null);
      panel.rewriterXanaxEnabled   = f.enabled;
      panel.rewriterXanaxIntensity = f.intensity;
    }
  }
  if (byos && byos.reformatter) {
    {
      const f = readField(byos.reformatter, 'case', null, panel.reformatterCaseMode);
      panel.reformatterCaseEnabled   = f.enabled;
      panel.reformatterCaseIntensity = f.intensity;
      panel.reformatterCaseMode      = f.mode;
    }
    {
      const f = readField(byos.reformatter, 'lineBreak', null, panel.reformatterLineBreakMode);
      panel.reformatterLineBreakEnabled   = f.enabled;
      panel.reformatterLineBreakIntensity = f.intensity;
      panel.reformatterLineBreakMode      = f.mode;
    }
    {
      const f = readField(byos.reformatter, 'sentenceEnd', null, panel.reformatterSentenceEndMode);
      panel.reformatterSentenceEndEnabled   = f.enabled;
      panel.reformatterSentenceEndIntensity = f.intensity;
      panel.reformatterSentenceEndMode      = f.mode;
    }
    {
      const f = readField(byos.reformatter, 'voice', null, panel.reformatterVoiceMode);
      panel.reformatterVoiceEnabled   = f.enabled;
      panel.reformatterVoiceIntensity = f.intensity;
      panel.reformatterVoiceMode      = f.mode;
    }
  }
  return panel;
}

// panelToByos: flat panel-controls object → byos.json (canonical).
// Inverse of byosToPanel. The output validates against the byos schema
// (js/src/byos.js validate) and round-trips through generateBYOSID
// to produce the same id as the original byos that produced this panel.
export function panelToByos(panel) {
  const byos = { version: 1 };
  if (panel.hasStory) {
    const story = { style: panel.storyStyle };
    if (panel.storyStyle !== 'flat') {
      story.sentence = panel.sentence;
      story.vocabulary = panel.vocabulary;
    }
    byos.story = story;
  }
  if (panel.hasBase) {
    const sources = [...panel.sources];
    if (panel.customTw) sources.push('customtw');
    const base = {
      sources,
      frequencies: [...panel.freqs],
      tieBreak: panel.tieBreak,
    };
    const aug = {};
    if (panel.emojiIntoWordsEnabled) {
      aug.emojiIntoWords = {
        enabled: true,
        intensity: Number.isInteger(panel.emojiIntoWordsIntensity)
          ? Math.max(0, panel.emojiIntoWordsIntensity) : 0,
      };
    }
    if (panel.wordsIntoEmojiEnabled) {
      aug.wordsIntoEmoji = {
        enabled: true,
        intensity: Number.isInteger(panel.wordsIntoEmojiIntensity)
          ? Math.max(0, panel.wordsIntoEmojiIntensity) : 0,
      };
    }
    if (Object.keys(aug).length > 0) base.augment = aug;
    if (panel.customWordfreq) base.customWordfreq = '<custom>';
    byos.base = base;
  }
  const rewriter = {};
  {
    const f = emitField(panel, 'british',
      { enabled: 'rewriterBritishEnabled', intensity: 'rewriterBritishIntensity', mode: 'rewriterBritishMode' }, true);
    if (f) rewriter.british = f;
  }
  {
    const f = emitField(panel, 'typos',
      { enabled: 'rewriterTyposEnabled', intensity: 'rewriterTyposIntensity', mode: 'rewriterTyposMode' }, true);
    if (f) rewriter.typos = f;
  }
  {
    const f = emitField(panel, 'voice',
      { enabled: 'rewriterVoiceEnabled', intensity: 'rewriterVoiceIntensity', mode: 'rewriterVoiceMode' }, true);
    if (f) rewriter.voice = f;
  }
  {
    const f = emitField(panel, 'xanax',
      { enabled: 'rewriterXanaxEnabled', intensity: 'rewriterXanaxIntensity' }, false);
    if (f) rewriter.xanax = f;
  }
  if (Object.keys(rewriter).length > 0) byos.rewriter = rewriter;
  const reformatter = {};
  {
    const f = emitField(panel, 'case',
      { enabled: 'reformatterCaseEnabled', intensity: 'reformatterCaseIntensity', mode: 'reformatterCaseMode' }, true);
    if (f) reformatter.case = f;
  }
  {
    const f = emitField(panel, 'lineBreak',
      { enabled: 'reformatterLineBreakEnabled', intensity: 'reformatterLineBreakIntensity', mode: 'reformatterLineBreakMode' }, true);
    if (f) reformatter.lineBreak = f;
  }
  {
    const f = emitField(panel, 'sentenceEnd',
      { enabled: 'reformatterSentenceEndEnabled', intensity: 'reformatterSentenceEndIntensity', mode: 'reformatterSentenceEndMode' }, true);
    if (f) reformatter.sentenceEnd = f;
  }
  {
    const f = emitField(panel, 'voice',
      { enabled: 'reformatterVoiceEnabled', intensity: 'reformatterVoiceIntensity', mode: 'reformatterVoiceMode' }, true);
    if (f) reformatter.voice = f;
  }
  if (Object.keys(reformatter).length > 0) byos.reformatter = reformatter;
  return byos;
}
