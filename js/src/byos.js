// byos.js: schema, byosID encoder/decoder, nickname helpers.
//
// Pure browser-safe ESM, zero deps. Used by the Node fixture-build pipeline
// (tools/build-*.js) and Phase 2 browser code. byosID is a deterministic,
// content-addressable encoding of a byos.json's public spec; it omits
// cosmetics (name, notes), build-script metadata (build block), and any
// custom-upload specifics (corpus / TW-list / wordfreq paths). See plan
// keen-herding-glade.md for the schema rationale.

const SCHEMA_VERSION = 1;

// 'flat' and 'custom' are reserved structural identifiers (zero-corpus
// random words and runtime user-supplied corpus respectively). Any
// other non-empty string is a valid card-bound style; the allowlist is
// the union of basenames in tools/byos/, not a hardcoded enum.
const RESERVED_STORY_STYLES = new Set(['flat', 'custom']);

// SOURCE_NAMES: validation gatekeeper. Adding a new twlist source
// requires touching FOUR hardcoded lists that must stay in sync:
//   1. js/src/byos.js               SOURCE_NAMES          (this file, byos schema validation)
//   2. js/src/share.js              SOURCE_LABELS         (share-URL human-readable labels)
//   3. js/app.js                    ADV_SOURCE_KEYS       (Pro tab picker render allowlist)
//   4. js/src/worker/build-session-worker.js  KNOWN_TWLIST_KEYS  (runtime accept check)
// Plus the upstream data: tools/build-twlist-fixtures.js SOURCE_META
// (the auto-generated fixtures/twlist-sources.meta.{js,json} drives
// the picker rows but not the four gatekeepers above).
const SOURCE_NAMES = new Set([
  'impf2p', 'moby-pos', 'moby-thesaurus',
  'wordnet', 'wordnet-synonyms',
  'impkimmo', 'mit',
  // KIMMO2026 family, re-derived against modern PC-KIMMO + ENGLEX,
  // built by tools/run-impkimmo2026.js. Each is an independent
  // BYOS-selectable twlist axis; see fixtures/twlist-sources.meta.json
  // for the (group, label, description, types, words) metadata used
  // to render the Advanced-panel source picker.
  'impkimmo2026', 'impkimmo2026-cform', 'impkimmo2026-root',
  'impkimmo2026-rootpos', 'impkimmo2026-drvstem',
  'num-form-preserved', 'num-form-interchangeable', 'num-roman',
  // Poetry/Song twlists, all CMU-derived siblings. See SOURCE_META
  // in tools/build-twlist-fixtures.js for the picker metadata.
  'rhyme', 'cmu-syllable', 'cmu-stress', 'cmu-alliteration',
  'claude2026', 'connectors', 'proglang-keywords',
  'emoji16', 'emoji-cldr-names-16', 'emoji16-curated-keywords',
  'emoji-curated-phrases-16',
  'customtw',
]);

const FREQ_NAMES = new Set([
  'norvig', 'google', 'gutenberg', 'style',
]);

const TIE_BREAKS = new Set(['alpha-asc', 'prefer-shorter']);

// Rewriter and reformatter cover-transforms (see docs/cover-transforms.md).
// Defaults at load-time: every field disabled. Premade cards omit
// fields they don't override; the engine treats absent fields as
// `{enabled:false}` so byos files stay terse.
//
// Universal field shape (both blocks, per-field):
//   { enabled: boolean, intensity: int 0..100, mode?: string }
//
// `mode` is required when the field has a mode catalogue and
// `enabled` is true; for unimodal fields (xanax) it is
// omitted. When `enabled` is false the field is treated as off
// regardless of intensity / mode (the UI may persist mode +
// intensity for sticky toggles).
//
// Mode catalogues land alongside their runtime in the rewriter /
// reformatter modules. The expanded catalogues (case randomCaps,
// sentenceEnd, voice, ...) arrive with their implementations in a
// later commit of the cover-transforms arc; only what is wired
// end-to-end today is accepted here.
const REWRITER_NAMES = new Set([
  'british', 'typos', 'voice', 'xanax',
]);
const REWRITER_MODES = {
  british: new Set(['us-uk', 'uk-us']),
  typos:   new Set(['forward', 'reverse']),
  voice:   new Set([
    'pirate', 'valleygirl', 'surfer', 'flapper', 'cockney',
    'brooklynese', 'neutral', 'cat', 'dog',
  ]),
  xanax:   null,
};
const REFORMATTER_NAMES = new Set([
  'case', 'lineBreak', 'sentenceEnd', 'voice',
]);
const REFORMATTER_MODES = {
  case:        new Set([
    'allCaps', 'allLowercase', 'titleCase', 'sentenceCase',
    'randomCaps', 'sentenceStartLower',
  ]),
  lineBreak:   new Set(['expand', 'collapse']),
  sentenceEnd: new Set(['uptalk', 'excitement']),
  voice:       new Set([
    'pirate', 'valleygirl', 'surfer', 'flapper', 'cockney',
    'brooklynese', 'neutral', 'cat', 'dog',
  ]),
};

