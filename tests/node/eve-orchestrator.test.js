// Eve orchestrator: DAG construction + Eve-event translation.
// Step 3 of the multi-worker scheduler arc. Tests use a mock
// dispatchJob that returns canned results so the orchestrator's
// wiring is exercised end-to-end without spinning up real workers.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { runOrchestrator } from '../../js/src/eve/orchestrator.js';
import { packStrings } from '../../js/src/eve/packed-strings-sab.js';
import { packMonotypedModel } from '../../js/src/eve/monotyped-model-sab.js';

const TWLIST_META = [
  { key: 'alpha', filename: 'alpha.twlist.tsv.gz' },
  { key: 'beta',  filename: 'beta.twlist.tsv.gz' },
];

const CARD_LIST = [
  { name: 'cardA', stem: 'a' },
  { name: 'cardB', stem: 'b' },
  { name: 'cardC-shared', stem: 'b' }, // shares 'b' with cardB
];

// Mock loadResource matches the shared resource-loader contract:
// positional (idOrPath, resourceCategory, opts). Per-twlist-source
// AND per-corpus wlists both load via resourceCategory='wlist' (id
// = the twlist source name or the corpus stem). The per-corpus
// monotyped-model loads via resourceCategory='monotyped-model' (id
// = corpus stem).
function makeMockLoadResource() {
  const calls = [];
  const loadResource = async (idOrPath, resourceCategory /* , opts */) => {
    const id = typeof idOrPath === 'string' ? idOrPath : JSON.stringify(idOrPath);
    calls.push({ id, resourceCategory });
    if (resourceCategory === 'wlist') return packStrings(['cat', 'sat', 'the']);
    if (resourceCategory === 'monotyped-model') return packMonotypedModel(['g|g|.']);
    throw new Error(`mock loadResource: unknown resourceCategory ${resourceCategory}`);
  };
  return { loadResource, calls };
}

function makeMockDispatch() {
  const calls = [];
  const dispatch = async (job) => {
    calls.push({ id: job.id, kind: job.kind });
    switch (job.kind) {
      case 'suspected-token-scan': return {
        verdicts: [
          { knob: 'augment.wordsIntoEmoji', verdict: 'unlikely', why: 'no emoji', rule: 'no-emoji-after-full-scan', contradiction: false, history: [] },
          { knob: 'augment.emojiIntoWords', verdict: 'unlikely', why: 'no emoji', rule: 'no-emoji-after-full-scan', contradiction: false, history: [] },
          { knob: 'augment.maxEmojiCluster',   verdict: 'unlikely', why: 'no runs', rule: 'no-emoji-runs-after-full-scan', contradiction: false, history: [] },
        ],
        tokenCount: 7,
      };
      case 'is-nicetext':       return {
        knob: 'isNiceText', verdict: 'likely', confidence: 0.5,
        why: 'preclean idempotent', done: true,
        rule: 'preclean-idempotent', contradiction: false, history: [],
      };
      case 'vocab-check':       return {
        totalUnique: 4,
        uniqueWords: ['the', 'cat', 'sat', 'mat'],
        twlistNames: ['alpha', 'beta'],
        perTwlistCoverage: new Map([
          ['alpha', { hits: 0, total: 4, rate: 0 }],
          ['beta',  { hits: 2, total: 4, rate: 0.5 }],
        ]),
        mustLiterals: ['mat'],
        candidateCombinations: [],
        table: new Map(),
      };
      case 'corpus-vocab-check': return {
        knob: `story.vocabulary.${job.payload.corpusName}`,
        verdict: 'likely', confidence: 0.7,
        why: 'subset of corpus_vocab(X)', done: true,
        rule: 'corpus-vocab-superset', contradiction: false, history: [],
        data: { allPresent: true, missing: 0, totalUnique: 4 },
      };
      case 'build-suspected-monotyped-model': return {
        monotypedModelSab: null,
        totalSuspected: 1,
      };
      case 'monotyped-model-check-card': return {
        name: job.payload.card.name,
        j: 0,
        matchDepth: 0,
        sequentialAlive: true,
        exactSeqMatches: 0,
        phraseSeqMatches: 0,
        rawHits: 0,
        anyVariantHits: 0,
        coveredHits: 0,
      };
      default:
        throw new Error(`mock: unknown kind ${job.kind}`);
    }
  };
  return { dispatch, calls };
}

