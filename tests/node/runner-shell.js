// Shared scaffolding for the two long-running browser programs:
// stress-test.html and test-suite.html. Both spawn a module-typed
// Web Worker, exchange `{ type: 'run' | 'abort', … }` / `{ type:
// 'event', event: { kind, … } }` messages, and repaint a live state
// at ~1 Hz instead of per-event. The page-specific bits (event
// vocabulary, render output, log-list shape) live in the page; this
// module owns the boilerplate so the two pages can't drift.
//
// Browser-side only. Not imported by Node tests or CLIs.

/**
 * Spawn a module-typed Worker and wire its message + error channels
 * into page-supplied handlers.
 *
 * Envelope contract:
 *   worker → main : { type: 'event', event: { kind, … } }
 *   main   → worker: { type: 'run', … } | { type: 'abort' } | { type: … }
 *
 * The shell unwraps the envelope and calls onEvent(event). Any
 * non-envelope message passes through onMessage(raw) instead so the
 * caller can extend the protocol without forking the shell.
 *
 * @param {object} opts
 * @param {URL|string} opts.workerUrl
 * @param {(event: object) => void} [opts.onEvent]
 * @param {(raw: any) => void}      [opts.onMessage]
 * @param {(err: ErrorEvent) => void} [opts.onError]
 * @param {() => void}              [opts.onTerminate]
 * @returns {{ post(msg: any): void, abort(): void, terminate(): void }}
 */
export function mountRunner({ workerUrl, onEvent, onMessage, onError, onTerminate }) {
  const worker = new Worker(workerUrl, { type: 'module' });
  let terminated = false;
  worker.addEventListener('message', (e) => {
    const env = e.data;
    if (env && env.type === 'event' && env.event) {
      onEvent?.(env.event);
    } else if (onMessage) {
      onMessage(env);
    }
  });
  worker.addEventListener('error', (e) => { onError?.(e); });
  function terminate() {
    if (terminated) return;
    terminated = true;
    try { worker.terminate(); } catch {}
    onTerminate?.();
  }
  return {
    post(msg) { if (!terminated) worker.postMessage(msg); },
    abort()   { if (!terminated) worker.postMessage({ type: 'abort' }); },
    terminate,
    // Resource-loader proxy surface. attachLoaderProxy(runner) wires
    // the worker's loadResource calls to the main-thread loader; it
    // needs raw postMessage plus an additive message listener (matching
    // the spawn.js wrapper shape). The loadRequest/loadResult envelopes
    // use `action`, not `type`, so they bypass the `type:'event'`
    // dispatch above and never reach onEvent/onMessage.
    postMessage(msg) { if (!terminated) worker.postMessage(msg); },
    addMessageListener(fn) {
      const wrapped = (e) => fn({ data: e.data });
      worker.addEventListener('message', wrapped);
      return () => worker.removeEventListener('message', wrapped);
    },
  };
}

/**
 * Start a repaint loop that calls renderFn immediately and then on a
 * fixed interval. Returns a stop function. Default cadence is 1 Hz to
 * match the stress test's "render once per second" budget: fast
 * enough to feel live, slow enough to never thrash.
 *
 * @param {() => void} renderFn
 * @param {number} [intervalMs=1000]
 * @returns {() => void} stop function
 */
export function startTicker(renderFn, intervalMs = 1000) {
  renderFn();
  const t = setInterval(renderFn, intervalMs);
  return () => clearInterval(t);
}
