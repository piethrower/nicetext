// Runtime-portable shim for `node:url`. Tests import only
// fileURLToPath; that's all this shim exposes.
//
// Node path: delegates to real `node:url` so the returned string is a
// filesystem path (no scheme) that real `node:fs` accepts.
// Browser path: returns the URL string. The browser shim of `node:fs`
// re-resolves that string via `new URL(p, location.href)`, so a
// file://-or-http://-prefixed result round-trips through readFileSync
// the same way Node's filesystem path does.

const isNode = typeof process !== 'undefined' && !!process?.versions?.node;

let fileURLToPathImpl;

if (isNode) {
  const url = await import('node:url');
  fileURLToPathImpl = (input) => url.fileURLToPath(input);
} else {
  fileURLToPathImpl = (input) => {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (typeof input.href === 'string') return input.href;
    return String(input);
  };
}

export const fileURLToPath = fileURLToPathImpl;
export default { fileURLToPath };
