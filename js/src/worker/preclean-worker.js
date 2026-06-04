// Preclean worker. Runs `precleanCorpus` off the main thread so big
// custom corpora (multi-MB) don't block the UI while the do-while
// loop chews through the regex passes. Browser-only. Node callers
// import `precleanCorpus` directly because they're already off the
// main thread (genmodel, listword inside build-session-worker).
//
// Protocol:
//
//   parent -> worker: { type: 'preclean', requestId, text }
//   worker -> parent: { type: 'progress', requestId, info }
//                  or { type: 'result',   requestId, text }
//                  or { type: 'error',    requestId, error }
//
// The worker handles one request at a time; the main-thread helper
// (preclean-async.js) serializes calls behind a single in-flight
// promise. requestId is echoed back so the helper can reject a
// stale promise if it ever races.
//
// Cancellation is by worker termination (the regex passes are
// single-threaded and can't be interrupted mid-execution). The
// helper terminates this worker on AbortSignal and respawns on the
// next call.

import { parentPort } from './parent-port.js';
import { precleanCorpus } from '../builder/precleanCorpus.js';

parentPort.onMessage((msg) => {
  if (!msg || msg.type !== 'preclean') return;
  const { requestId, text } = msg;
  try {
    const cleaned = precleanCorpus(text, (info) => {
      // Forward each chunk-completion event to the main thread so the
      // Cleaning Corpus modal can display numeric progress while a
      // multi-MB preclean runs. Info shape (post-chunking refactor
      // 2026-05-18): { pass, chunkIndex, chunkCount, chars }.
      parentPort.postMessage({ type: 'progress', requestId, info });
    });
    parentPort.postMessage({ type: 'result', requestId, text: cleaned });
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      requestId,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// all imports + handler registration; createWorker() awaits this
// before resolving. Forgetting this line will hang createWorker().
parentPort.postMessage({ type: 'ready' });
