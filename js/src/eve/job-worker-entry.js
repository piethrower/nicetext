// Eve job-worker entrypoint. Step 3 of the multi-worker scheduler
// arc. One file, two runtimes: loaded as a module Worker in the
// browser, and as a worker_threads worker in node, via the
// cross-runtime parent-port shim.
//
// Message protocol:
//   in   { jobId, kind, payload }
//   in   { type: 'shutdown' }
//   out  { jobId, ok: true,  result }                  final reply
//   out  { jobId, ok: false, error: { name, message } } final reply
//   out  { jobId, progress: { label } }                 intermediate
//
// Handlers receive a `progress(label)` callback they can call
// throughout the job. The pool routes those to `worker-progress`
// events so the page's worker-status row updates in place. No
// promise resolves until the final reply.
//
// Handlers split by job kind. Pure-compute kinds delegate to
// job-handlers.js. Load kinds (load-twlist,
// load-corpus-precompute) do their own fetch+decompress+parse here
// because they belong on the worker for parallelism, and fetch is
// runtime-aware (fetch + DecompressionStream in browser; fs+zlib
// in node).
//
// Browser-safe and node-safe ESM.

import { parentPort } from '../worker/parent-port.js';
import {
  runSuspectedTokenScanJob,
  runIsNiceTextJob,
  runVocabCheckJob,
  runCorpusVocabCheckJob,
  runBuildSuspectedMonotypedModelJob,
  runMonotypedModelCheckCardJob,
} from './job-handlers.js';

const IS_NODE = typeof process !== 'undefined'
  && typeof process.versions === 'object'
  && typeof process.versions.node === 'string';

async function dispatch(kind, payload, progress) {
  switch (kind) {
    case 'suspected-token-scan':         return await runSuspectedTokenScanJob(payload, progress);
    case 'is-nicetext':              return await runIsNiceTextJob(payload);
    case 'vocab-check':              return runVocabCheckJob(payload, progress);
    case 'corpus-vocab-check':       return runCorpusVocabCheckJob(payload);
    case 'build-suspected-monotyped-model': return runBuildSuspectedMonotypedModelJob(payload);
    case 'monotyped-model-check-card':   return await runMonotypedModelCheckCardJob(payload, progress);
    default:
      throw new Error(`job-worker-entry: unknown job kind "${kind}"`);
  }
}

parentPort.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    if (IS_NODE) process.exit(0);
    else self.close();
    return;
  }
  const { jobId, kind, payload } = msg;
  // Per-job progress callback. Handlers call `progress(label)`
  // mid-flight; the pool wires the resulting messages to
  // `worker-progress` events.
  const progress = (label) => {
    parentPort.postMessage({ jobId, progress: { label } });
  };
  try {
    const result = await dispatch(kind, payload, progress);
    parentPort.postMessage({ jobId, ok: true, result });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    parentPort.postMessage({
      jobId,
      ok: false,
      error: {
        name: err.name,
        message: err.message,
        // Forward the stack so failures in load handlers (regex
        // backtracking, generator recursion, etc.) point at the
        // right line instead of vanishing into "too much
        // recursion" with no context.
        stack: err.stack || null,
      },
    });
  }
});
