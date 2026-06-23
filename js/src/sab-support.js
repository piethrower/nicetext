// sab-support.js: single source of truth for "can we use a
// SharedArrayBuffer right now?". Every SAB-vs-ArrayBuffer branch in the
// runtime keys off sabUsable(), so the decision lives in exactly one
// place and is made by asking the platform — not by sniffing headers or
// browser versions, which change over time.
//
// Browser: a SharedArrayBuffer can only be constructed when the page is
//   cross-origin isolated (COOP: same-origin + COEP: require-corp). The
//   browser's own `crossOriginIsolated` flag is the honest answer to
//   "did that isolation actually take effect, by whatever route" —
//   whether granted server-side (tools/serve.py) or rescued client-side
//   (coi-sw.js on hosts like GitHub Pages that can't send the headers).
//
// Node: SharedArrayBuffer is always available and there is no
//   cross-origin-isolation concept, so it is always usable. The
//   NICETEXT_NO_SAB=1 env var forces the ArrayBuffer fallback path so
//   the Node test suite can exercise it — there is no "second port" in
//   Node, so this env var is the Node equivalent of the browser's
//   `tools/serve.py --no-isolation` port.

const IS_NODE = typeof process !== 'undefined'
  && typeof process.versions === 'object'
  && typeof process.versions.node === 'string';

// sabUsable() -> boolean. True when the runtime can both construct a
// SharedArrayBuffer and (in the browser) is cross-origin isolated.
export function sabUsable() {
  if (typeof SharedArrayBuffer !== 'function') return false;
  if (IS_NODE) {
    // Node always supports SAB; let tests force the fallback path.
    return process.env.NICETEXT_NO_SAB !== '1';
  }
  return globalThis.crossOriginIsolated === true;
}

// bufferMode() -> 'shared' | 'copy'. Human-facing label for the chosen
// buffer strategy; used by the on-page badge, the console line, and
// test assertions so they all report the same single decision.
export function bufferMode() {
  return sabUsable() ? 'shared' : 'copy';
}

// allocPackBuffer(byteLength) -> SharedArrayBuffer | ArrayBuffer. The one
// allocator for read-only packs: a SharedArrayBuffer when the platform can
// actually share one across workers, otherwise a plain ArrayBuffer that each
// worker structured-clones. Keys off sabUsable() so the choice lives in one
// place — never a try/catch that may construct a SAB the page can't postMessage.
export function allocPackBuffer(byteLength) {
  return sabUsable() ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
}