test('orchestrator: builds DAG and emits banner + verdicts + done', async () => {
  const events = [];
  const { dispatch } = makeMockDispatch();
  const { loadResource } = makeMockLoadResource();
  await runOrchestrator({
    suspectedText: 'the cat sat on the mat.',
    twlistMeta: TWLIST_META,
    cardList: CARD_LIST,
    dispatchJob: dispatch,
    loadResource,
    onEvent: (e) => events.push(e),
  });
  const kinds = events.map(e => e.kind);
  assert.ok(kinds.includes('banner'), 'banner emitted');
  assert.ok(kinds.includes('done'), 'done emitted');
  assert.ok(kinds.includes('stats'), 'stats emitted');
  assert.ok(!kinds.includes('error'), 'no error');
  // Stats event carries the alive-combinations count, computed from
  // every verdict emitted in this run.
  const stats = events.find(e => e.kind === 'stats');
  assert.equal(typeof stats.combinationsAlive, 'number');
  assert.ok(stats.combinationsAlive > 0, 'some combinations should survive the mock verdicts');
  assert.equal(typeof stats.stylesConsidered, 'number');
  assert.equal(typeof stats.stylesIn, 'number');
  assert.equal(typeof stats.augCount, 'number');
  // verdict rows: isNiceText + 3 token-level + 1 vocab-check summary + 2 sources + 1 must-literals + 3 corpus-vocab (for cardA, cardB, cardC-shared) + 1 style.
  const verdicts = events.filter(e => e.kind === 'verdict');
  assert.ok(verdicts.some(v => v.knob === 'isNiceText'));
  assert.ok(verdicts.some(v => v.knob === 'augment.wordsIntoEmoji'));
  assert.ok(verdicts.some(v => v.knob === 'sources.alpha'));
  assert.ok(verdicts.some(v => v.knob === 'sources.beta'));
  assert.ok(verdicts.some(v => v.knob === 'story.vocabulary.cardA'));
  assert.ok(verdicts.some(v => v.knob === 'story.vocabulary.cardB'));
  assert.ok(verdicts.some(v => v.knob === 'story.vocabulary.cardC-shared'));
  assert.ok(verdicts.some(v => v.knob === 'story.style.cardA'));
  // Honest stubs for knobs no current strategy decides
  // (augment.vowel retired with the xanax rewriter migration).
  for (const knob of ['tieBreak', 'frequencies.norvig', 'frequencies.google', 'frequencies.gutenberg']) {
    const v = verdicts.find(x => x.knob === knob);
    assert.ok(v, `stub verdict for ${knob} emitted`);
    assert.equal(v.verdict, 'unknown');
    assert.ok(v.rule, `${knob} stub carries rule attribution`);
  }
});

test('orchestrator: dedupes corpus-precompute loads by stem', async () => {
  const { dispatch } = makeMockDispatch();
  const { loadResource, calls } = makeMockLoadResource();
  await runOrchestrator({
    suspectedText: 'suspected.',
    twlistMeta: TWLIST_META,
    cardList: CARD_LIST,   // cardB and cardC-shared both ref stem 'b'
    dispatchJob: dispatch,
    loadResource,
    onEvent: () => {},
  });
  // CARD_LIST has stems {a, b, b}; unique stems = {a, b}. Each stem
  // triggers two loads: one wlist (resourceCategory='wlist',
  // id=stem) and one monotyped-model (resourceCategory='monotyped-
  // model', id=stem). 2 stems × 2 loads = 4 corpus-precompute loads.
  const wlistByStem = calls.filter(
    (c) => c.resourceCategory === 'wlist' && ['a', 'b'].includes(c.id),
  );
  const monoByStem = calls.filter(
    (c) => c.resourceCategory === 'monotyped-model' && ['a', 'b'].includes(c.id),
  );
  assert.equal(wlistByStem.length, 2, 'one wlist load per unique stem (a, b)');
  assert.equal(monoByStem.length, 2, 'one monotyped-model load per unique stem (a, b)');
});

test('orchestrator: per-card corpus-vocab-check fires for every card', async () => {
  const { dispatch, calls } = makeMockDispatch();
  const { loadResource } = makeMockLoadResource();
  await runOrchestrator({
    suspectedText: 'suspected.',
    twlistMeta: TWLIST_META,
    cardList: CARD_LIST,
    dispatchJob: dispatch,
    loadResource,
    onEvent: () => {},
  });
  const cvc = calls.filter(c => c.kind === 'corpus-vocab-check');
  assert.equal(cvc.length, 3, 'three cards => three corpus-vocab-check jobs');
});

test('orchestrator: aborted before compute emits cancelled, not done', async () => {
  // Abort fires during the preload phase. The orchestrator
  // checks signal.aborted between preload and compute and bails.
  const controller = new AbortController();
  const events = [];
  const { dispatch } = makeMockDispatch();
  const loadResource = async () => {
    controller.abort();
    return packStrings(['x']);
  };
  await runOrchestrator({
    suspectedText: 'suspected.',
    twlistMeta: [{ key: 'alpha', filename: 'a.tsv.gz' }],
    cardList: [],
    dispatchJob: dispatch,
    loadResource,
    signal: controller.signal,
    onEvent: (e) => events.push(e),
  });
  const kinds = events.map(e => e.kind);
  assert.ok(kinds.includes('cancelled'), 'cancelled emitted');
  assert.ok(!kinds.includes('done'), 'done not emitted');
});

