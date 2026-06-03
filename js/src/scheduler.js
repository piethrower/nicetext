// Generic pure-ESM DAG executor. Takes a list of jobs with
// dependency edges, calls `onJobReady(job)` for each ready job
// (caller decides whether to dispatch to a worker pool or run
// in-process), respects a concurrency cap, threads an AbortSignal
// through, and emits progress events.
//
// Originally written for Eve's multi-worker arc; hoisted out of
// js/src/eve/ once Build and Conceal/Reveal started using the same
// shape (one scheduler, one progress vocabulary, no per-feature
// orchestration code).
//
// No I/O, no `new Worker`, no fetch. Callers own the worker
// boundary: Eve's supervisor wires onJobReady to its compute pool;
// Build / Conceal / Reveal wire it to their own pools or to
// in-thread async functions (e.g., the SAB-creating primitives that
// stay in the calling thread by design).
//
// Browser-safe ESM, zero deps.

// runScheduler({ jobs, onJobReady, concurrency, signal, onProgress })
//
//   jobs        Array<{ id: string, kind?: string, payload?: any,
//                       deps?: string[] }>
//               Job id must be unique. Deps reference other job ids.
//               Cycle detection runs once at the start; a cyclic
//               DAG throws synchronously before any dispatch.
//
//   onJobReady  (job) => Promise<result>
//               Caller's dispatcher. Resolves with whatever result
//               value the caller wants stored for that job id;
//               rejects to fail the run.
//
//   concurrency Maximum onJobReady calls in flight at once.
//               Default Infinity. Use Infinity for unbounded; use a
//               smaller number when a job class needs tighter
//               parallelism than the pool default.
//
//   signal      Optional AbortSignal. When it aborts: no new jobs
//               start: in-flight jobs continue (their results are
//               dropped): and the returned promise rejects with
//               'aborted'.
//
//   onProgress  Optional (event) => void. Event shapes:
//                 { kind: 'job-start',   jobId, jobKind, running, pending }
//                 { kind: 'job-done',    jobId, jobKind, running, pending }
//                 { kind: 'job-failed',  jobId, jobKind, error }
//                 { kind: 'cancelled' }
//                 { kind: 'complete',    totalJobs }
//               Thrown by onProgress are swallowed so a broken UI
//               handler can't poison the run.
//
// Returns a Promise resolving to Map<jobId, result> on success.
// Rejects with the underlying error on failure or with an
// abort-style Error on cancellation.
export function runScheduler(opts) {
  // Validate synchronously so programmer errors (cycles, duplicate
  // ids, unknown deps) throw before any async work starts. The
  // returned Promise then handles only runtime concerns
  // (cancellation, job failure).
  const validated = validateAndIndex(opts);
  return dispatch(validated);
}

function validateAndIndex({
  jobs,
  onJobReady,
  concurrency = Infinity,
  signal = null,
  onProgress = null,
}) {
  if (!Array.isArray(jobs)) {
    throw new TypeError('runScheduler: jobs must be an array');
  }
  if (typeof onJobReady !== 'function') {
    throw new TypeError('runScheduler: onJobReady must be a function');
  }
  if (typeof concurrency !== 'number' || concurrency < 1) {
    throw new TypeError('runScheduler: concurrency must be a positive number');
  }

  const byId = new Map();
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || job.id.length === 0) {
      throw new TypeError('runScheduler: every job needs a non-empty string id');
    }
    if (byId.has(job.id)) {
      throw new Error(`runScheduler: duplicate job id "${job.id}"`);
    }
    byId.set(job.id, job);
  }
  for (const job of jobs) {
    for (const d of job.deps || []) {
      if (!byId.has(d)) {
        throw new Error(`runScheduler: job "${job.id}" depends on unknown id "${d}"`);
      }
    }
  }
  detectCycle(jobs);

  const dependents = new Map();
  for (const job of jobs) dependents.set(job.id, []);
  for (const job of jobs) {
    for (const d of job.deps || []) dependents.get(d).push(job.id);
  }

  return { jobs, byId, dependents, onJobReady, concurrency, signal, onProgress };
}

