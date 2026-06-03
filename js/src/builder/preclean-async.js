// Main-thread wrapper around the preclean worker. Lazily spawns a
// singleton worker on first call and reuses it across calls so worker
// startup cost is paid once per page session.
//
// Usage:
//
//   import { precleanCorpusAsync } from './preclean-async.js';
//   const cleaned = await precleanCorpusAsync(text, { onProgress, signal });
//
// Calls are serialized: if a second call lands while the first is in
// flight, the second waits. This matches the UI's actual usage (one
// modal at a time, no concurrent paste + file load).
//
// onProgress fires once per chunk completion inside the worker
// (per-pass × per-chunk; ~512 KB chunks). Shape:
//   { pass, chunkIndex, chunkCount, chars }
// Chunking added 2026-05-18 (audit Findings 4 + 5) to keep the modal
// ≥1 Hz on 200 MB corpora and to avoid Firefox's Irregexp recursion
// limit blowing up rule 5 (confusables) on 30+ MB inputs.
//
// AbortSignal: aborting terminates the worker outright (single-threaded
// regex passes can't be interrupted otherwise). A fresh worker spawns
// on the next call.

import { createWorker } from '../worker/spawn.js';

let workerPromise = null;
let inFlight = Promise.resolve();
let nextRequestId = 1;

function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = createWorker(new URL('../worker/preclean-worker.js', import.meta.url));
  return workerPromise;
}

export async function precleanCorpusAsync(text, opts = {}) {
  const { onProgress, signal } = opts;
  // Serialize: chain this call onto the previous in-flight promise
  // so messages don't interleave. The chain swallows prior errors
  // (each call gets its own try/catch).
  const myTurn = inFlight.catch(() => {});
  inFlight = myTurn.then(() => runOne(text, onProgress, signal));
  return inFlight;
}

function makeAbortError() {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('aborted', 'AbortError');
  }
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

async function runOne(text, onProgress, signal) {
  if (signal?.aborted) throw makeAbortError();
  const worker = await getWorker();
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    let abortHandler = null;
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      // Match the ref() below: this worker no longer keeps the event
      // loop alive now that the in-flight request is settled. No-op
      // in browser (DOM Workers don't have ref/unref).
      worker.unref();
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };
    const onMessage = ({ data }) => {
      if (!data || data.requestId !== requestId) return;
      if (data.type === 'progress') {
        if (onProgress) {
          try { onProgress(data.info); } catch {}
        }
        return;
      }
      if (data.type === 'result') {
        cleanup();
        resolve(data.text);
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.error || 'preclean worker error'));
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    worker.onmessage = onMessage;
    worker.onerror = onError;
    if (signal) {
      abortHandler = () => {
        cleanup();
        // Rule passes are synchronous regex .replace() calls that can't
        // be interrupted mid-execution; terminate the worker outright.
        // The next preclean call spawns a fresh one.
        try { worker.terminate(); } catch {}
        workerPromise = null;
        reject(makeAbortError());
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    // Re-ref the worker for the lifetime of this in-flight request:
    // the parent IS awaiting a reply, so the event loop must stay
    // alive. cleanup() unrefs on completion or error. No-op in
    // browser. Symmetric with how pool.js manages ref/unref around
    // each runOn cycle.
    worker.ref();
    worker.postMessage({ type: 'preclean', requestId, text });
  });
}