// Short codes for byosID. Each enabled field contributes its 2-char
// shortcode plus `=<intensity>` and, when the field carries a mode,
// an `:<modeShort>` suffix. Example forms:
//   xa=100              (xanax, no mode)
//   ty=50:f             (typos, forward)
//   cs=25:tc            (case, titleCase)
const REWRITER_SHORTCODE_ENCODE = {
  british: 'br', typos: 'ty', voice: 'vc', xanax: 'xa',
};
const REFORMATTER_SHORTCODE_ENCODE = {
  case: 'cs', lineBreak: 'lb', sentenceEnd: 'se', voice: 'vo',
};
const REWRITER_MODE_SHORTCODE_ENCODE = {
  british: { 'us-uk': 'u', 'uk-us': 'k' },
  typos:   { forward: 'f', reverse: 'r' },
  voice:   {
    pirate: 'pi', valleygirl: 'vg', surfer: 'su', flapper: 'fl',
    cockney: 'ck', brooklynese: 'bn', neutral: 'ne', cat: 'ca', dog: 'do',
  },
};
const REFORMATTER_MODE_SHORTCODE_ENCODE = {
  case: {
    allCaps: 'ac', allLowercase: 'al',
    titleCase: 'tc', sentenceCase: 'sc',
    randomCaps: 'rc', sentenceStartLower: 'sl',
  },
  lineBreak:   { expand: 'ex', collapse: 'co' },
  sentenceEnd: { uptalk: 'ut', excitement: 'xc' },
  voice:       {
    pirate: 'pi', valleygirl: 'vg', surfer: 'su', flapper: 'fl',
    cockney: 'ck', brooklynese: 'bn', neutral: 'ne', cat: 'ca', dog: 'do',
  },
};
// Mix-phrase intensity (0..MIX_MAX). Folded into Aug A and Aug B per
// spec §C. N controls how many emoji-repetition variants the cross-
// modal augs emit. Mirrors aug-impls-sab.js MIX_MAX; kept independent
// here so byos.js stays free of engine imports.
const MIX_MAX = 10;

// Default intensities. When a transform field's intensity is absent
// in a byos, validate() fills it in from this table; generateBYOSID
// strips it back out before hashing so "absent" and "explicit-at-
// default" canonicalize to the same id. Cards that want a non-default
// intensity carry the field explicitly; cards that want the default
// can omit it for a smaller, more-readable byos.json. Rewriter /
// reformatter values are on the 1..100 percent scale; eiw / wie are
// on the 1..MIX_MAX level scale.
export const DEFAULT_INTENSITIES = {
  rewriter: {
    british: 100,
    typos:   17,
    voice:   100,
    xanax:   100,
  },
  reformatter: {
    case:        100,
    lineBreak:   100,
    sentenceEnd: 100,
    voice:       29,
  },
  augment: {
    emojiIntoWords: 1,
    wordsIntoEmoji: 1,
  },
};
const SENTENCES = new Set(['random', 'sequential']);
const VOCABULARIES = new Set(['corpus', 'base']);

const TOP_LEVEL_KEYS = new Set([
  'version', 'name', 'notes', 'story', 'base', 'build',
  'rewriter', 'reformatter',
  'label', 'casualLabel', 'preview', 'chipId',
  // Embedded custom-data payloads (optional). When present, the byos
  // is self-contained: recipient loads the file and the engine has
  // every byte it needs to build, with no separate corpus/twlist
  // file required. Shape for each:
  //   { encoding: 'gzip+base64', name?: string, data: string }
  // The data is the POST-clean form (the bytes the sender's engine
  // actually consumed). Preclean is idempotent so re-cleaning on
  // load is a no-op.
  'customCorpusData', 'customTwlistData',
]);
const STORY_KEYS = new Set(['style', 'sentence', 'vocabulary']);
const BASE_KEYS = new Set([
  'sources', 'augment', 'customTwlist',
  'frequencies', 'customWordfreq', 'tieBreak',
  'hashedMergedTypes', 'generateHashmap',
]);
const BUILD_KEYS = new Set(['corpus']);

// byosID story-style code table. 'flat' and 'cust' are short forms;
// every other style encodes as itself (identity). Decode mirrors:
// 'flat' and 'cust' map back; anything else passes through unchanged.
// Adding a new card requires no edits here; the byos file's
// story.style is the canonical token in both directions.
const STORY_STYLE_FIXED_ENCODE = { flat: 'flat', custom: 'cust' };
const STORY_STYLE_FIXED_DECODE = invertMap(STORY_STYLE_FIXED_ENCODE);
function encodeStoryStyle(s) { return STORY_STYLE_FIXED_ENCODE[s] ?? s; }
function decodeStoryStyle(s) { return STORY_STYLE_FIXED_DECODE[s] ?? s; }
const SENTENCE_ENCODE = { random: 'r', sequential: 's' };
const SENTENCE_DECODE = invertMap(SENTENCE_ENCODE);
const VOCABULARY_ENCODE = { corpus: 'c', base: 'b' };
const VOCABULARY_DECODE = invertMap(VOCABULARY_ENCODE);
const TIE_BREAK_ENCODE = { 'alpha-asc': 'a', 'prefer-shorter': 'p' };
const TIE_BREAK_DECODE = invertMap(TIE_BREAK_ENCODE);
const REWRITER_SHORTCODE_DECODE = invertMap(REWRITER_SHORTCODE_ENCODE);
const REFORMATTER_SHORTCODE_DECODE = invertMap(REFORMATTER_SHORTCODE_ENCODE);
const REWRITER_MODE_SHORTCODE_DECODE = Object.fromEntries(
  Object.entries(REWRITER_MODE_SHORTCODE_ENCODE).map(([k, m]) => [k, invertMap(m)])
);
const REFORMATTER_MODE_SHORTCODE_DECODE = Object.fromEntries(
  Object.entries(REFORMATTER_MODE_SHORTCODE_ENCODE).map(([k, m]) => [k, invertMap(m)])
);

function invertMap(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
}

