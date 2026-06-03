// Runtime-portable shim for `node:fs`. Used by every test file in
// place of `import 'node:fs'` so the same source runs under
//   - Node (delegates to real `node:fs`)
//   - Browser (preload-cache impl so the synchronous calls land on
//     already-fetched fixture text)
//
// Surface covers what tests + builder/byos helpers reach for:
//   readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync.
// Browser-only helpers (__preload, __reset) live on the export so
// the harness can warm the cache before importing test files. In
// Node they're no-ops.

const isNode = typeof process !== 'undefined' && !!process?.versions?.node;

let readFileSyncImpl;
let existsSyncImpl;
let readdirSyncImpl;
let mkdirSyncImpl;
let writeFileSyncImpl;
let __preloadImpl;
let __resetImpl;

if (isNode) {
  const fs = await import('node:fs');
  readFileSyncImpl  = (urlOrPath, encoding) => fs.readFileSync(urlOrPath, encoding);
  existsSyncImpl    = (urlOrPath) => fs.existsSync(urlOrPath);
  readdirSyncImpl   = (urlOrPath, opts) => fs.readdirSync(urlOrPath, opts);
  mkdirSyncImpl     = (urlOrPath, opts) => fs.mkdirSync(urlOrPath, opts);
  writeFileSyncImpl = (urlOrPath, data, opts) => fs.writeFileSync(urlOrPath, data, opts);
  __preloadImpl     = async () => {};
  __resetImpl       = () => {};
} else {
  // Browser path. Pre-fetch every fixture before tests import; tests
  // call readFileSync synchronously thereafter and read out of the
  // cache. Cache keys are absolute URL strings.
  const __cache = new Map();
  function keyOf(urlOrPath) {
    if (urlOrPath instanceof URL) return urlOrPath.href;
    try { return new URL(String(urlOrPath), location.href).href; }
    catch { return String(urlOrPath); }
  }
  readFileSyncImpl = (urlOrPath, _encoding) => {
    const key = keyOf(urlOrPath);
    if (!__cache.has(key)) {
      throw new Error(
        `node:fs shim: ${key} was not preloaded. ` +
        `Add it to tests/node/manifest.json "fixtures".`
      );
    }
    return __cache.get(key);
  };
  existsSyncImpl = (urlOrPath) => __cache.has(keyOf(urlOrPath));
  // No meaningful browser semantics for these, tests that exercise
  // them (filesystem walks, scratch writes) are Node-only by nature.
  // Throw clearly so a misclassified test surfaces.
  readdirSyncImpl   = () => { throw new Error('node:fs shim: readdirSync not supported in browser tests'); };
  mkdirSyncImpl     = () => { throw new Error('node:fs shim: mkdirSync not supported in browser tests'); };
  writeFileSyncImpl = () => { throw new Error('node:fs shim: writeFileSync not supported in browser tests'); };
  __preloadImpl = async (urls, baseUrl) => {
    const base = baseUrl || location.href;
    for (const u of urls) {
      const abs = new URL(u, base).href;
      if (__cache.has(abs)) continue;
      const r = await fetch(abs);
      if (!r.ok) throw new Error(`node:fs shim: preload ${abs} -> ${r.status}`);
      // .sab.gz fixtures are binary blobs that must reach the test
      // as bytes, decoding through `Response.text()` corrupts the
      // payload. Cache them as Uint8Array. Everything else is text
      // (json.gz / tsv.gz / .js / etc.) so the text path continues
      // to dominate.
      if (abs.endsWith('.sab.gz') || abs.endsWith('.sab')) {
        const stream = abs.endsWith('.gz')
          ? r.body.pipeThrough(new DecompressionStream('gzip'))
          : r.body;
        const buf = await new Response(stream).arrayBuffer();
        __cache.set(abs, new Uint8Array(buf));
      } else if (abs.endsWith('.gz')) {
        const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
        __cache.set(abs, await new Response(stream).text());
      } else {
        __cache.set(abs, await r.text());
      }
    }
  };
  __resetImpl = () => __cache.clear();
}

export const readFileSync  = readFileSyncImpl;
export const existsSync    = existsSyncImpl;
export const readdirSync   = readdirSyncImpl;
export const mkdirSync     = mkdirSyncImpl;
export const writeFileSync = writeFileSyncImpl;
export const __preload     = __preloadImpl;
export const __reset       = __resetImpl;

export default { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, __preload, __reset };
