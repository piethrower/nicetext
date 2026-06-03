// byos.panel.test.js: bidirectional translation between byos.json and
// the Advanced panel's flat panel-controls shape. Verifies the
// round-trip identity that "a panel state derived from a card's byos
// re-encodes to the same byosID as the original card." This is the
// load-bearing property for the chip ↔ Advanced panel binding: a chip
// click loads the card's byos into the panel; subsequent panel-driven
// byosID lookups must produce the same id back.

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';
import { readFileSync, readdirSync } from '../shims/node-fs.js';
import { fileURLToPath } from '../shims/node-url.js';
import { dirname, join } from '../shims/node-path.js';
import { nodeOnly } from '../_runtime.js';

import { byosToPanel, panelToByos } from '../../../js/src/byos-panel.js';
import { generateBYOSID, validate as validateByos } from '../../../js/src/byos.js';
import cardsRegistry from '../../../fixtures/cards.data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BYOS_DIR = join(HERE, '..', '..', '..', 'tools', 'byos');

function loadByosFile(name) {
  return JSON.parse(readFileSync(join(BYOS_DIR, name), 'utf8'));
}

// ---------------------------------------------------------------------
// Round-trip: every shipped card's byos must survive
// byos → byosToPanel → panelToByos → generateBYOSID with the same id.
// ---------------------------------------------------------------------

test('byos round-trip: every card in cards.data.js preserves byosID', () => {
  for (const card of cardsRegistry) {
    const panel = byosToPanel(card);
    const reconstructed = panelToByos(panel);
    reconstructed.name = '_roundtrip';
    validateByos(reconstructed);
    const reId = generateBYOSID(reconstructed);
    assert.strictEqual(
      reId, card.byosID,
      `${card.name} (v${card.version}): byosID mismatch after panel round-trip`,
    );
  }
});

test('byos round-trip: every byos.json source file preserves byosID', nodeOnly('readdirSync filesystem walk'), () => {
  const files = readdirSync(BYOS_DIR).filter(f => f.endsWith('.byos.json'));
  for (const f of files) {
    const byos = loadByosFile(f);
    // Mirror the production pipeline: every byos crosses the
    // validate boundary before reaching the panel (cards.data.js
    // entries are validate-emitted by tools/build-all-fixtures.js;
    // user-edit paths revalidate per change). Validate is also the
    // canonicalizer: it fills in default intensities so the panel
    // sees a fully populated field-shape.
    validateByos(byos);
    const panel = byosToPanel(byos);
    const reconstructed = panelToByos(panel);
    reconstructed.name = byos.name;
    validateByos(reconstructed);
    const sourceId = generateBYOSID(byos);
    const reId = generateBYOSID(reconstructed);
    assert.strictEqual(reId, sourceId, `${f}: byosID mismatch`);
  }
});

// ---------------------------------------------------------------------
// hasStory / hasBase block-presence flags must mirror the source byos.
// These flags are how the panel knows when to mark a section as "not
// part of this recipe" while keeping default values in its DOM
// controls.
// ---------------------------------------------------------------------

test('byosToPanel: hasStory/hasBase reflect block presence', () => {
  for (const card of cardsRegistry) {
    const panel = byosToPanel(card);
    assert.strictEqual(panel.hasStory, Boolean(card.story), `${card.name}: hasStory`);
    assert.strictEqual(panel.hasBase, Boolean(card.base), `${card.name}: hasBase`);
  }
});

test('byosToPanel: synthetic story-only byos sets hasBase=false', () => {
  const byos = {
    version: 1,
    story: { style: 'aesop', sentence: 'random', vocabulary: 'corpus' },
  };
  const panel = byosToPanel(byos);
  assert.strictEqual(panel.hasStory, true);
  assert.strictEqual(panel.hasBase, false);
  // Default base values surface in the panel even when hasBase=false.
  assert.deepStrictEqual(panel.sources, []);
  assert.strictEqual(panel.tieBreak, 'alpha-asc');
});

test('byosToPanel: synthetic base-only byos sets hasStory=false', () => {
  const byos = {
    version: 1,
    base: {
      sources: ['mit', 'connectors'],
      frequencies: [],
      tieBreak: 'alpha-asc',
    },
  };
  const panel = byosToPanel(byos);
  assert.strictEqual(panel.hasStory, false);
  assert.strictEqual(panel.hasBase, true);
  assert.deepStrictEqual(panel.sources, ['mit', 'connectors']);
  // Default story values surface even when hasStory=false.
  assert.strictEqual(panel.storyStyle, 'flat');
  assert.strictEqual(panel.sentence, null);
  assert.strictEqual(panel.vocabulary, null);
});

// ---------------------------------------------------------------------
// Specific field-translation properties.
// ---------------------------------------------------------------------

test('byosToPanel: customtw membership surfaces as a separate flag', () => {
  const byos = {
    version: 1,
    base: {
      sources: ['impf2p', 'customtw', 'mit'],
      frequencies: [],
      tieBreak: 'alpha-asc',
    },
  };
  const panel = byosToPanel(byos);
  assert.deepStrictEqual(panel.sources, ['impf2p', 'mit']);
  assert.strictEqual(panel.customTw, true);
});

test('panelToByos: customTw flag re-attaches customtw to base.sources', () => {
  const panel = byosToPanel({
    version: 1,
    base: {
      sources: ['impf2p', 'customtw', 'mit'],
      frequencies: [],
      tieBreak: 'alpha-asc',
    },
  });
  const byos = panelToByos(panel);
  assert.ok(byos.base.sources.includes('customtw'));
  assert.ok(byos.base.sources.includes('impf2p'));
  assert.ok(byos.base.sources.includes('mit'));
});