function fail(msg) { throw new Error(`byos: ${msg}`); }

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isRelativePath(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (s.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false;
  return true;
}

// ---------------------------------------------------------------------
// validate(byos): full-file schema check. Throws on any violation. Use
// for tools/byos/*.byos.json files where every required field including
// `name` must be present.
// ---------------------------------------------------------------------
export function validate(byos) {
  if (!isPlainObject(byos)) fail('input must be a plain object');

  for (const k of Object.keys(byos)) {
    if (!TOP_LEVEL_KEYS.has(k)) fail(`unknown top-level field: ${k}`);
  }

  if (byos.version !== SCHEMA_VERSION) {
    fail(`version must be ${SCHEMA_VERSION}; got ${JSON.stringify(byos.version)}`);
  }

  if (typeof byos.name !== 'string' || byos.name.length === 0) {
    fail('name is required and must be a non-empty string');
  }

  if (byos.notes !== undefined && typeof byos.notes !== 'string') {
    fail('notes must be a string when present');
  }
  for (const k of ['label', 'casualLabel', 'preview', 'chipId']) {
    if (byos[k] !== undefined && (typeof byos[k] !== 'string' || byos[k].length === 0)) {
      fail(`${k} must be a non-empty string when present`);
    }
  }

  if (byos.story === undefined && byos.base === undefined) {
    fail('at least one of story or base is required');
  }

  if (byos.story !== undefined) validateStory(byos.story);
  if (byos.base !== undefined) validateBase(byos.base);
  if (byos.build !== undefined) validateBuild(byos.build);
  if (byos.rewriter !== undefined) validateRewriter(byos.rewriter);
  if (byos.reformatter !== undefined) validateReformatter(byos.reformatter);
  if (byos.customCorpusData !== undefined) validateEmbeddedData(byos.customCorpusData, 'customCorpusData');
  if (byos.customTwlistData !== undefined) validateEmbeddedData(byos.customTwlistData, 'customTwlistData');
}

// Validate a single rewriter / reformatter field-value against the
// universal `{enabled, intensity, mode?}` shape. `block` and `name`
// are used only for error messages. `modeSet` is the Set of valid
// modes for this field, or null when the field is unimodal (mode must
// then be absent).
function validateCoverTransformField(block, name, value, modeSet) {
  if (!isPlainObject(value)) {
    fail(`${block}.${name} must be a plain object {enabled, intensity, mode?}`);
  }
  for (const k of Object.keys(value)) {
    if (k !== 'enabled' && k !== 'intensity' && k !== 'mode') {
      fail(`${block}.${name}: unknown field ${k}`);
    }
  }
  if (typeof value.enabled !== 'boolean') {
    fail(`${block}.${name}.enabled must be a boolean`);
  }
  // intensity is optional; when absent, DEFAULT_INTENSITIES[block][name]
  // applies. Cards that want the default may omit the field for a
  // smaller byos.json. byosID canonicalizes "absent === default" so
  // auto-match is preserved across the two forms. When present, the
  // value must still be an integer in 0..100.
  if (value.intensity !== undefined
      && (!Number.isInteger(value.intensity) || value.intensity < 0 || value.intensity > 100)) {
    fail(`${block}.${name}.intensity must be an integer 0..100`);
  }
  // Validate is also the canonicalizer: fill in the default in-place
  // so downstream code (encoder, panel, build-session-worker) sees a
  // fully-populated byos with no need to re-derive defaults. Mutation
  // is intentional and matches the existing "validate is also
  // normalize" pattern for other optional fields.
  if (value.intensity === undefined) {
    const def = DEFAULT_INTENSITIES[block]?.[name];
    if (def !== undefined) value.intensity = def;
  }
  if (modeSet === null) {
    if (value.mode !== undefined) {
      fail(`${block}.${name}: mode is not accepted for this field`);
    }
  } else {
    if (value.enabled === true && value.mode === undefined) {
      fail(`${block}.${name}.mode is required when enabled is true; one of: ${[...modeSet].sort().join(', ')}`);
    }
    if (value.mode !== undefined
        && (typeof value.mode !== 'string' || !modeSet.has(value.mode))) {
      fail(`${block}.${name}.mode must be one of: ${[...modeSet].sort().join(', ')}`);
    }
  }
}

// Cover-transforms rewriter block. Each field carries `{enabled,
// intensity, mode?}`; omitted fields default to disabled. enabled
// gates everything: when false, sortdct skips the twlist injection
// and the encoder never calls apply(). When true, intensity (0..100)
// drives the per-emission coin flip; mode picks the apply() variant
// for multi-mode rewriters.
function validateRewriter(rewriter) {
  if (!isPlainObject(rewriter)) fail('rewriter must be a plain object');
  for (const k of Object.keys(rewriter)) {
    if (!REWRITER_NAMES.has(k)) fail(`unknown rewriter field: ${k}`);
    validateCoverTransformField('rewriter', k, rewriter[k], REWRITER_MODES[k]);
  }
}

// Emoji aug field: `{enabled, intensity}` where intensity is the
// repetition depth (0..MIX_MAX) layered on top of the base
// single-token cross-modal substitution. Same shape family as the
// universal cover-transform field, but the intensity range is
// 0..MIX_MAX instead of 0..100.
function validateEmojiAugField(path, value) {
  if (!isPlainObject(value)) {
    fail(`${path} must be a plain object {enabled, intensity}`);
  }
  for (const k of Object.keys(value)) {
    if (k !== 'enabled' && k !== 'intensity') {
      fail(`${path}: unknown field ${k}`);
    }
  }
  if (typeof value.enabled !== 'boolean') {
    fail(`${path}.enabled must be a boolean`);
  }
  // intensity (level) is optional; when absent,
  // DEFAULT_INTENSITIES.augment[name] applies. Same omission /
  // canonicalization rule as the cover-transform fields. Validate
  // also fills in the default in-place (see validateCoverTransform-
  // Field for the rationale).
  if (value.intensity !== undefined
      && (!Number.isInteger(value.intensity) || value.intensity < 0 || value.intensity > MIX_MAX)) {
    fail(`${path}.intensity must be an integer 0..${MIX_MAX}`);
  }
  if (value.intensity === undefined) {
    // path looks like "base.augment.emojiIntoWords"; pull the last
    // segment as the field key.
    const augName = path.split('.').pop();
    const def = DEFAULT_INTENSITIES.augment?.[augName];
    if (def !== undefined) value.intensity = def;
  }
}

// Cover-transforms reformatter block. Same universal shape as the
// rewriter block. Reformatters run at the model layer (model -> model
// enhancers); see docs/cover-transforms.md.
function validateReformatter(reformatter) {
  if (!isPlainObject(reformatter)) fail('reformatter must be a plain object');
  for (const k of Object.keys(reformatter)) {
    if (!REFORMATTER_NAMES.has(k)) fail(`unknown reformatter field: ${k}`);
    validateCoverTransformField('reformatter', k, reformatter[k], REFORMATTER_MODES[k]);
  }
}

// Optional self-contained payload: gzip+base64 of the cleaned source
// the sender's engine consumed. Shape: { encoding, name?, data }.
function validateEmbeddedData(obj, label) {
  if (!isPlainObject(obj)) fail(`${label} must be a plain object`);
  if (obj.encoding !== 'gzip+base64') {
    fail(`${label}.encoding must be "gzip+base64"`);
  }
  if (typeof obj.data !== 'string' || obj.data.length === 0) {
    fail(`${label}.data must be a non-empty string`);
  }
  if (obj.name !== undefined && typeof obj.name !== 'string') {
    fail(`${label}.name must be a string when present`);
  }
}

function validateStory(story) {
  if (!isPlainObject(story)) fail('story must be a plain object');
  for (const k of Object.keys(story)) {
    if (!STORY_KEYS.has(k)) fail(`unknown story field: ${k}`);
  }
  if (typeof story.style !== 'string' || story.style.length === 0) {
    fail(`story.style must be a non-empty string`);
  }
  // Card-bound styles (anything not in RESERVED_STORY_STYLES) are
  // validated by the existence of a tools/byos/<name>.byos.json file
  // at registry-load time, not here. Schema-time validation can't see
  // the registry without circular imports.
  if (story.style === 'flat') {
    if (story.sentence !== undefined) {
      fail('story.sentence must be omitted when story.style is "flat"');
    }
    if (story.vocabulary !== undefined) {
      fail('story.vocabulary must be omitted when story.style is "flat"');
    }
  } else {
    if (typeof story.sentence !== 'string' || !SENTENCES.has(story.sentence)) {
      fail(`story.sentence is required when story.style is not "flat"; must be one of: ${[...SENTENCES].sort().join(', ')}`);
    }
    if (typeof story.vocabulary !== 'string' || !VOCABULARIES.has(story.vocabulary)) {
      fail(`story.vocabulary is required when story.style is not "flat"; must be one of: ${[...VOCABULARIES].sort().join(', ')}`);
    }
  }
}

function validateBase(base) {
  if (!isPlainObject(base)) fail('base must be a plain object');
  for (const k of Object.keys(base)) {
    if (!BASE_KEYS.has(k)) fail(`unknown base field: ${k}`);
  }
  if (!Array.isArray(base.sources)) fail('base.sources must be an array');
  for (const s of base.sources) {
    if (typeof s !== 'string' || !SOURCE_NAMES.has(s)) {
      fail(`base.sources contains invalid name: ${JSON.stringify(s)}`);
    }
  }
  // Canonicalize: `connectors` is only meaningful for the MIT card's
  // CFG grammar. Any source list that also includes a rich-types
  // source (impkimmo / impkimmo2026 / moby-pos / wordnet) gets
  // connectors silently dropped here, sortDict's _UNIQUE_ drop-rule
  // would strip these entries at build time anyway, so the canonical
  // byosID with vs without connectors would address two specs that
  // produce identical output. Dropping at validate-time means that
  // every entry point (file load, recipeToByos, panelToByos, share
  // URLs) converges on the same canonical id.
  if (base.sources.includes('connectors')) {
    const RICH_TYPES = new Set(['impkimmo', 'impkimmo2026', 'moby-pos', 'wordnet']);
    if (base.sources.some(s => RICH_TYPES.has(s))) {
      base.sources = base.sources.filter(s => s !== 'connectors');
    }
  }
  if (base.augment !== undefined) {
    if (!isPlainObject(base.augment)) fail('base.augment must be a plain object');
    // augment.vowel retired with the cover-transforms arc; a/an
    // agreement is now handled by the xanax rewriter (see
    // js/src/rewriter/xanax.js, byos.rewriter.xanax).
    // mixedPhrases retired; each emoji aug now carries its own
    // {enabled, intensity} where intensity 0..MIX_MAX = repetition
    // depth added on top of the single-token cross-modal swap.
    const augFields = new Set(['emojiIntoWords', 'wordsIntoEmoji']);
    for (const k of Object.keys(base.augment)) {
      if (!augFields.has(k)) fail(`unknown base.augment field: ${k}`);
    }
    for (const name of augFields) {
      if (base.augment[name] === undefined) continue;
      validateEmojiAugField(`base.augment.${name}`, base.augment[name]);
    }
  }
  if (base.customTwlist !== undefined && !isRelativePath(base.customTwlist)) {
    fail('base.customTwlist must be a relative path string');
  }
  if (!Array.isArray(base.frequencies)) fail('base.frequencies must be an array');
  for (const f of base.frequencies) {
    if (typeof f !== 'string' || !FREQ_NAMES.has(f)) {
      fail(`base.frequencies contains invalid name: ${JSON.stringify(f)}`);
    }
  }
  if (base.customWordfreq !== undefined && !isRelativePath(base.customWordfreq)) {
    fail('base.customWordfreq must be a relative path string');
  }
  if (typeof base.tieBreak !== 'string' || !TIE_BREAKS.has(base.tieBreak)) {
    fail(`base.tieBreak must be one of: ${[...TIE_BREAKS].sort().join(', ')}`);
  }
  // hashedMergedTypes (default true) controls whether sortDict emits
  // hashes in place of comma-joined merged-type strings (see typehash.js).
  // Output content differs (different type names) but stays type-blind-
  // equivalent. Not encoded into byosID, shared URLs default to true.
  if (base.hashedMergedTypes !== undefined && typeof base.hashedMergedTypes !== 'boolean') {
    fail('base.hashedMergedTypes must be a boolean');
  }
  // generateHashmap (default false) controls whether the build emits a
  // sibling [byosID].typehash.json.gz fixture mapping each hash back to
  // its source merged-type string (for dehash / forensics). Has no
  // effect on dict/model content; not encoded into byosID.
  if (base.generateHashmap !== undefined && typeof base.generateHashmap !== 'boolean') {
    fail('base.generateHashmap must be a boolean');
  }
}

function validateBuild(build) {
  if (!isPlainObject(build)) fail('build must be a plain object');
  for (const k of Object.keys(build)) {
    if (!BUILD_KEYS.has(k)) fail(`unknown build field: ${k}`);
  }
  if (build.corpus !== undefined && !isRelativePath(build.corpus)) {
    fail('build.corpus must be a relative path string');
  }
}

// ---------------------------------------------------------------------
// generateBYOSID: encode the public spec into a deterministic byosID.
// Accepts either a full byos.json (name/notes/build are silently
// ignored) or a name-less public-spec object (the round-trip output of
// generateBYOS). Validates only fields that affect encoding.
// ---------------------------------------------------------------------
export function generateBYOSID(byos) {
  if (!isPlainObject(byos)) fail('input must be a plain object');
  if (byos.version !== SCHEMA_VERSION) {
    fail(`version must be ${SCHEMA_VERSION}; got ${JSON.stringify(byos.version)}`);
  }
  if (byos.story === undefined && byos.base === undefined) {
    fail('at least one of story or base is required');
  }
  if (byos.story !== undefined) validateStory(byos.story);
  if (byos.base !== undefined) validateBase(byos.base);
  if (byos.rewriter !== undefined) validateRewriter(byos.rewriter);
  if (byos.reformatter !== undefined) validateReformatter(byos.reformatter);

  const pairs = [];
  pairs.push(`v=${byos.version}`);

  if (byos.story !== undefined) {
    pairs.push(`sty=${encodeStoryStyle(byos.story.style)}`);
    if (byos.story.style !== 'flat') {
      pairs.push(`sen=${SENTENCE_ENCODE[byos.story.sentence]}`);
      pairs.push(`voc=${VOCABULARY_ENCODE[byos.story.vocabulary]}`);
    }
  }

  if (byos.base !== undefined) {
    const sortedSources = [...byos.base.sources].sort();
    pairs.push(`src=${sortedSources.join(',')}`);
    // Emoji augs: `eiw=<intensity>` / `wie=<intensity>` when enabled.
    // Intensity 0..MIX_MAX carries the repetition depth; an enabled
    // aug at intensity 0 still emits the shortcode so the decoder
    // can round-trip the enabled flag distinctly from disabled.
    const aug = byos.base.augment;
    if (aug && aug.emojiIntoWords && aug.emojiIntoWords.enabled === true) {
      const lvl = aug.emojiIntoWords.intensity ?? DEFAULT_INTENSITIES.augment.emojiIntoWords;
      pairs.push(`eiw=${lvl | 0}`);
    }
    if (aug && aug.wordsIntoEmoji && aug.wordsIntoEmoji.enabled === true) {
      const lvl = aug.wordsIntoEmoji.intensity ?? DEFAULT_INTENSITIES.augment.wordsIntoEmoji;
      pairs.push(`wie=${lvl | 0}`);
    }
    // Empty frequencies list omits the frq= segment entirely (same way
    // `av` is omitted when vowel is false). Decoder restores [] when frq
    // is absent in a byosID that otherwise carries a base block.
    if (byos.base.frequencies.length > 0) {
      const sortedFreqs = [...byos.base.frequencies].sort();
      pairs.push(`frq=${sortedFreqs.join(',')}`);
    }
    if (byos.base.customWordfreq !== undefined) {
      pairs.push('cwf');
    }
    pairs.push(`tb=${TIE_BREAK_ENCODE[byos.base.tieBreak]}`);
  }

  // Rewriter block: emit each enabled-AND-nonzero-intensity rewriter
  // as `<shortcode>=<intensity>[:<modeShort>]`. Disabled fields and
  // zero-intensity fields are omitted entirely (UI persistence of
  // disabled state stays out of the public byosID surface). Order is
  // by sorted long name for stable byosIDs.
  if (byos.rewriter !== undefined) {
    const enabled = [...REWRITER_NAMES].sort().filter(n => {
      const f = byos.rewriter[n];
      if (!isPlainObject(f) || f.enabled !== true) return false;
      const eff = f.intensity ?? DEFAULT_INTENSITIES.rewriter[n];
      return eff > 0;
    });
    for (const n of enabled) {
      const f = byos.rewriter[n];
      const eff = f.intensity ?? DEFAULT_INTENSITIES.rewriter[n];
      let segment = `${REWRITER_SHORTCODE_ENCODE[n]}=${eff}`;
      const modeShort = REWRITER_MODE_SHORTCODE_ENCODE[n]?.[f.mode];
      if (modeShort) segment += `:${modeShort}`;
      pairs.push(segment);
    }
  }

  // Reformatter block: same shape as the rewriter block. Sorted by
  // long name for stable byosIDs.
  if (byos.reformatter !== undefined) {
    const enabled = [...REFORMATTER_NAMES].sort().filter(n => {
      const f = byos.reformatter[n];
      if (!isPlainObject(f) || f.enabled !== true) return false;
      const eff = f.intensity ?? DEFAULT_INTENSITIES.reformatter[n];
      return eff > 0;
    });
    for (const n of enabled) {
      const f = byos.reformatter[n];
      const eff = f.intensity ?? DEFAULT_INTENSITIES.reformatter[n];
      let segment = `${REFORMATTER_SHORTCODE_ENCODE[n]}=${eff}`;
      const modeShort = REFORMATTER_MODE_SHORTCODE_ENCODE[n]?.[f.mode];
      if (modeShort) segment += `:${modeShort}`;
      pairs.push(segment);
    }
  }

  return pairs.join('__');
}

// ---------------------------------------------------------------------
// generateBYOS: decode a byosID back into a minimal public-spec byos
// object. Output has no name, no notes, no build block, and no custom
// upload references. Result is suitable for re-encoding via
// generateBYOSID; the round-trip identity holds by construction.
// ---------------------------------------------------------------------
export function generateBYOS(byosID) {
  if (typeof byosID !== 'string' || byosID.length === 0) {
    fail('byosID must be a non-empty string');
  }

  const seen = Object.create(null);
  for (const pair of byosID.split('__')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? true : pair.slice(eq + 1);
    if (key.length === 0) fail(`empty pair in byosID`);
    if (key in seen) fail(`duplicate key in byosID: ${key}`);
    seen[key] = val;
  }

  if (seen.v === undefined) fail('byosID missing required v= pair');
  const version = parseInt(seen.v, 10);
  if (!Number.isFinite(version) || String(version) !== seen.v || version !== SCHEMA_VERSION) {
    fail(`byosID v must be exactly ${SCHEMA_VERSION}; got ${JSON.stringify(seen.v)}`);
  }

  const out = { version };

  const hasStory = seen.sty !== undefined;
  // 'av' (augment.vowel) retired; the xanax rewriter shortcode `xa`
  // takes over the a/an agreement role. Old byosIDs containing `av`
  // are no longer parseable, by design per the cover-transforms
  // migration plan (no back-compat for shared URLs predating the arc).
  const baseKeys = ['src', 'frq', 'tb', 'eiw', 'wie', 'cwf'];
  const hasBase = baseKeys.some(k => seen[k] !== undefined);

  if (hasStory) {
    const styleLong = decodeStoryStyle(seen.sty);
    if (!styleLong) fail(`byosID sty has unknown value: ${seen.sty}`);
    const story = { style: styleLong };
    if (styleLong !== 'flat') {
      const senLong = SENTENCE_DECODE[seen.sen];
      const vocLong = VOCABULARY_DECODE[seen.voc];
      if (!senLong) fail(`byosID sen has unknown value: ${JSON.stringify(seen.sen)}`);
      if (!vocLong) fail(`byosID voc has unknown value: ${JSON.stringify(seen.voc)}`);
      story.sentence = senLong;
      story.vocabulary = vocLong;
    } else {
      if (seen.sen !== undefined) fail('byosID sen must be absent when sty=flat');
      if (seen.voc !== undefined) fail('byosID voc must be absent when sty=flat');
    }
    out.story = story;
  }

  if (hasBase) {
    if (seen.src === undefined) fail('byosID missing required src= when base is present');
    if (seen.tb === undefined) fail('byosID missing required tb= when base is present');
    const sources = seen.src === '' ? [] : seen.src.split(',');
    for (const s of sources) {
      if (!SOURCE_NAMES.has(s)) fail(`byosID src has unknown source: ${JSON.stringify(s)}`);
    }
    // Absent frq= means an empty frequencies array (the encoder omits
    // empty lists). Present frq= must list valid freq names.
    const frequencies = seen.frq === undefined
      ? []
      : (seen.frq === '' ? [] : seen.frq.split(','));
    for (const f of frequencies) {
      if (!FREQ_NAMES.has(f)) fail(`byosID frq has unknown freq: ${JSON.stringify(f)}`);
    }
    const tieBreakLong = TIE_BREAK_DECODE[seen.tb];
    if (!tieBreakLong) fail(`byosID tb has unknown value: ${JSON.stringify(seen.tb)}`);
    const base = { sources, frequencies, tieBreak: tieBreakLong };
    const aug = {};
    const parseEmojiAugIntensity = (key) => {
      if (seen[key] === undefined) return null;
      const v = seen[key];
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || String(n) !== v || n < 0 || n > MIX_MAX) {
        fail(`byosID ${key} must be an integer 0..${MIX_MAX}; got ${JSON.stringify(v)}`);
      }
      return n;
    };
    {
      const n = parseEmojiAugIntensity('eiw');
      if (n !== null) aug.emojiIntoWords = { enabled: true, intensity: n };
    }
    {
      const n = parseEmojiAugIntensity('wie');
      if (n !== null) aug.wordsIntoEmoji = { enabled: true, intensity: n };
    }
    if (Object.keys(aug).length > 0) base.augment = aug;
    // 'cwf' encodes only the fact a custom wordfreq was used; the path
    // is private. Restore as an opaque sentinel that passes validation
    // and re-encodes to the same `cwf` flag, preserving round-trip.
    if (seen.cwf === true) base.customWordfreq = '<custom>';
    out.base = base;
  }

  // Parse a `<intensity>[:<modeShort>]` payload for a cover-transform
  // shortcode. modeMap is the mode-short→long table for this field, or
  // null when the field is unimodal. Returns { intensity, mode? }.
  function parseCoverTransformPayload(code, raw, modeMap, label) {
    if (raw === true || typeof raw !== 'string') {
      fail(`byosID ${label} shortcode ${code} must carry an intensity value (e.g. ${code}=100)`);
    }
    const colon = raw.indexOf(':');
    const intRaw = colon === -1 ? raw : raw.slice(0, colon);
    const modeRaw = colon === -1 ? null : raw.slice(colon + 1);
    const intensity = parseInt(intRaw, 10);
    if (!Number.isFinite(intensity) || String(intensity) !== intRaw
        || intensity < 1 || intensity > 100) {
      fail(`byosID ${code} intensity must be an integer 1..100; got ${JSON.stringify(intRaw)}`);
    }
    if (modeRaw === null) {
      if (modeMap) fail(`byosID ${code} requires a :<mode> suffix`);
      return { intensity };
    }
    if (!modeMap) {
      fail(`byosID ${code} does not accept a mode suffix`);
    }
    const modeLong = modeMap[modeRaw];
    if (!modeLong) fail(`byosID ${code} has unknown mode: ${JSON.stringify(modeRaw)}`);
    return { intensity, mode: modeLong };
  }

  // Rewriter block: assemble from any present rewriter shortcodes.
  // Each is `<code>=<intensity>[:<modeShort>]`. Decoded block carries
  // `{enabled:true, intensity, mode?}` per field; absent codes leave
  // their fields off entirely.
  const rewriterShortcodes = Object.values(REWRITER_SHORTCODE_ENCODE);
  const enabledRewriterCodes = rewriterShortcodes.filter(c => seen[c] !== undefined);
  if (enabledRewriterCodes.length > 0) {
    const rewriter = {};
    for (const c of enabledRewriterCodes) {
      const longName = REWRITER_SHORTCODE_DECODE[c];
      const modeMap = REWRITER_MODE_SHORTCODE_DECODE[longName] || null;
      const payload = parseCoverTransformPayload(c, seen[c], modeMap, 'rewriter');
      rewriter[longName] = { enabled: true, intensity: payload.intensity };
      if (payload.mode !== undefined) rewriter[longName].mode = payload.mode;
    }
    out.rewriter = rewriter;
  }

  // Reformatter block: same shape as the rewriter block.
  const reformatterShortcodes = Object.values(REFORMATTER_SHORTCODE_ENCODE);
  const enabledReformatterCodes = reformatterShortcodes.filter(c => seen[c] !== undefined);
  if (enabledReformatterCodes.length > 0) {
    const reformatter = {};
    for (const c of enabledReformatterCodes) {
      const longName = REFORMATTER_SHORTCODE_DECODE[c];
      const modeMap = REFORMATTER_MODE_SHORTCODE_DECODE[longName] || null;
      const payload = parseCoverTransformPayload(c, seen[c], modeMap, 'reformatter');
      reformatter[longName] = { enabled: true, intensity: payload.intensity };
      if (payload.mode !== undefined) reformatter[longName].mode = payload.mode;
    }
    out.reformatter = reformatter;
  }

  const KNOWN_KEYS = new Set([
    'v', 'sty', 'sen', 'voc', 'src', 'frq', 'tb', 'eiw', 'wie', 'cwf',
    ...Object.values(REWRITER_SHORTCODE_ENCODE),
    ...Object.values(REFORMATTER_SHORTCODE_ENCODE),
  ]);
  for (const k of Object.keys(seen)) {
    if (!KNOWN_KEYS.has(k)) fail(`byosID contains unknown key: ${k}`);
  }

  return out;
}

