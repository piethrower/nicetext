# Test Infrastructure

How the same `tests/node/*.test.js` files run under both
`npm test` (Node, via `tests/node/run-node.mjs`) and
`tests/node/test-suite.html` (browser, via `tests/node/test-suite-
worker.js`). One harness, runtime-portable shims, identical execution
shape in both runtimes, the same engine+transport+UI design the
stress test uses (see `tests/node/stress/stress-engine.js` +
`tests/node/stress-worker.js` + `tests/node/stress-test.html`).

## Architecture (locked-in design)

Principles:

1. **One harness, two transports.** `tests/node/harness.js` is the
   engine: imports test files in manifest order, runs collected
   tests sequentially, emits `onProgress` events. Two transports:
   - `run-node.mjs` (Node CLI; TAP-style stdout, exit code).
   - `test-suite-worker.js` (browser Web Worker; posts events back
     to `test-suite.html`, which renders via `runner-shell.js`'s
     `mountRunner` + `startTicker` at 1 Hz).
   The shared scaffolding (Worker spawn + envelope unwrap +
   AbortSignal teardown + 1 Hz repaint) lives in `runner-shell.js`
   and is used by both `stress-test.html` and `test-suite.html`.

2. **Runtime-portable shims** under `tests/node/shims/` for the
   `node:*` modules the tests need (`node-test`, `node-assert`,
   `node-fs`, `node-url`, `node-path`, `node-zlib`). Each shim
   detects `process.versions?.node` and:
   - In Node: delegates to the real `node:*` module via dynamic
     import (TLA at module top).
   - In browser: provides a pure-JS impl (test/assert) or a
     preload-cache impl (fs reads from cache that the harness
     primes via `__preload`).
   Test files import from the shim by relative path
   (`./shims/node-X.js` or `../shims/node-X.js`). No importmap
   needed; works in pages, workers, and Node alike, same way
   `stress/stress-engine.js` is "browser-native" but runs in Node
   too.

3. **Cooperative yield is a project invariant.** The harness inserts
   one macrotask boundary (`await new Promise(r => setTimeout(r,
   0))`) between every test so the event loop turns no matter how
   fast the test body resolves. Inside long-running engine paths
   (encode, decode, builder), the engine yields on its own cadence.
   Universal: Node and browser, test suite and stress, same rule.

4. **Web Workers for the browser test page.** The harness runs
   inside `test-suite-worker.js` so the main thread stays a thin
   renderer. Reflects the same shape the stress test established in
   the 2026-04-29 worker arc. Tests that themselves spawn workers
   (`worker-shim.test.js`, `worker-jobs.test.js`,
   `worker-streams.test.js`) now run as nested workers; modern
   Chrome / Firefox / Safari 14+ support this. The browser runner
   reads fixtures via `fetch()` (preloaded into the node-fs shim's
   cache); cross-origin isolation (COOP/COEP) needed for SAB tests
   is provided by `tools/serve.py` (dev) and `coi-sw.js` (deployed).

5. **Node-only tests use `nodeOnly()`.** A few tests reach for
   `readdirSync` to enumerate `tools/byos/*.byos.json` on disk, or
   `existsSync` to sanity-check that every shipped card has a
   corpus file. These can't run in a browser by nature; they import
   `{ nodeOnly } from './_runtime.js'` (or `'../_runtime.js'` from
   the `byos/` subdir) and pass `nodeOnly('reason')` as the test
   options. In Node it's a no-op; in browser the harness skips the
   test with a clear reason.

   (The persistence story for user-built dictionaries / models
   — `localStorage`, export/import — is a UI concern, not a
   test-infrastructure one. See the web-UI / builders docs.)

## Components

- `tests/node/manifest.json`: single source of truth for which
  test files run, in both Node and browser. The Node runner walks
  this list; the browser runner walks the same list. Keeps the two
  runtimes' test sets aligned by construction.
- `tests/node/harness.js`: runtime-portable harness. Reads the
  manifest (via `node:fs` in Node, `fetch` in browser), preloads
  fixtures into the `node-fs` shim's cache (browser only;
  `__preload` is a no-op in Node), imports each test file (which
  registers tests via the shimmed `test()`), runs collected tests
  sequentially with a `setTimeout(r, 0)` yield between each.
