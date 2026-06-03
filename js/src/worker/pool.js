// Worker pool. Thin wrapper over js/src/worker/spawn.js that hands
// out idle workers, routes one in-flight request per worker at a
// time, and serializes job dispatch as a Promise the caller can
// await. Used by Eve, the shared resource-loader, the aug pipeline,
// and any future caller that wants the same dispatch contract.
//
// The scheduler (js/src/scheduler.js) caps concurrent onJobReady
// calls at the pool size, so the pool never needs an internal
// queue: every dispatch finds a free worker.
//
// Browser-safe ESM. Cross-runtime via createWorker.

import { createWorker, defaultPoolSize } from '../worker/spawn.js';

// createPool({ workerUrl, size?, onEvent? }) -> { dispatch, terminate, size }
//
//   dispatch(job)  Sends { jobId, kind, payload } to an idle
//                  worker; resolves to the worker's `result` field,
//                  rejects with a rehydrated Error if the worker
//                  posted `ok:false`. jobId is auto-assigned per
//                  call so multiple in-flight dispatches stay
//                  routable.
//
//   terminate()    Posts a {type:'shutdown'} to each worker then
//                  awaits .terminate(). Idempotent; safe to call
//                  in a finally.
//
//   size           Actual pool size used (defaultPoolSize() - 1
//                  unless size override was passed, clamped to
//                  >= 1).
//
//   onEvent        Optional progress callback. Emits:
//                  { kind: 'pool-init',    size }
//                  { kind: 'worker-busy',  workerId, jobKind, jobId }
//                  { kind: 'worker-idle',  workerId, jobKind, jobId }
//                  Caller forwards these to whatever UI surface
//                  renders per-worker status (the page eve-log's
//                  worker-status block, the busy modal's mirrored
//                  block).
export async function createPool({ workerUrl, size, onEvent = null }) {
  const resolvedSize = Math.max(1, size ?? (defaultPoolSize() - 1));
  const emit = (e) => { if (onEvent) { try { onEvent(e); } catch {} } };
  const workers = [];
  for (let i = 0; i < resolvedSize; i++) {
    workers.push({
      id: i,
      w: await createWorker(workerUrl),
      busy: false,
      pending: null,        // { jobId, resolve, reject } when busy
    });
  }
  // Wire each worker's onmessage to look up its pending dispatch
  // by jobId and resolve/reject. One in-flight per worker keeps
  // the protocol simple; the scheduler is the gate. Emit a
  // `worker-idle` event on every completion so the UI status
  // block can clear the row.
  for (const slot of workers) {
    slot.w.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return;
      const { jobId } = data;
      const p = slot.pending;
      if (!p || p.jobId !== jobId) return;  // stale or unmatched; ignore
      // Intermediate progress: the worker called progress(label)
      // mid-job. Forward as worker-progress AND invoke the per-
      // dispatch onProgress callback if the caller supplied one;
      // do NOT resolve.
      if (data.progress !== undefined) {
        const label = data.progress && data.progress.label;
        emit({
          kind: 'worker-progress',
          workerId: slot.id,
          jobKind: p.jobKind,
          jobId,
          label,
        });
        if (p.onProgress) {
          try { p.onProgress(label); } catch {}
        }
        return;
      }
      // Final reply: resolve / reject + worker-idle.
      const { ok, result, error } = data;
      const jobKind = p.jobKind;
      slot.pending = null;
      slot.busy = false;
      // Match the ref() in runOn(): unref now that the slot is idle,
      // so the event loop is free to exit between dispatches if no
      // other work is pending. No-op in browser.
      slot.w.unref();
      emit({ kind: 'worker-idle', workerId: slot.id, jobKind, jobId });
      if (ok) p.resolve(result);
      else {
        const e = new Error(error && error.message ? error.message : 'worker error');
        if (error && error.name) e.name = error.name;
        if (error && error.stack) {
          // Preserve the worker-side stack so the page log shows
          // where the failure happened. Prepending keeps the
          // parent-side rethrow frames around for context.
          e.stack = `${e.stack}\n--- worker-side stack ---\n${error.stack}`;
        }
        p.reject(e);
      }
      // After a slot frees, see if any queued dispatch was waiting
      // for a worker; if so, hand it the freshly-idle slot.
      drainQueue();
    };
    slot.w.onerror = (err) => {
      const p = slot.pending;
      const jobKind = p ? p.jobKind : null;
      slot.pending = null;
      slot.busy = false;
      slot.w.unref();
      emit({ kind: 'worker-idle', workerId: slot.id, jobKind, jobId: p ? p.jobId : null });
      if (p) p.reject(err);
      drainQueue();
    };
  }
  // Announce pool composition once everything's wired.
  emit({ kind: 'pool-init', size: resolvedSize });
  // Round-robin pointer for fair dispatch when several workers are
  // idle. Picks the lowest-index idle worker; the round-robin bias
  // is cheap and avoids the same worker always taking the first
  // job in a slot-refill burst.
  let nextProbe = 0;
  let jobCounter = 0;

  function pickIdle() {
    for (let i = 0; i < workers.length; i++) {
      const idx = (nextProbe + i) % workers.length;
      if (!workers[idx].busy) {
        nextProbe = (idx + 1) % workers.length;
        return workers[idx];
      }
    }
    return null;
  }

  // FIFO queue of dispatch attempts that arrived while every slot
  // was busy. Each entry holds the job + onProgress + the original
  // resolve/reject so we hand it the same Promise the caller is
  // already awaiting.
  const waitQueue = [];

  function drainQueue() {
    while (waitQueue.length > 0) {
      const slot = pickIdle();
      if (!slot) return;
      const next = waitQueue.shift();
      runOn(slot, next.job, next.onProgress, next.resolve, next.reject);
    }
  }

  function runOn(slot, job, onProgress, resolve, reject) {
    slot.busy = true;
    // Re-ref the worker for the lifetime of this job so the event
    // loop knows the parent is actually awaiting a reply. Idle slots
    // stay unref'd (set in wrapNodeWorker; no-op in browser) so a
    // sequential Node script (CLI, test) can exit cleanly between
    // dispatches. The unref is restored on completion / error in the
    // worker's onmessage / onerror handlers above.
    slot.w.ref();
    const jobId = ++jobCounter;
    slot.pending = { jobId, jobKind: job.kind, resolve, reject, onProgress };
    emit({ kind: 'worker-busy', workerId: slot.id, jobKind: job.kind, jobId, label: jobLabel(job) });
    slot.w.postMessage({ jobId, kind: job.kind, payload: job.payload });
  }

  function dispatch(job, onProgress = null) {
    return new Promise((resolve, reject) => {
      const slot = pickIdle();
      if (!slot) {
        // All slots busy. Queue and wait for drainQueue to pick us up.
        waitQueue.push({ job, onProgress, resolve, reject });
        return;
      }
      runOn(slot, job, onProgress, resolve, reject);
    });
  }

  // Human-readable label per job. Pool peeks at job.payload to
  // surface the target resource (TW-list key, corpus stem, card
  // name) so the page's worker-status row reads like
  // "load-twlist: impkimmo2026-rootpos" rather than a bare kind.
  function jobLabel(job) {
    const p = job.payload || {};
    switch (job.kind) {
      case 'load-twlist': {
        const url = String(p.url || '');
        const m = /([^/]+?)\.twlist\.tsv\.gz$/.exec(url);
        return `load-twlist: ${m ? m[1] : url.split('/').pop() || ''}`;
      }
      case 'load-dict':
      case 'load-model':
      case 'load-grammar': {
        const url = String(p.url || '');
        return `${job.kind}: ${url.split('/').pop() || ''}`;
      }
      case 'load-corpus-text': {
        const url = String(p.url || '');
        return `load-corpus-text: ${url.split('/').pop() || ''}`;
      }
      case 'corpus-vocab-check':
        return `corpus-vocab-check: ${p.corpusName || ''}`;
      case 'monotyped-model-check-card':
        return `monotyped-model-check-card: ${(p.card && p.card.name) || ''}`;
      case 'suspected-token-scan':
      case 'is-nicetext':
      case 'vocab-check':
      case 'build-suspected-monotyped-model':
      default:
        return job.kind;
    }
  }

  let terminated = false;
  async function terminate() {
    if (terminated) return;
    terminated = true;
    // Reject any in-flight dispatches BEFORE killing the worker, so
    // the caller's `await pool.dispatch(...)` exits with a proper
    // AbortError instead of hanging forever (the terminated worker
    // never sends its reply). Without this, mid-job cancellation
    // (Eve's "Cancel" button → AbortSignal → pool.terminate()) would
    // leave the scheduler's drain loop awaiting wakePromise that
    // nothing ever resolves. The resource-loader cache's catch
    // handler deletes the entry on rejection, so partial loads
    // self-clean. Reject + clear slot state in one pass; the
    // worker.terminate() below makes any straggler postMessage
    // unobservable anyway, but defense-in-depth keeps the slot from
    // looking busy to a (hypothetical) later dispatch.
    for (const slot of workers) {
      const p = slot.pending;
      if (p) {
        const err = new Error('aborted: pool terminated');
        err.name = 'AbortError';
        slot.pending = null;
        slot.busy = false;
        try { p.reject(err); } catch {}
      }
    }
    // Also reject anything sitting in the wait queue, same reason.
    while (waitQueue.length > 0) {
      const next = waitQueue.shift();
      const err = new Error('aborted: pool terminated');
      err.name = 'AbortError';
      try { next.reject(err); } catch {}
    }
    for (const slot of workers) {
      try { slot.w.postMessage({ type: 'shutdown' }); } catch {}
    }
    for (const slot of workers) {
      try { await slot.w.terminate(); } catch {}
    }
  }

  return { dispatch, terminate, size: resolvedSize };
}
