// byos.recipe.test.js: translator from the modal's advanced-mode recipe
// (share.js encoding) to a public-spec byos.json. Verifies the
// round-trip identity that "a recipe whose settings exactly match a
// canonical card's byos.json produces the same byosID."

import { test } from '../shims/node-test.js';
import assert from '../shims/node-assert.js';
import { readFileSync } from '../shims/node-fs.js';
import { fileURLToPath } from '../shims/node-url.js';
import { dirname, join } from '../shims/node-path.js';

import { recipeToByos } from '../../../js/src/byos-recipe.js';
import { generateBYOSID } from '../../../js/src/byos.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BYOS_DIR = join(HERE, '..', '..', '..', 'tools', 'byos');

function loadByos(name) {
  return JSON.parse(readFileSync(join(BYOS_DIR, name), 'utf8'));
}

test('recipeToByos: returns null for chip-mode recipes', () => {
  assert.equal(recipeToByos({ kind: 'chip', chipId: 'aesop' }), null);
});

test('recipeToByos: returns null for missing/empty recipe', () => {
  assert.equal(recipeToByos(null), null);
  assert.equal(recipeToByos(undefined), null);
  assert.equal(recipeToByos({}), null);
});

test('recipeToByos: flat story → byos.story.style="flat", no sentence/vocab', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'], useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
  });
  assert.equal(byos.story.style, 'flat');
  assert.equal(byos.story.sentence, undefined);
  assert.equal(byos.story.vocabulary, undefined);
});

test('recipeToByos: built-in story → carries sentence + vocabulary', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'aesop',
    sources: [], useCorpus: true, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
  });
  assert.equal(byos.story.style, 'aesop');
  assert.equal(byos.story.sentence, 'random');
  assert.equal(byos.story.vocabulary, 'corpus');
});

test('recipeToByos: custom story → sty=custom, vocab from useCorpus', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'custom',
    sources: [], useCorpus: false, scope: 'sequential',
    freqs: [], tieBreak: 'alpha-asc',
  });
  assert.equal(byos.story.style, 'custom');
  assert.equal(byos.story.sentence, 'sequential');
  assert.equal(byos.story.vocabulary, 'base');
});

test('recipeToByos: customTw flag adds "customtw" to base.sources', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'], customTw: true,
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
  });
  assert.deepEqual(byos.base.sources.sort(), ['customtw', 'mit']);
});

test('recipeToByos: rewriter.xanax intensity passes through', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'],
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
    rewriter: { xanax: { enabled: true, intensity: 100 } },
  });
  assert.deepEqual(byos.rewriter.xanax, { enabled: true, intensity: 100 });
});

test('recipeToByos: rewriter.typos passes through with mode', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'],
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
    rewriter: { typos: { enabled: true, intensity: 50, mode: 'forward' } },
  });
  assert.deepEqual(byos.rewriter.typos, { enabled: true, intensity: 50, mode: 'forward' });
});

test('recipeToByos: rewriter.voice passes through with mode', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'],
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
    rewriter: { voice: { enabled: true, intensity: 75, mode: 'pirate' } },
  });
  assert.deepEqual(byos.rewriter.voice, { enabled: true, intensity: 75, mode: 'pirate' });
});

test('recipeToByos: reformatter values pass through', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'],
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
    reformatter: {
      lineBreak: { enabled: true, intensity: 100, mode: 'expand' },
      case:      { enabled: true, intensity: 100, mode: 'titleCase' },
    },
  });
  assert.deepEqual(byos.reformatter.lineBreak, { enabled: true, intensity: 100, mode: 'expand' });
  assert.deepEqual(byos.reformatter.case,      { enabled: true, intensity: 100, mode: 'titleCase' });
});

test('recipeToByos: disabled rewriter fields are dropped', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'],
    useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
    rewriter: { xanax: { enabled: false, intensity: 100 } },
  });
  assert.equal(byos.rewriter, undefined);
});

test('recipeToByos: tieBreak length-desc → prefer-shorter', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'], useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'length-desc',
  });
  assert.equal(byos.base.tieBreak, 'prefer-shorter');
});

test('recipeToByos: tieBreak alpha-asc passes through', () => {
  const byos = recipeToByos({
    kind: 'advanced', story: 'flat',
    sources: ['mit'], useCorpus: false, scope: 'random',
    freqs: [], tieBreak: 'alpha-asc',
  });
  assert.equal(byos.base.tieBreak, 'alpha-asc');
});

// --- card-match identity ---

test('recipeToByos: random-equivalent recipe produces random card byosID', () => {
  // A user who in the BYOS modal selected exactly the random card's
  // sources, xanax rewriter, no freqs, prefer-shorter tie-break,
  // no story (flat) should compute the same byosID as the random
  // card. The recipe sends the engine name 'length-desc' and
  // recipeToByos translates it to the schema name 'prefer-shorter'.
  const randomCard = loadByos('random.byos.json');
  const randomCardID = generateBYOSID(randomCard);
  const recipe = {
    kind: 'advanced',
    story: 'flat',
    sources: ['impf2p', 'impkimmo', 'mit', 'num-form-preserved', 'rhyme'],
    useCorpus: false,
    scope: 'random',
    freqs: [],
    tieBreak: 'length-desc',
    rewriter: { xanax: { enabled: true, intensity: 100 } },
  };
  const byos = recipeToByos(recipe);
  assert.equal(generateBYOSID(byos), randomCardID);
});

test('recipeToByos: aesop-equivalent recipe produces aesop card byosID', () => {
  const aesopCard = loadByos('aesop.byos.json');
  const aesopCardID = generateBYOSID(aesopCard);
  // Aesop card has only a story block; the modal's advanced recipe
  // always carries a base block too. To match, the base block has to
  // carry no augment (default) and it has to NOT contribute extra
  // sources/freqs/tieBreak that would diverge. The card's byosID has
  // no `src=` segment because there's no base block at all -- so the
  // recipe's empty-sources base block (which still emits `src=`,
  // `frq=` is omitted-when-empty per encoder rule, `tb=p`) WILL diverge.
  // This test pins that asymmetry: recipes with bases simply do not
  // match story-only cards. Future work: the modal could detect
  // story-only matches by stripping its base block before lookup.
  const recipe = {
    kind: 'advanced', story: 'aesop',
    sources: [], useCorpus: true, scope: 'random',
    freqs: [], tieBreak: 'length-desc',
  };
  const byos = recipeToByos(recipe);
  assert.notEqual(generateBYOSID(byos), aesopCardID);
});
