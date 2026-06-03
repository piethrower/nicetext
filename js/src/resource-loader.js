// resource-loader.js: main-thread resource loader. Single source
// of truth for the page session's resource caching: fetch + parse
// + pack happens once per (resourceCategory, id) pair regardless of
// which realm (main, Eve worker, build worker) initiated the load.
//
// API:
//
//   loadResource(idOrPath, resourceCategory, { fixture = true,
//                                              onProgress } = {})
//     -> Promise<SharedArrayBuffer>
//
//     idOrPath          bare prefix (fixture mode, e.g. 'aesop-1'),
//                       'pageLifeSpan:<id>' (in-RAM artifact registered
//                       by the session worker), or a full URL / path
//                       (fixture:false mode).
//     resourceCategory  one of SAB_RESOURCE_CATEGORIES (the six SAB
//                       conversion targets: twlist, wlist, dict,
//                       model, freq, emoji-cldr), or a pseudo-
//                       category the worker handles inline
//                       (raw-bytes, grammar, corpus-precompute).
//                       The name is `resourceCategory` (not `type`)
//                       because `type` in nicetext canonically means
//                       the per-word part-of-speech / categorization
//                       column in a twlist entry, a completely
//                       different concept. Confusing the two is the
//                       bug class this naming discipline prevents.
//     fixture           default true. When true, idOrPath is treated
//                       as a bare prefix and composed against
//                       /fixtures/. When false, idOrPath is used as
//                       the URL/path exactly.
//     onProgress        (label) => void callback. Receives progress
//                       labels from the resource-worker as the load
//                       runs.
//
//   attachLoaderProxy(worker) -> unsubscribe-fn
//     Wires a satellite worker so its `loadRequest` messages route
//     through this loader. Worker-side API lives in
//     js/src/resource-loader-client.js. Protocol envelopes use an
//     `action` field for the message verb (loadRequest /
//     loadProgress / loadResult / loadError) to keep the verb
//     namespace separate from any `resourceCategory` carried inside
//     the same message.
//
//   _clearCache()      -> void   (test/diagnostic)
//   _cacheSize()       -> number (test/diagnostic)
//   _registerResource(idOrPath, resourceCategory, sabOrPromise) -> void
//     Pre-populate the cache. The session worker uses this with the
//     'pageLifeSpan:<byosId>' id form to register an in-RAM dict /
//     model so subsequent loadResource calls hit cache without
//     network or fixture lookup.
//
// Resolution policy:
//   1. Cache check FIRST. Key shape:
//      `${resourceCategory}::${canonicalId}`. Hit (resolved or
//      in-flight) short-circuits everything.
//   2. pageLifeSpan: prefix, cache-only. Miss is fatal (no
//      fixture lookup, no network).
//   3. fixture: true, compose SAB URL
//      /fixtures/<id>.<resourceCategory>.sab.gz, try fetch via
//      worker. On HTTP 404 (or equivalent), compose native URL
//      /fixtures/<id>.<native-ext>, fetch and sab.pack() the result.
//   4. fixture: false, caller controls the URL/path. Extension
//      decides: .sab.gz → fetch + gunzip + wrap; other → fetch +
//      sab.pack() with the given resourceCategory. Special pseudo-
//      categories (raw-bytes, grammar, corpus-precompute) keep their
//      own inline worker handlers and don't go through sab.pack.
//
// /fixtures/ is auto-resolved from one anchor:
//   - Browser: origin-relative /fixtures/ (page served at root).
//   - Node: a fixed offset from this module's own import.meta.url.
// Caller depth (js/x.js vs js/src/eve/x.js) is irrelevant,
// every caller passes the same (id, resourceCategory) pair and hits
// one canonical absolute URL.

import { createPool } from './worker/pool.js';
import { SAB_RESOURCE_CATEGORIES, NATIVE_EXT } from './sab.js';

const RESOURCE_WORKER_URL = new URL('./worker/resource-worker.js', import.meta.url);

// Anchor for /fixtures/ resolution: always relative to THIS module's
// URL (js/src/resource-loader.js → repo root → fixtures/). Works in
// node, in the browser at any base path (including project Pages under
// /<repo>/), and inside workers, since import.meta.url is per-module.
// Resolving against location.origin instead would drop the base path
// and 404 on project Pages. Callers never spell the directory.
const FIXTURES_BASE = new URL('../../fixtures/', import.meta.url).href;

// Cache entry shape:
//   { promise, lastLabel, subscribers: Set<onProgress fn> }
// Key shape: `${resourceCategory}::${canonicalId}` (see canonicalize()).
const cache = new Map();

const PAGELIFESPAN = 'pageLifeSpan:';

