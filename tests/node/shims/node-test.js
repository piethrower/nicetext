// Runtime-portable shim for `node:test`. Pure JS, same code runs
// under Node (via run-node.mjs) and the browser (via test-suite.html
// + test-suite-worker.js). The harness collects top-level test()
// calls registered during ESM evaluation, then walks the list and
// runs each fn sequentially.

const __tests = [];

// Node's test() accepts (name, fn) or (name, options, fn). Options
// supports `skip: boolean | string` and `todo: boolean | string` as
// the surface our tests use. Anything falsy is "don't skip"; truthy
// (including a string reason) means skip and ignore fn.
export function test(name, optsOrFn, maybeFn) {
  let opts = null, fn = null;
  if (typeof optsOrFn === 'function') {
    // (name, fn) form
    fn = optsOrFn;
  } else if (typeof maybeFn === 'function') {
    // (name, opts | null | undefined, fn) form. Accept null/undefined
    // so the nodeOnly() helper can return null in Node (so the test
    // runs) and { skip } in browser without the call site branching.
    opts = optsOrFn || null;
    fn = maybeFn;
  } else if (optsOrFn && typeof optsOrFn === 'object') {
    // (name, opts) form, no fn, treat as skip/todo placeholder.
    opts = optsOrFn;
  }
  __tests.push({ name, fn, skip: opts?.skip || false, todo: opts?.todo || false });
}

test.skip = (name, fn) => __tests.push({ name, fn, skip: true });
test.only = test;
test.todo = (name) => __tests.push({ name, fn: null, todo: true });

export function describe(name, fn) {
  if (typeof fn === 'function') fn();
}
describe.skip = describe;

// Harness-only helpers. __collected returns the live array, callers
// that want to register a synthetic test (e.g., the harness's import-
// failure path) push directly so the registration sticks. Returning a
// copy here used to silently swallow synthetic test pushes.
export function __collected() { return __tests; }
export function __reset() { __tests.length = 0; }

export default test;
