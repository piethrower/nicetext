// Resource-loader client. Worker-side proxy for the main-thread
// resource-loader. Workers (Eve, build, future analyzers) import
// this module and call
// loadResource(idOrPath, resourceCategory, { fixture, onProgress });
// the request forwards to the parent realm via postMessage, the
// result returns as a postMessage. The main thread sets itself up to
// handle these via `attachLoaderProxy(worker)` from
// js/src/resource-loader.js.
//
// Protocol envelope shape:
//   out  { action: 'loadRequest',  requestId, idOrPath,
//          resourceCategory, fixture }
//   in   { action: 'loadProgress', requestId, label }
//   in   { action: 'loadResult',   requestId, result }
//   in   { action: 'loadError',    requestId, error }
//
// `action` (not `type`) names the message verb so a JS object-literal
// shorthand on a same-named local variable cannot silently shadow
// the field, see commit history for the bug this discipline
// prevents. The carried resource category is named `resourceCategory`
// for the same reason: `type` in nicetext canonically means the
// per-word part-of-speech / categorization column in a twlist entry,
// and overloading it for "SAB resource category" hid the protocol
// from the proxy for two commits.
//
// Cross-runtime: uses the parent-port shim so the same code runs in
// browser DedicatedWorkerGlobalScope and node worker_threads.
//
// Browser-safe and node-safe ESM.

import { parentPort } from './worker/parent-port.js';

let nextId = 1;
const pending = new Map();   // requestId -> { resolve, reject, onProgress }

if (typeof parentPort.addMessageListener === 'function') {
  parentPort.addMessageListener((data) => {
    if (!data || typeof data !== 'object') return;
    const { action, requestId } = data;
    if (action !== 'loadResult' && action !== 'loadProgress' && action !== 'loadError') return;
    const entry = pending.get(requestId);
    if (!entry) return;
    if (action === 'loadProgress') {
      if (entry.onProgress) {
        try { entry.onProgress(data.label); } catch {}
      }
    } else if (action === 'loadResult') {
      pending.delete(requestId);
      entry.resolve(data.result);
    } else if (action === 'loadError') {
      pending.delete(requestId);
      entry.reject(new Error(data.error || 'resource-loader-client: load failed'));
    }
  });
}

// loadResource(idOrPath, resourceCategory, { fixture = true, onProgress } = {})
//   -> Promise<SharedArrayBuffer>
//
// Mirrors the main-thread loadResource shape; the worker just
// forwards (idOrPath, resourceCategory, fixture) to main, which
// resolves and caches.
export function loadResource(idOrPath, resourceCategory, opts = {}) {
  const { fixture = true, onProgress = null } = opts;
  if (typeof parentPort.addMessageListener !== 'function') {
    return Promise.reject(new Error(
      'resource-loader-client: parent-port shim missing addMessageListener; ' +
      'this worker realm cannot proxy load requests',
    ));
  }
  const requestId = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress });
    parentPort.postMessage({
      action: 'loadRequest',
      requestId,
      idOrPath,
      resourceCategory,
      fixture,
    });
  });
}