// ---------------------------------------------------------------------
// getBYOSID: returns the canonical id used everywhere in the codebase
// to name a byos config. When `cards` contains an entry whose long-form
// byosID matches generateBYOSID(byos), returns the rev-suffixed
// nickname `${card.name}-${card.version}` (e.g. "aesop-1"). When no
// card matches, returns the long-form byosID (e.g.
// "v=1__sty=aesop__sen=r__voc=c"). Either form is filename-safe and
// URL-fragment-safe; consumers don't need to distinguish.
//
// This is the SINGLE place nicknames or any rev-incorporating logic
// lives. Filenames, URL fragments, cards.json `name` field consumers,
// share URLs, and tests all derive their canonical id from this call.
// Nobody else composes `${name}-${version}` or any equivalent.
// ---------------------------------------------------------------------
export function getBYOSID(byos, cards) {
  const id = generateBYOSID(byos);
  const card = findCardByBYOSID(id, cards);
  return card ? `${card.name}-${card.version}` : id;
}

// Back-compat alias for the previous name. Remove once all call sites
// are migrated.
export const formatBYOSID = getBYOSID;


// ---------------------------------------------------------------------
// findCardByBYOSID: linear lookup of a card by byosID. Returns null when
// no match. cards is an array of { name, byosID, ... } entries from
// fixtures/cards.json.
// ---------------------------------------------------------------------
export function findCardByBYOSID(byosID, cards) {
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    if (card && card.byosID === byosID) return card;
  }
  return null;
}