test('orchestrator: extraDetectors load raw-bytes and thread into suspected-token-scan', async () => {
  const events = [];
  const dispatchCalls = [];
  const { loadResource: baseLoadResource } = makeMockLoadResource();
  const loadCalls = [];
  // Wrap the base mock to capture calls and synthesize a raw-bytes
  // response for the extras URLs. The TSV body has one entry per
  // line so parseTwlistLines yields the words below.
  const RAW_BYTES_BY_URL = new Map([
    ['mock:twlist-extra/cliques.tsv.gz', 'noun\tcliques\nverb\tcoalesced\n'],
    ['mock:corpus-extra/secret.txt',     'These two custom corpus words: cliques coalesced.\n'],
  ]);
  const loadResource = async (idOrPath, resourceCategory, opts) => {
    const id = typeof idOrPath === 'string' ? idOrPath : JSON.stringify(idOrPath);
    loadCalls.push({ id, resourceCategory });
    if (resourceCategory === 'raw-bytes' && RAW_BYTES_BY_URL.has(id)) {
      const text = RAW_BYTES_BY_URL.get(id);
      return new TextEncoder().encode(text).buffer;
    }
    return baseLoadResource(idOrPath, resourceCategory, opts);
  };
  const dispatch = async (job) => {
    dispatchCalls.push(job);
    // Echo back the extras payload as part of the verdicts so we
    // can assert the orchestrator threaded the spec through.
    if (job.kind === 'suspected-token-scan') {
      const verdicts = [
        { knob: 'augment.wordsIntoEmoji', verdict: 'unlikely', why: 'n/a', rule: null, contradiction: false, history: [] },
        { knob: 'augment.emojiIntoWords', verdict: 'unlikely', why: 'n/a', rule: null, contradiction: false, history: [] },
        { knob: 'augment.maxEmojiCluster',   verdict: 'unlikely', why: 'n/a', rule: null, contradiction: false, history: [] },
      ];
      for (const e of job.payload.extras || []) {
        if (e.kind === 'source') {
          verdicts.push({ knob: `sources.${e.name}`, verdict: 'likely', why: `${e.words.length} words`, rule: null, contradiction: false, history: [] });
        } else if (e.kind === 'customCorpus') {
          verdicts.push({ knob: 'customCorpus', verdict: 'likely', why: `${e.words.length} words`, rule: null, contradiction: false, history: [] });
        } else if (e.kind === 'customTwlist') {
          verdicts.push({ knob: 'customTwlist', verdict: 'likely', why: `${e.words.length} words`, rule: null, contradiction: false, history: [] });
        }
      }
      return { verdicts, tokenCount: 0 };
    }
    return makeMockDispatch().dispatch(job);
  };
  await runOrchestrator({
    suspectedText: 'cliques coalesced rapidly.',
    twlistMeta: TWLIST_META,
    cardList: CARD_LIST,
    dispatchJob: dispatch,
    loadResource,
    extraDetectors: [
      { kind: 'source', name: 'cliques', url: 'mock:twlist-extra/cliques.tsv.gz' },
      { kind: 'customCorpus',           url: 'mock:corpus-extra/secret.txt' },
    ],
    onEvent: (e) => events.push(e),
  });
  // Loader got two raw-bytes calls for the two extras.
  const rawCalls = loadCalls.filter((c) => c.resourceCategory === 'raw-bytes');
  assert.equal(rawCalls.length, 2, 'two raw-bytes loads for the two extras');
  // Suspected-token-scan job carried the extras with parsed words.
  const cts = dispatchCalls.find(j => j.kind === 'suspected-token-scan');
  assert.ok(cts, 'suspected-token-scan job dispatched');
  const extras = cts.payload.extras;
  assert.equal(extras.length, 2);
  const src = extras.find(x => x.kind === 'source');
  const corp = extras.find(x => x.kind === 'customCorpus');
  assert.equal(src.name, 'cliques');
  assert.deepEqual([...src.words].sort(), ['cliques', 'coalesced']);
  assert.ok(corp.words.includes('cliques') && corp.words.includes('coalesced'),
    'custom corpus tokenized to word set');
  // Orchestrator surfaced verdict rows for the extras.
  const knobs = events.filter(e => e.kind === 'verdict').map(e => e.knob);
  assert.ok(knobs.includes('sources.cliques'), 'sources.<extra> verdict present');
  assert.ok(knobs.includes('customCorpus'), 'customCorpus verdict present');
});

test('orchestrator: dispatcher error emits error event', async () => {
  const events = [];
  const dispatch = async () => { throw new Error('worker exploded'); };
  const { loadResource } = makeMockLoadResource();
  await runOrchestrator({
    suspectedText: 'suspected.',
    twlistMeta: [{ key: 'alpha', filename: 'a.tsv.gz' }],
    cardList: [],
    dispatchJob: dispatch,
    loadResource,
    onEvent: (e) => events.push(e),
  });
  const err = events.find(e => e.kind === 'error');
  assert.ok(err, 'error event present');
  assert.match(err.message, /worker exploded/);
});
