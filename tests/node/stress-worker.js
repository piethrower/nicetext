// Stress runner worker. Owns asset loading, dictionary + model
// building, and the encode/decode loop so the main thread stays
// responsive while a stress run is in flight. The Stress Test page
// (stress-test.html) spawns one instance per Run click and renders
// the events posted back here.
//
// SAB-backed fixtures (TW-lists, the emoji CLDR map, the curated-
// keyword filter) load through the canonical resource loader: this
// worker calls loadResource (the resource-loader-client proxy), and
// the page wires it to the main-thread loader via attachLoaderProxy.
// The two curated corpora still ship as raw .txt.gz and are fetched
// directly for the snip corpus.
//
// Message protocol:
//   in  { type: 'run', mode: 'snip'|'random', length: 'quick'|'extended' }
//   in  { type: 'abort' }
//   out { type: 'event', event: { kind, ... } }   // runStress events,
//                                                 // plus { kind: 'fatal', message }
//
// Browser-safe ESM, no Node deps. Imports resolve as classic ES
// modules because the page spawns this worker with { type: 'module' }.

import {
  runStress,
  synthCorpus,
  snipCorpusFromFixtures,
  DEFAULT_SOURCES,
  DEFAULT_SIZES,
} from './stress/stress-engine.js';
import { loadResource } from '../../js/src/resource-loader-client.js';
import { loadStressAssets, entriesToSnipFixture } from './stress/load-assets.js';

const QUICK_SIZES = [1, 64, 1024];
const QUICK_REPS = 1;
const QUICK_CORPUS_BYTES = 32 * 1024;
const EXTENDED_REPS = 1;
const EXTENDED_CORPUS_BYTES = 1 * 1024 * 1024;
const EXTENDED_DURATION_MS = 10 * 60 * 1000;
const CORPUS_SEED = 0xC0FFEE;
const RNG_SEED = 0xC0DEBABE;
const SOURCES = [...DEFAULT_SOURCES, 'emoji16', 'emoji-cldr-names-16', 'emoji-curated-phrases-16'];
const FIXTURE_BASE = new URL('../../fixtures/', import.meta.url);

// Snip-corpus inputs. The two curated corpora still ship as raw
// .txt.gz and are fetched directly (prose + gzip-binary regimes). The
// twlist content that used to ship as .twlist.tsv.gz is now SAB, so
// its lexical contribution is re-derived from the entries already
// loaded for the dict build (see buildSnipCorpus).
const SNIP_CORPORA = ['aesop-curated.txt.gz', 'frankenstein-curated.txt.gz'];
const SNIP_TWLIST_KEYS = ['claude2026', 'emoji16'];

let controller = null;

self.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'abort') {
    if (controller) controller.abort();
    return;
  }
  if (msg.type !== 'run') return;
  if (controller) {
    post({ kind: 'fatal', message: 'stress-worker: run already in flight' });
    return;
  }
  controller = new AbortController();
  try {
    await runOnce(msg);
  } catch (e) {
    post({ kind: 'fatal', message: String(e?.message || e) });
  } finally {
    controller = null;
  }
});

function post(event) {
  // Strip non-cloneable bits (Error objects with stack traces are
  // cloneable but bulky). Failure events carry source/cover/recovered
  // bytes: keep them so the UI can offer a download later.
  self.postMessage({ type: 'event', event });
}

async function fetchFixturePair(name) {
  const r = await fetch(new URL(name, FIXTURE_BASE));
  if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());
  let inflated = null;
  if (name.endsWith('.gz') && raw[0] === 0x1f && raw[1] === 0x8b) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { name, raw, inflated };
}

// Build the snip corpus. Corpora are fetched raw; twlist content comes
// from the already-loaded entries so we don't fetch them twice.
async function buildSnipCorpus(byteCount, assets) {
  const fixtures = [];
  for (const name of SNIP_CORPORA) fixtures.push(await fetchFixturePair(name));
  for (const key of SNIP_TWLIST_KEYS) {
    fixtures.push(entriesToSnipFixture(key, assets.baseTwlists[key]));
  }
  return snipCorpusFromFixtures(fixtures, CORPUS_SEED, byteCount);
}

async function runOnce({ mode = 'snip', length = 'quick' }) {
  const isExtended = length === 'extended';
  const corpusBytes = isExtended ? EXTENDED_CORPUS_BYTES : QUICK_CORPUS_BYTES;

  // Assets first: the snip corpus reuses the loaded twlist entries, and
  // the random-byte corpus still needs the dict-building inputs.
  post({ kind: 'setup', detail: 'loading source TW-lists, CLDR table, curated keywords...' });
  const assets = await loadStressAssets(loadResource, SOURCES);

  post({ kind: 'setup', detail: `building ${mode === 'snip' ? 'sample-file' : 'random-byte'} corpus...` });
  const corpus = mode === 'snip'
    ? await buildSnipCorpus(corpusBytes, assets)
    : synthCorpus(corpusBytes, CORPUS_SEED);

  const sizes = isExtended ? DEFAULT_SIZES : QUICK_SIZES;
  const reps = isExtended ? EXTENDED_REPS : QUICK_REPS;
  const maxDurationMs = isExtended ? EXTENDED_DURATION_MS : Infinity;

  await runStress({
    signal: controller.signal,
    sizes,
    reps,
    rngSeed: RNG_SEED,
    corpus,
    assets,
    sources: SOURCES,
    emojiFlood: true,
    restrict: false,
    maxSweeps: 1,
    maxDurationMs,
    onProgress: post,
  });
}