// canonicalize(idOrPath, resourceCategory, fixture) -> { key, sabURL,
//   nativeURL, isPageLifeSpan }
//
// Computes the single canonical cache key for a request, plus the
// concrete SAB / native URLs the worker will fetch on cache miss.
function canonicalize(idOrPath, resourceCategory, fixture) {
  if (typeof idOrPath === 'string' && idOrPath.startsWith(PAGELIFESPAN)) {
    return {
      key: `${resourceCategory}::${idOrPath}`,
      sabURL: null, nativeURL: null,
      isPageLifeSpan: true,
    };
  }
  if (fixture) {
    // Bare prefix. SAB candidate =
    //   <FIXTURES_BASE><id>.<resourceCategory>.sab.gz.
    // Native candidate = <FIXTURES_BASE><id><native-ext>.
    const sabURL = `${FIXTURES_BASE}${idOrPath}.${resourceCategory}.sab.gz`;
    const nativeURL = NATIVE_EXT[resourceCategory]
      ? `${FIXTURES_BASE}${idOrPath}${NATIVE_EXT[resourceCategory]}`
      : null;
    return {
      key: `${resourceCategory}::${sabURL}`,
      sabURL, nativeURL,
      isPageLifeSpan: false,
    };
  }
  // fixture:false, caller-provided URL/path. Absolutize for cache
  // canonicalization (so the same logical resource doesn't get two
  // entries from a relative vs absolute spelling).
  const abs = absolutize(idOrPath);
  // If the path itself ends in .sab.gz, it IS the SAB form. If it
  // ends in the native extension for this resourceCategory, it's
  // native. The worker decides what to do; we just hand it one URL.
  return {
    key: `${resourceCategory}::${abs}`,
    sabURL: abs.endsWith('.sab.gz') ? abs : null,
    nativeURL: abs.endsWith('.sab.gz') ? null : abs,
    isPageLifeSpan: false,
  };
}

function absolutize(s) {
  if (typeof s !== 'string') return String(s);
  if (/^\w+:/.test(s)) return s; // already absolute (http:, file:, blob:, ...)
  if (typeof location !== 'undefined' && location.href) {
    return new URL(s, location.href).href;
  }
  return s; // node: caller must pass absolute
}

// Lazy-init shared worker pool. Lives for the page session.
let poolPromise = null;
function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = createPool({ workerUrl: RESOURCE_WORKER_URL });
  return poolPromise;
}

// loadResource: public entry. Idempotent across calls with the same
// (id, resourceCategory). Concurrent calls with the same key share
// one in-flight dispatch (promise-cache pattern).
export async function loadResource(idOrPath, resourceCategory, opts = {}) {
  const { fixture = true, onProgress = null } = opts;
  if (typeof resourceCategory !== 'string') {
    throw new TypeError(
      `loadResource: resourceCategory must be a string; got ${typeof resourceCategory}`,
    );
  }
  const { key, sabURL, nativeURL, isPageLifeSpan } =
    canonicalize(idOrPath, resourceCategory, fixture);

  // 1. Cache check.
  let entry = cache.get(key);
  if (entry) {
    if (onProgress) {
      entry.subscribers.add(onProgress);
      if (entry.lastLabel) {
        try { onProgress(entry.lastLabel); } catch {}
      }
    }
    try {
      return await entry.promise;
    } finally {
      if (onProgress) entry.subscribers.delete(onProgress);
    }
  }

  // 2. pageLifeSpan: miss is fatal.
  if (isPageLifeSpan) {
    throw new Error(
      `loadResource: pageLifeSpan artifact not found in cache: ` +
      `"${idOrPath}" (resourceCategory "${resourceCategory}"). ` +
      `Did the session worker register it before the consumer asked?`,
    );
  }

  // 3. Miss path. Build the entry whose .promise is assigned
  // synchronously before any await, so a concurrent caller landing
  // in the same key attaches as a subscriber rather than starting
  // a duplicate dispatch.
  entry = {
    subscribers: new Set(onProgress ? [onProgress] : []),
    lastLabel: null,
    promise: null,
  };
  entry.promise = (async () => {
    try {
      const onLabel = (label) => {
        entry.lastLabel = label;
        for (const fn of entry.subscribers) {
          try { fn(label); } catch {}
        }
      };
      return await dispatch(resourceCategory, sabURL, nativeURL, onLabel);
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  })();
  cache.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    if (onProgress) entry.subscribers.delete(onProgress);
  }
}

