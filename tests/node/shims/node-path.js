// Runtime-portable shim for `node:path`. Surface: dirname, join,
// resolve. Node path delegates to real `node:path` so platform
// nuances (Windows, etc.) are handled correctly. Browser path keeps
// the POSIX-only impl that's served us in the test page.

const isNode = typeof process !== 'undefined' && !!process?.versions?.node;

let dirnameImpl;
let joinImpl;
let resolveImpl;

if (isNode) {
  const path = await import('node:path');
  dirnameImpl = (p) => path.dirname(p);
  joinImpl    = (...parts) => path.join(...parts);
  resolveImpl = (...parts) => path.resolve(...parts);
} else {
  dirnameImpl = (p) => {
    if (typeof p !== 'string') p = String(p);
    const i = p.lastIndexOf('/');
    if (i < 0) return '.';
    if (i === 0) return '/';
    return p.slice(0, i);
  };
  // POSIX-style join: glue with '/' and collapse runs of '/' down to
  // one, EXCEPT the `://` of a scheme (so an http://-prefixed path
  // passed through here survives intact, readFileSync resolves the
  // final string via `new URL(p, location.href)`, which needs the
  // `://` to recognize an absolute URL).
  joinImpl = (...parts) => {
    const joined = parts
      .filter((p) => p != null && p !== '')
      .map((p) => String(p))
      .join('/');
    return joined
      .replace(/:\/\//g, ' ')
      .replace(/\/+/g, '/')
      .replace(/ /g, '://');
  };
  // POSIX resolve: walk segments left-to-right, treating any segment
  // that starts with '/' as a reset to absolute. With no inputs,
  // return the document base path (matches Node's `process.cwd()` in
  // spirit: the test never asserts the literal value).
  resolveImpl = (...parts) => {
    let acc = typeof location !== 'undefined' ? new URL('.', location.href).pathname : '/';
    for (const raw of parts) {
      if (raw == null || raw === '') continue;
      const p = String(raw);
      if (p.startsWith('/')) {
        acc = p;
      } else {
        acc = joinImpl(acc, p);
      }
    }
    return acc;
  };
}

export const dirname = dirnameImpl;
export const join    = joinImpl;
export const resolve = resolveImpl;

export default { dirname, join, resolve };