- `tests/node/run-node.mjs`: Node CLI entry point. `npm test` runs
  this. TAP-style output, exit code 1 on failure.
- `tests/node/test-suite.html`: browser test page. Renderer-only;
  spawns `test-suite-worker.js` via `runner-shell.js`'s
  `mountRunner`, repaints status at 1 Hz via `startTicker`.
- `tests/node/test-suite-worker.js`: browser harness host. Imports
  `harness.js` inside a Web Worker so the main thread stays a thin
  renderer. Mirrors `stress-worker.js`'s message protocol exactly.
- `tests/node/runner-shell.js`: shared scaffolding for the two
  long-running browser programs (test-suite + stress). Owns Worker
  spawn, envelope unwrap, AbortSignal teardown, and the 1 Hz
  ticker. Single place to flip behavior for both.
- `tests/node/_runtime.js`: `isNode` flag + `nodeOnly(reason)`
  helper for the handful of tests that fundamentally can't run in
  a browser (filesystem enumeration, on-disk fixture checks).
- `tests/node/shims/node-test.js`: test-registration shim.
  Pure JS, runs in both runtimes. Supports `test(name, fn)`,
  `test(name, options | null, fn)` (for `{skip, todo}`),
  `test.skip`, `test.todo`, and a no-op `describe`.
- `tests/node/shims/node-assert.js`: assertion shim. Pure JS.
  Covers `deepEqual`, `notDeepEqual`, `deepStrictEqual`,
  `notDeepStrictEqual`, `equal`, `strictEqual`, `notEqual`,
  `notStrictEqual`, `ok`, `throws`, `rejects`, `doesNotThrow`,
  `doesNotReject`, plus the `AssertionError` class.
- `tests/node/shims/node-fs.js`: runtime-portable. Node:
  delegates to `node:fs` (real readFileSync / existsSync /
  readdirSync / mkdirSync / writeFileSync). Browser:
  preload-cache impl for the synchronous readFileSync;
  readdirSync / mkdirSync / writeFileSync throw with a clear
  message (those are Node-only by nature; tests that need them
  use `nodeOnly()`).
- `tests/node/shims/node-url.js` / `node-path.js` / `node-zlib.js`:
  runtime-portable. Node: delegates to the real module.
  Browser: pure-JS subset (POSIX-only path helpers, URL-string
  passthrough for fileURLToPath, identity gunzipSync since the
  node-fs shim already decompresses .gz at preload).

## Cross-runtime status

- Node: `npm test` runs `tests/node/run-node.mjs`. For the current
  test count, see the `npm test` summary line (counts drift as
  files are added; the harness reports the live total).
- Browser: `tools/serve.sh && open
  http://127.0.0.1:8888/tests/node/test-suite.html` loads the
  page, which spawns `test-suite-worker.js`. The browser total is
  slightly lower than Node's (see the page's status line for the
  live count): the difference is the `nodeOnly()` tests for
  filesystem-walking checks plus SAB tests that need cross-origin
  isolation the local `python3 -m http.server` doesn't supply.
- Diagnostics: `tools/test-suite-hang.js` drives test-suite.html
  via Playwright, samples the status line at 500 ms, reports any
  perceived stall. `tools/test-suite-failures.js` lists every
  failing test with its error.

## Adding a new test file

1. Create `tests/node/my-thing.test.js`. Import test/assert and
   any other Node modules via the relative shim paths
   (`./shims/node-test.js`, `./shims/node-assert.js`, etc.). No
   bare `node:*` specifiers. No DOM.
2. If the test reads a fixture via the shimmed `readFileSync`,
   add the fixture path (relative to `tests/node/`) to
   `manifest.json`'s `fixtures` array.
3. Add the test filename to `manifest.json`'s `tests` array.
4. `npm test`, picks it up automatically.
5. Open `test-suite.html` (after `tools/serve.sh`), same.

If a test fundamentally can't run in browser (filesystem
enumeration, on-disk existence checks):
```js
import { nodeOnly } from './_runtime.js';
test('walks the fixtures dir', nodeOnly('readdirSync'), () => { ... });
```

If a test needs cross-origin isolation in the browser (SAB), gate
it the same way:
```js
test('SAB round-trip', { skip: 'requires COOP/COEP' }, fn);
```