test('byosToPanel: rewriterXanax pulls enabled/intensity out of byos.rewriter.xanax', () => {
  const onF = byosToPanel({ version: 1, base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' }, rewriter: { xanax: { enabled: true,  intensity: 100 } } });
  const onH = byosToPanel({ version: 1, base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' }, rewriter: { xanax: { enabled: true,  intensity:  50 } } });
  const off = byosToPanel({ version: 1, base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' }, rewriter: { xanax: { enabled: false, intensity: 100 } } });
  const abs = byosToPanel({ version: 1, base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' } });
  assert.strictEqual(onF.rewriterXanaxEnabled,   true);
  assert.strictEqual(onF.rewriterXanaxIntensity, 100);
  assert.strictEqual(onH.rewriterXanaxIntensity, 50);
  assert.strictEqual(off.rewriterXanaxEnabled,   false);
  assert.strictEqual(off.rewriterXanaxIntensity, 100);
  assert.strictEqual(abs.rewriterXanaxEnabled,   false);
  assert.strictEqual(abs.rewriterXanaxIntensity, 0);
});

test('panelToByos: enabled+positive xanax emits rewriter block; disabled omits it', () => {
  const yes  = panelToByos({ hasStory: false, hasBase: true, sources: ['mit'], customTw: false, rewriterXanaxEnabled: true,  rewriterXanaxIntensity: 100, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc' });
  const half = panelToByos({ hasStory: false, hasBase: true, sources: ['mit'], customTw: false, rewriterXanaxEnabled: true,  rewriterXanaxIntensity:  25, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc' });
  const off  = panelToByos({ hasStory: false, hasBase: true, sources: ['mit'], customTw: false, rewriterXanaxEnabled: false, rewriterXanaxIntensity: 100, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc' });
  const zero = panelToByos({ hasStory: false, hasBase: true, sources: ['mit'], customTw: false, rewriterXanaxEnabled: true,  rewriterXanaxIntensity:   0, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc' });
  assert.deepStrictEqual(yes.rewriter,  { xanax: { enabled: true, intensity: 100 } });
  assert.deepStrictEqual(half.rewriter, { xanax: { enabled: true, intensity:  25 } });
  assert.strictEqual(off.rewriter, undefined);
  assert.strictEqual(zero.rewriter, undefined);
});

test('byosToPanel: reformatter fields pull out of byos.reformatter', () => {
  const set = byosToPanel({
    version: 1,
    base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' },
    reformatter: {
      lineBreak: { enabled: true, intensity: 100, mode: 'expand' },
      case:      { enabled: true, intensity: 100, mode: 'titleCase' },
    },
  });
  const abs = byosToPanel({ version: 1, base: { sources: ['mit'], frequencies: [], tieBreak: 'alpha-asc' } });
  assert.strictEqual(set.reformatterLineBreakEnabled,   true);
  assert.strictEqual(set.reformatterLineBreakIntensity, 100);
  assert.strictEqual(set.reformatterLineBreakMode,      'expand');
  assert.strictEqual(set.reformatterCaseEnabled,        true);
  assert.strictEqual(set.reformatterCaseIntensity,      100);
  assert.strictEqual(set.reformatterCaseMode,           'titleCase');
  assert.strictEqual(abs.reformatterLineBreakEnabled, false);
  assert.strictEqual(abs.reformatterCaseEnabled,      false);
  assert.strictEqual(abs.reformatterLineBreakMode,    'expand');
  assert.strictEqual(abs.reformatterCaseMode,         'titleCase');
});

test('panelToByos: enabled reformatter fields emit block; disabled omit', () => {
  const set = panelToByos({
    hasStory: false, hasBase: true, sources: ['mit'], customTw: false, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc',
    reformatterLineBreakEnabled: true, reformatterLineBreakIntensity: 100, reformatterLineBreakMode: 'collapse',
    reformatterCaseEnabled: true, reformatterCaseIntensity: 100, reformatterCaseMode: 'allCaps',
  });
  const def = panelToByos({
    hasStory: false, hasBase: true, sources: ['mit'], customTw: false, freqs: [], customWordfreq: false, tieBreak: 'alpha-asc',
    reformatterLineBreakEnabled: false, reformatterLineBreakIntensity: 100, reformatterLineBreakMode: 'expand',
    reformatterCaseEnabled: false, reformatterCaseIntensity: 100, reformatterCaseMode: 'titleCase',
  });
  assert.deepStrictEqual(set.reformatter, {
    lineBreak: { enabled: true, intensity: 100, mode: 'collapse' },
    case:      { enabled: true, intensity: 100, mode: 'allCaps'  },
  });
  assert.strictEqual(def.reformatter, undefined);
});

test('byosToPanel: customWordfreq presence becomes a boolean flag', () => {
  const present = byosToPanel({
    version: 1,
    base: {
      sources: ['mit'], frequencies: ['style'], tieBreak: 'alpha-asc',
      customWordfreq: 'fixtures/some-upload.tsv',
    },
  });
  const absent = byosToPanel({
    version: 1,
    base: { sources: ['mit'], frequencies: ['style'], tieBreak: 'alpha-asc' },
  });
  assert.strictEqual(present.customWordfreq, true);
  assert.strictEqual(absent.customWordfreq, false);
});