// ---------------------------------------------------------------------
// findCardByName: linear lookup of a card by raw name (without rev).
// Used for chip-mode → card resolution where the catalog carries the
// raw card name (e.g. chip.dictId === card.name → "aesop"). Compare
// to findCardByCanonicalID which expects the rev-suffixed form.
// ---------------------------------------------------------------------
export function findCardByName(name, cards) {
  if (!Array.isArray(cards) || typeof name !== 'string') return null;
  for (const card of cards) {
    if (card && card.name === name) return card;
  }
  return null;
}

// ---------------------------------------------------------------------
// findCardByCanonicalID: lookup by the rev-suffixed canonical id (the
// value getBYOSID returns for card-matched configs, e.g. "aesop-1").
// Tries this first; falls back to findCardByBYOSID when the input
// looks like a long-form byosID. Used by URL-fragment / share-URL
// receivers where the input could be either form.
// ---------------------------------------------------------------------
export function findCardByCanonicalID(id, cards) {
  if (!Array.isArray(cards) || typeof id !== 'string') return null;
  if (id.startsWith('v=')) return findCardByBYOSID(id, cards);
  for (const card of cards) {
    if (card && `${card.name}-${card.version}` === id) return card;
  }
  return null;
}

// ---------------------------------------------------------------------
// Fixture path helpers. Centralize the directory prefix and file-name
// extensions in ONE place so changing the layout (e.g., fixtures/ →
// data/, or moving dicts under fixtures/dicts/) is a single-line
// edit. All callers compose paths through these helpers.
// ---------------------------------------------------------------------
export const FIXTURES_PREFIX = 'fixtures/';

