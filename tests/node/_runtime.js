// Tiny runtime-detection helper for tests that need to mark
// themselves Node-only when something they reach for (typically
// readdirSync, on-disk fixture sweeps) doesn't have a browser
// equivalent.
//
// Usage:
//   import { isNode, nodeOnly } from './_runtime.js';
//   test('walks the fixtures dir', nodeOnly('readdirSync'), () => { ... });

export const isNode =
  typeof process !== 'undefined' && !!process?.versions?.node;

// Returns the `options` arg shape expected by `test(name, options, fn)`.
// When running in Node, returns null (so the test runs). When running
// in the browser, returns `{ skip: <reason> }` so the harness skips
// the test cleanly. Pass a short reason, it shows up in the test
// row's status badge in the browser page.
export function nodeOnly(reason) {
  return isNode ? null : { skip: `Node-only: ${reason}` };
}