async function dispatch({
  jobs, byId, dependents, onJobReady, concurrency, signal, onProgress,
}) {

  // Already aborted? Bail early.
  if (signal && signal.aborted) {
    throw makeAbortError();
  }

  // Empty job list: emit complete, return empty map.
  if (jobs.length === 0) {
    emitProgress(onProgress, { kind: 'complete', totalJobs: 0 });
    return new Map();
  }

  const results = new Map();
  const pending = new Set(jobs.map(j => j.id));    // not yet started
  const running = new Set();                       // onJobReady in flight
  const remainingDeps = new Map();                 // jobId -> count of unmet deps
  for (const job of jobs) {
    remainingDeps.set(job.id, (job.deps || []).length);
  }

  let cancelled = false;
  let failure = null;

  // Wake-promise pattern: dispatch loop awaits this, completion
  // handlers (and abort) resolve it to drive the next pass.
  let wakeResolve = null;
  let wakePromise = new Promise(r => { wakeResolve = r; });
  function wake() {
    if (wakeResolve) {
      const r = wakeResolve;
      wakeResolve = null;
      r();
    }
  }

  let onSignalAbort = null;
  if (signal) {
    onSignalAbort = () => { cancelled = true; wake(); };
    signal.addEventListener('abort', onSignalAbort);
  }

  function readyJobIds() {
    const out = [];
    for (const id of pending) {
      if (remainingDeps.get(id) === 0) out.push(id);
    }
    return out;
  }

  function dispatchOne(jobId) {
    const job = byId.get(jobId);
    pending.delete(jobId);
    running.add(jobId);
    emitProgress(onProgress, {
      kind: 'job-start',
      jobId,
      jobKind: job.kind ?? null,
      running: running.size,
      pending: pending.size,
    });
    Promise.resolve()
      .then(() => onJobReady(job))
      .then((result) => {
        running.delete(jobId);
        if (cancelled) { wake(); return; }
        results.set(jobId, result);
        // Decrement dependents.
        for (const depId of dependents.get(jobId)) {
          remainingDeps.set(depId, remainingDeps.get(depId) - 1);
        }
        emitProgress(onProgress, {
          kind: 'job-done',
          jobId,
          jobKind: job.kind ?? null,
          running: running.size,
          pending: pending.size,
        });
        wake();
      })
      .catch((err) => {
        running.delete(jobId);
        if (cancelled) { wake(); return; }
        failure = err instanceof Error ? err : new Error(String(err));
        emitProgress(onProgress, {
          kind: 'job-failed',
          jobId,
          jobKind: job.kind ?? null,
          error: failure,
        });
        // Stop dispatching new work and let in-flight drain.
        cancelled = true;
        wake();
      });
  }

  try {
    // Main dispatch loop. Each pass: fill slots up to the cap with
    // ready jobs, then await a wake (job completion or abort).
    // Exits when pending is empty or cancelled and running is empty.
    while (pending.size > 0 && !cancelled) {
      const slots = concurrency - running.size;
      if (slots > 0) {
        const ready = readyJobIds().slice(0, slots);
        for (const id of ready) dispatchOne(id);
      }
      if (pending.size === 0) break;
      // No more pending; just await drain. Otherwise wait for a
      // job to complete (or abort) before re-checking eligibility.
      await wakePromise;
      wakePromise = new Promise(r => { wakeResolve = r; });
    }
    // Drain any in-flight jobs (their results may still arrive
    // after cancellation; we ignore them but wait so we don't leave
    // dangling promises behind).
    while (running.size > 0) {
      await wakePromise;
      wakePromise = new Promise(r => { wakeResolve = r; });
    }
  } finally {
    if (signal && onSignalAbort) {
      signal.removeEventListener('abort', onSignalAbort);
    }
  }

  if (failure) throw failure;
  if (cancelled) {
    emitProgress(onProgress, { kind: 'cancelled' });
    throw makeAbortError();
  }
  emitProgress(onProgress, { kind: 'complete', totalJobs: results.size });
  return results;
}

function detectCycle(jobs) {
  const indegree = new Map();
  for (const job of jobs) indegree.set(job.id, (job.deps || []).length);
  const dependents = new Map();
  for (const job of jobs) dependents.set(job.id, []);
  for (const job of jobs) {
    for (const d of job.deps || []) dependents.get(d).push(job.id);
  }
  const queue = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited++;
    for (const dependentId of dependents.get(id)) {
      indegree.set(dependentId, indegree.get(dependentId) - 1);
      if (indegree.get(dependentId) === 0) queue.push(dependentId);
    }
  }
  if (visited < jobs.length) {
    throw new Error('runScheduler: cycle detected in job DAG');
  }
}

function emitProgress(onProgress, event) {
  if (!onProgress) return;
  try { onProgress(event); } catch {}
}

function makeAbortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