// Runtime fixture path = the SAB form. loadResource(path, 'dict', ...)
// fetches this. The native intermediate (the JSON the builder
// produces) lives at getDictNativePath; sab pack dict compiles native
// → SAB then deletes the native.
export function getDictPath(byos, cards) {
  return `${FIXTURES_PREFIX}${getBYOSID(byos, cards)}.dict.sab.gz`;
}

// Native intermediate path used by build-corpus-dict.js /
// build-base-dict.js (writes) and build-model-table.js (reads to
// derive the model). Not a runtime fixture: deleted by `sab pack
// dict` at the end of the build pipeline.
export function getDictNativePath(byos, cards) {
  return `${FIXTURES_PREFIX}${getBYOSID(byos, cards)}.dict.json.gz`;
}

// Runtime model-table fixture path = the SAB form.
// loadResource(path, 'model', ...) fetches this. The native
// intermediate (the JSON the model builder produces) lives at
// getModelNativePath; `sab pack model` compiles native → SAB then
// deletes the native at the end of the build pipeline.
export function getModelPath(byos, cards) {
  return `${FIXTURES_PREFIX}${getBYOSID(byos, cards)}.model.sab.gz`;
}

// Native intermediate path used by build-model-table.js (writes).
// Not a runtime fixture: deleted by `sab pack model` at the end of
// build-all-fixtures.
export function getModelNativePath(byos, cards) {
  return `${FIXTURES_PREFIX}${getBYOSID(byos, cards)}.model.json.gz`;
}

