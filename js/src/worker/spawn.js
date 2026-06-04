// Cross-runtime worker spawner. Browser-safe ESM. Returns a worker
// object with a unified browser-shaped API:
//
//   const w = await createWorker(new URL('./my-worker.js', import.meta.url));
//   w.onmessage = ({ data }) => { ... };
//   w.onerror   = (err) => { ... };
//   w.postMessage(msg, transferList?);
//   await w.terminate();
//
// In a browser, wraps a native module Worker (Worker with {type:'module'}).
// In Node ≥18, wraps node:worker_threads.Worker. The wrapper normalizes
// the parent-side surface so engine code never has to branch on host.
//
// As Node grows native Web Worker support, the Node branch quietly
// becomes a no-op: the typeof Worker check would resolve true in Node
// too, and the dynamic import of node:worker_threads never runs.

const HAS_NATIVE_WORKER = typeof Worker !== 'undefined';

// Pages with `require-trusted-types-for 'script'` in their CSP block
// `new Worker(url)` unless `url` is a TrustedScriptURL. Register a
// passthrough policy on first use (lazy, cached) so engine code can
// pass plain URL objects. The shim is no-op in environments without
// TrustedTypes (Node, browsers without TT support).
let workerUrlPolicy;
function trustWorkerUrl(url) {
  if (typeof trustedTypes === 'undefined' || !trustedTypes.createPolicy) return url;
  if (workerUrlPolicy === undefined) {
    try {
      workerUrlPolicy = trustedTypes.createPolicy('engine-worker-url', {
        createScriptURL: (input) => input,
      });
    } catch {
      workerUrlPolicy = null;
    }
  }
  if (!workerUrlPolicy) return url;
  return workerUrlPolicy.createScriptURL(url.toString());
}

// Hard cap on how long we'll wait for a freshly-spawned worker to
// signal {type:'ready'}. Long enough to absorb cold-start + module
// graph fetch over a slow network (the SW-mediated case can spend a
// few seconds on first load); short enough to surface a real hang
// rather than wedging the caller forever.
const WORKER_READY_TIMEOUT_MS = 15000;

// Wait for the spawned worker to post {type:'ready'} as its first
// message. Every worker entry file MUST do this as the last statement
// after its top-level imports/init, so the parent can be sure the
// worker is fully wired before postMessage'ing real work.
//
// Why this exists: on iOS Safari, when multiple workers spawn
// concurrently and each pulls a deep module graph through the Service
// Worker, one or more of them silently stall. Forcing each worker to
// announce ready before createWorker resolves serializes module load
// across concurrent spawns and eliminates the race.
function awaitWorkerReady(w, isBrowser) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not signal ready within ${WORKER_READY_TIMEOUT_MS}ms`));
    }, WORKER_READY_TIMEOUT_MS);
    let onMsg, onErr, cleanup;
    if (isBrowser) {
      onMsg = (e) => {
        if (e && e.data && e.data.type === 'ready') {
          cleanup();
          resolve();
        }
      };
      onErr = (e) => {
        cleanup();
        reject(e && e.error ? e.error : new Error('worker error before ready'));
      };
      cleanup = () => {
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
    } else {
      onMsg = (data) => {
        if (data && data.type === 'ready') {
          cleanup();
          resolve();
        }
      };
      onErr = (err) => {
        cleanup();
        reject(err || new Error('worker error before ready'));
      };
      cleanup = () => {
        clearTimeout(timer);
        w.off('message', onMsg);
        w.off('error', onErr);
      };
      w.on('message', onMsg);
      w.on('error', onErr);
    }
  });
}

export async function createWorker(url) {
  if (HAS_NATIVE_WORKER) {
    const w = new Worker(trustWorkerUrl(url), { type: 'module' });
    await awaitWorkerReady(w, true);
    return wrapBrowserWorker(w);
  }
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const w = new NodeWorker(url);
  await awaitWorkerReady(w, false);
  return wrapNodeWorker(w);
}

function wrapBrowserWorker(w) {
  return {
    postMessage(msg, transferList) {
      w.postMessage(msg, transferList);
    },
    set onmessage(fn) {
      w.onmessage = fn ? (e) => fn({ data: e.data }) : null;
    },
    set onerror(fn) {
      w.onerror = fn ? (e) => fn(e.error || e) : null;
    },
    // Additive message listener. Returns an unsubscribe fn.
    // Multiple listeners coexist; onmessage assignment still works
    // (it sets a separate dispatcher in the browser event model).
    addMessageListener(fn) {
      const wrapped = (e) => fn({ data: e.data });
      w.addEventListener('message', wrapped);
      return () => w.removeEventListener('message', wrapped);
    },
    // ref/unref are no-ops in the browser: DOM Workers don't have
    // them and pages aren't process-alive things. Same method shape
    // as wrapNodeWorker so pool.js doesn't need a feature check.
    ref() {},
    unref() {},
    terminate() { return w.terminate(); },
  };
}

function wrapNodeWorker(w) {
  // Node-only lifetime hooks. The wrapper exposes `ref()` / `unref()`
  // that the caller (pool.js) toggles around each in-flight job:
  //   busy   → ref()    (worker handle counts toward loop liveness;
  //                      the parent awaits its reply)
  //   idle   → unref()  (worker doesn't keep the process alive)
  // This is what lets a Node script that uses the pool exit cleanly
  // once all dispatched work resolves and no other handles are
  // pending. Browser DOM Workers don't have unref (pages aren't
  // process-alive things), so wrapBrowserWorker exposes the same
  // method shape as no-ops. ONE PATH at the pool layer.
  //
  // Critical detail (Node-specific): attaching a `'message'` event
  // listener via `w.on(...)` RE-REFS the worker handle (the listener
  // is an active I/O expectation libuv counts). The setters below
  // therefore call `w.unref()` AFTER each attachment so the idle
  // state is preserved across the wrapper's lifetime; ref() is
  // called explicitly only when the pool marks a slot busy.
  w.unref();
  let messageHandler = null;
  let errorHandler = null;
  return {
    postMessage(msg, transferList) {
      w.postMessage(msg, transferList);
    },
    set onmessage(fn) {
      if (messageHandler) w.off('message', messageHandler);
      if (fn) {
        // Node's 'message' event delivers the message directly; wrap to
        // a browser-shaped {data} envelope for callers.
        messageHandler = (data) => fn({ data });
        w.on('message', messageHandler);
      } else {
        messageHandler = null;
      }
      w.unref();
    },
    set onerror(fn) {
      if (errorHandler) w.off('error', errorHandler);
      if (fn) {
        errorHandler = (err) => fn(err);
        w.on('error', errorHandler);
      } else {
        errorHandler = null;
      }
      w.unref();
    },
    addMessageListener(fn) {
      const wrapped = (data) => fn({ data });
      w.on('message', wrapped);
      w.unref();
      return () => w.off('message', wrapped);
    },
    ref() { w.ref(); },
    unref() { w.unref(); },
    terminate() { return w.terminate(); },
  };
}

// Pool sizing default. navigator.hardwareConcurrency in browsers and
// modern Node (>= 19); falls back to 1 for older Node or a sandbox.
export function defaultPoolSize() {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.max(1, navigator.hardwareConcurrency);
  }
  return 1;
}
