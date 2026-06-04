// Eavesdropper supervisor worker. Spawned by the page on the
// Eve tab's "Go" click. Receives a suspected text via {type:'run',
// suspectedText}, manages a pool of compute workers, drives the
// orchestrator, and streams Eve verdict events back to the page.
//
// Message protocol:
//   in  { type: 'run', suspectedText: string, observations?: {...} }
//   in  { type: 'cancel' }
//   out { type: 'event', event: { kind, ... } }
//
// observations are Cover-Story-side cached findings that Eve would
// derive on her own if she had her own load/unwrap pipeline (wrapper
// layers detected/applied, preclean state). Shape lives in
// js/app.js / coverObservations.
//
// Event kinds (emitted by js/src/eve/orchestrator.js):
//   banner, progress, verdict, detail, done, cancelled, error.
//
// The supervisor itself does no Eve compute. It owns the worker
// pool and the AbortController, then hands the orchestrator a
// dispatch callback that forwards each scheduler job to an idle
// pool worker. Per the multi-worker scheduler arc design (see
// docs/eve-plan.md), the orchestrator is pure ESM shared between
// the browser and the node CLI.

import { createPool } from './src/worker/pool.js';
import { runOrchestrator } from './src/eve/orchestrator.js';
import { loadResource } from './src/resource-loader-client.js';
import twlistSourcesMeta from '../fixtures/twlist-sources.meta.js';
import cardsRegistry from '../fixtures/cards.data.js';

const POOL_WORKER_URL = new URL('./src/eve/job-worker-entry.js', import.meta.url);

// Per-corpus precomputes (wlist + monotyped-model) load via
// loadResource(stem, resourceCategory, { fixture: true }); the loader
// auto-composes /fixtures/<stem>.<category>.sab.gz from one anchor.

let cancelController = null;
let inFlight = false;
let pool = null;

self.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') {
    if (cancelController) cancelController.abort();
    return;
  }
  if (msg.type !== 'run') return;
  if (inFlight) {
    post({ kind: 'error', message: 'eve-worker: run already in flight' });
    return;
  }
  inFlight = true;
  cancelController = new AbortController();
  // Short-circuit the scheduler's drain loop on cancel: the
  // scheduler stops dispatching new jobs immediately, but in-flight
  // jobs would otherwise have to run to completion. Calling
  // pool.terminate() on signal abort kills the workers outright;
  // pool.terminate() then rejects each in-flight pending dispatch
  // with an AbortError so the scheduler's catch handler decrements
  // `running` and the drain exits. Cache hygiene + atomic-on-reply
  // design ensure no partial state lands in the resource-loader
  // cache or in scheduler results (see pool.js / terminate notes).
  cancelController.signal.addEventListener('abort', () => {
    if (pool) {
      pool.terminate().catch(() => {});
    }
  });
  try {
    await runOnce(msg.suspectedText, msg.observations);
  } catch (e) {
    post({ kind: 'error', message: String(e && (e.stack || e.message) || e) });
  } finally {
    inFlight = false;
    cancelController = null;
    if (pool) {
      try { await pool.terminate(); } catch {}
      pool = null;
    }
  }
});

function post(event) {
  self.postMessage({ type: 'event', event });
}

async function runOnce(suspectedText, observations) {
  // Pool size: one less than hardwareConcurrency so the supervisor
  // thread itself stays responsive for postMessage routing and the
  // page main thread keeps a free core. defaultPoolSize() honors
  // navigator.hardwareConcurrency in the browser; createPool clamps
  // to >= 1.
  pool = await createPool({
    workerUrl: POOL_WORKER_URL,
    // Forward pool composition + per-worker busy/idle transitions
    // straight to the page so the eve-log's worker-status block
    // (and the busy-modal mirror) can render N live-updating rows.
    onEvent: post,
  });

  const twlistMeta = twlistSourcesMeta.map((e) => ({
    key: e.key,
    filename: e.filename,
  }));
  const cardList = cardsRegistry
    .filter((c) => c.build && c.build.corpus)
    .map((c) => ({ name: c.name, stem: stemForCorpus(c.build.corpus) }));

  await runOrchestrator({
    suspectedText,
    observations,
    twlistMeta,
    cardList,
    dispatchJob: pool.dispatch,
    loadResource,
    concurrency: pool.size,
    signal: cancelController.signal,
    onEvent: post,
  });
}

// Mirrors corpusStem in tools/build-monotyped-models.js: strip
// directory, drop '*' (texting-teen glob), strip '.txt'.
function stemForCorpus(corpusPath) {
  const base = corpusPath.split('/').pop();
  return base.replace(/\*/g, '').replace(/\.txt$/i, '');
}

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// all imports + handler registration; createWorker() awaits this
// before resolving. This worker uses self.postMessage directly
// (no parent-port shim), so the ready signal goes through self.
// Forgetting this line will hang createWorker().
self.postMessage({ type: 'ready' });