// Sibling fixture written when byos.base.generateHashmap is true.
// Maps each hashed merged-type back to its source comma-joined string
// (see js/src/builder/typehash.js dehashDict). Pure debug/forensics
// artifact; runtime never reads it.
export function getTypehashPath(byos, cards) {
  return `${FIXTURES_PREFIX}${getBYOSID(byos, cards)}.typehash.json.gz`;
}

// Runtime twlist fixture path = the SAB form (entries-SAB / NTEN,
// type+word pairs). loadResource(name, 'twlist', ...) fetches this.
// The native intermediate (the TSV the twlist builder produces)
// lives at getTwlistNativePath; `sab pack twlist` compiles native
// → SAB then deletes the native at the end of the build pipeline.
// Distinct from getWlistPath: a twlist preserves the type column;
// a wlist drops it (see SAB_RESOURCE_CATEGORIES discipline in js/src/sab.js).
export function getTwlistPath(name) {
  return `${FIXTURES_PREFIX}${name}.twlist.sab.gz`;
}

// Native intermediate path used by tools/build-twlist-fixtures.js
// (writes). Not a runtime fixture: deleted by `sab pack twlist` at
// the end of build-all-fixtures. Build-time consumers
// (build-twlist-wlist.js, build-corpus-dict.js, build-freq-fixtures
// when reading TSV legacy paths) reach for this during the
// build-all-fixtures window when natives still exist.
export function getTwlistNativePath(name) {
  return `${FIXTURES_PREFIX}${name}.twlist.tsv.gz`;
}