// dispatch: pick the right worker job based on (resourceCategory,
// sabURL, nativeURL). For the SAB categories listed in SAB_RESOURCE_CATEGORIES,
// try SAB-first then native fallback. For pseudo-categories
// (raw-bytes, grammar, corpus-precompute) route through the existing
// per-kind handler.
async function dispatch(resourceCategory, sabURL, nativeURL, onLabel) {
  const pool = await getPool();
  // Pseudo-category routing: these don't go through sab.pack; the
  // worker has its own inline parse/pack logic for them.
  if (resourceCategory === 'raw-bytes') {
    // raw-bytes always passes a concrete URL (fixture:false caller).
    // sabURL or nativeURL, exactly one of them is set.
    const url = sabURL || nativeURL;
    return await pool.dispatch(
      { kind: 'load-raw-bytes', payload: { url } },
      onLabel,
    );
  }
  if (resourceCategory === 'grammar') {
    const url = nativeURL || sabURL;
    return await pool.dispatch(
      { kind: 'load-grammar', payload: { url } },
      onLabel,
    );
  }
  if (resourceCategory === 'corpus-precompute') {
    // corpus-precompute callers passed {vocabURL, shapesURL} via the
    // fixture:false channel under the old protocol. The canonicalize()
    // helper above doesn't model multi-URL payloads; this branch
    // remains as a guarded error pending the legacy handler's full
    // retirement (post-wlist sub-commit; no live caller).
    throw new Error(
      'loadResource: corpus-precompute should be called via the legacy ' +
      'pool.dispatch path; not wired into the (id, resourceCategory, opts) API.',
    );
  }

  // SAB-category routing. Try SAB candidate first; on 404 (or HTTP
  // error / fetch failure), fall back to native +
  // sab.pack(text, resourceCategory).
  if (!SAB_RESOURCE_CATEGORIES.includes(resourceCategory)) {
    throw new Error(
      `loadResource: unknown resourceCategory "${resourceCategory}". ` +
      `Expected one of: ${SAB_RESOURCE_CATEGORIES.join(', ')}, or a pseudo-category ` +
      `(raw-bytes, grammar, corpus-precompute).`,
    );
  }
  // SAB-first fast path: reuse the load-raw-bytes worker job (it's
  // exactly what the SAB form needs, fetch + gunzip + wrap). On 404
  // we fall through to load-native.
  try {
    if (sabURL) {
      return await pool.dispatch(
        { kind: 'load-raw-bytes', payload: { url: sabURL } },
        onLabel,
      );
    }
  } catch (err) {
    if (!is404(err)) throw err;
    // fall through to native fallback
  }
  if (nativeURL) {
    return await pool.dispatch(
      { kind: 'load-native', payload: { url: nativeURL, type: resourceCategory } },
      onLabel,
    );
  }
  throw new Error(
    `loadResource: no SAB and no native URL available for ` +
    `resourceCategory "${resourceCategory}".`,
  );
}

function is404(err) {
  const msg = err && err.message ? err.message : String(err);
  return /\b(?:HTTP 404|ENOENT|not found)\b/i.test(msg);
}

// attachLoaderProxy: route a satellite worker's loadRequest messages
// through this loader. Returns an unsubscribe function for terminate
// cleanup. Worker emits loadRequest via resource-loader-client.js.
//
// Protocol envelopes use an `action` field for the message verb
// ('loadRequest' / 'loadProgress' / 'loadResult' / 'loadError') and
// a `resourceCategory` field for the loaded resource category. The
// two are deliberately distinct field names so a JS object-literal
// shorthand can never silently shadow one with the other (the bug
// pattern that hid this protocol from the proxy for two commits;
// see commit history).
export function attachLoaderProxy(worker) {
  if (!worker || typeof worker.addMessageListener !== 'function') {
    throw new Error(
      'attachLoaderProxy: worker must expose addMessageListener (spawn.js wrapper)',
    );
  }
  return worker.addMessageListener(({ data }) => {
    if (!data || data.action !== 'loadRequest') return;
    const { requestId, idOrPath, resourceCategory, fixture } = data;
    loadResource(idOrPath, resourceCategory, {
      fixture,
      onProgress: (label) => {
        try {
          worker.postMessage({ action: 'loadProgress', requestId, label });
        } catch {}
      },
    }).then(
      (result) => {
        try {
          worker.postMessage({ action: 'loadResult', requestId, result });
        } catch {}
      },
      (err) => {
        try {
          worker.postMessage({
            action: 'loadError',
            requestId,
            error: String(err && err.message ? err.message : err),
          });
        } catch {}
      },
    );
  });
}

// Test/diagnostic helpers.
export function _clearCache() { cache.clear(); }
export function _cacheSize() { return cache.size; }

// _registerResource: pre-populate the cache. The session worker uses
// this with a 'pageLifeSpan:<byosId>' id form to register in-RAM
// dicts/models so consumers hit cache without network or fixture
// lookup. Cache key follows the same canonicalize() rules as
// loadResource, so the subsequent
// loadResource(id, resourceCategory) call hits.
export function _registerResource(idOrPath, resourceCategory, sabOrPromise) {
  // For pageLifeSpan: ids the key is `${resourceCategory}::${id}`
  // directly. For other ids we treat it as fixture:false (the caller
  // is claiming a specific URL/path produced this SAB).
  let key;
  if (typeof idOrPath === 'string' && idOrPath.startsWith(PAGELIFESPAN)) {
    key = `${resourceCategory}::${idOrPath}`;
  } else {
    key = `${resourceCategory}::${absolutize(String(idOrPath))}`;
  }
  cache.set(key, {
    subscribers: new Set(),
    lastLabel: null,
    promise: Promise.resolve(sabOrPromise),
  });
}