// Runtime emoji-cldr fixture path = the SAB form. loadResource(id,
// 'emoji-cldr', ...) fetches this. The native intermediate (the
// JSON the cldr builder produces) lives at getEmojiCldrNativePath;
// `sab pack emoji-cldr` compiles native → SAB then deletes the
// native at the end of the build pipeline. There is only one
// shipped emoji-cldr id today ('emoji16').
export function getEmojiCldrPath(name) {
  return `${FIXTURES_PREFIX}${name}.emoji-cldr.sab.gz`;
}

export function getEmojiCldrNativePath(name) {
  return `${FIXTURES_PREFIX}${name}.emoji-cldr.json.gz`;
}

// Runtime freq fixture path = the SAB form. loadResource(name, 'freq',
// ...) fetches this. The native intermediate (the TSV the freq
// builder produces) lives at getFreqNativePath; `sab pack freq`
// compiles native → SAB then deletes the native at the end of the
// build pipeline.
export function getFreqPath(name) {
  return `${FIXTURES_PREFIX}${name}.freq.sab.gz`;
}

export function getFreqNativePath(name) {
  return `${FIXTURES_PREFIX}${name}.freq.tsv.gz`;
}

// Runtime wlist fixture path = the SAB form. loadResource(name, 'wlist',
// ...) fetches this. The native intermediate (one-word-per-line gzipped
// text) lives at getWlistNativePath; `sab pack wlist` compiles native
// → SAB then deletes the native. wlist is a DISTINCT type from twlist:
// see SAB_RESOURCE_CATEGORIES in js/src/sab.js for the discipline.
export function getWlistPath(name) {
  return `${FIXTURES_PREFIX}${name}.wlist.sab.gz`;
}

export function getWlistNativePath(name) {
  return `${FIXTURES_PREFIX}${name}.wlist.txt.gz`;
}

export function getCardsPath() {
  return `${FIXTURES_PREFIX}cards.data.js`;
}

// Per-card runtime corpus fixture filename, derived from byos.build.corpus.
// Returns e.g. "aesop.txt.gz" or "texting-teen.txt.gz", or null when the
// card has no build.corpus (flat cards like master / mit). Glob suffixes
// (texting-teen*.txt) collapse to the stem before the wildcard, since
// build-all-fixtures.js concatenates the matched shards into a single
// runtime fixture.
export function getCorpusFile(card) {
  if (!card || !card.build || !card.build.corpus) return null;
  const base = card.build.corpus.split('/').pop();
  const stem = base.replace(/\*/g, '').replace(/\.txt$/i, '');
  return `${stem}.txt.gz`;
}

export function getCorpusPath(card) {
  const f = getCorpusFile(card);
  return f ? `${FIXTURES_PREFIX}${f}` : null;
}
