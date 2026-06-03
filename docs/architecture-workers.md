# Worker Architecture

**Status:** locked-in design from the 2026-04-29 discussion. Spec, not
plan. Captures decisions, not their rationale (rationale lives in the
discussion transcript and, where paper-bound, in
`docs/architecture-sab.md`).

## Scope

This document covers worker enablement for the encode/decode hot paths
in the browser page. Out of scope:

- **Build-time tools** (`tools/build-base-dict.js`,
  `tools/build-corpus-dict.js`, `tools/build-model-table.js`,
  `tools/build-all-fixtures.js`, `js/bin/gendict.js`). These remain
  single-threaded Node CLIs. No workers, no SAB. They run once per
  dict/model build, output JSON, exit.
- **CLI binaries** (`js/bin/nicetext.js`, `js/bin/scramble.js`). One-shot
  Node processes that call `encode()` / `decode()` inline. Workers buy
  them nothing.
- **Cycle mode**. Uses workers plus transferable streams. Design
  notes live in `docs/cycle-mode.md`.

## Core decisions

### 1. Workers default-on for the page

The browser page (`nicetext.html` and any future research-page figures
that run encode/decode) always dispatches jobs through a worker pool.
Pool size defaults to `navigator.hardwareConcurrency`, with a minimum
of 1 and a developer setting to override. A pool of 1 is still a
worker: same code path, no inline fallback.

The reason: the main thread is fully UI-only. Penny's typewriter,
tutorial transitions, button responsiveness, and the future
Drag-a-photo inbound stream all share the main thread; engine work
runs elsewhere.

The existing `setTimeout(0)` yield contract in `js/src/encode.js` and
`js/src/decode.js` (documented under "Engine yield + onProgress
contract" in `docs/web-ui.md`) stays. It serves inline
callers (CLI, Node tests, programmatic use) where there is no worker.
The yield is harmless when the engine runs in a worker (the worker
has no UI; the yield just hops the worker's own event loop) and
load-bearing for callers that do not have one. Keep as-is.

### 2. CLI stays inline

`js/bin/nicetext.js` and `js/bin/scramble.js` continue to call
`encode()` / `decode()` inline. Spinning up a `worker_threads` child
to do one encode and then terminating is overhead with no UI to keep
responsive. The Node process itself is the worker, conceptually.

If `nicetext-cycle` lands later, it uses workers (cycle mode benefits
from pipeline parallelism). It is a separate binary; the existing
CLIs are unaffected.

### 3. Tests cover both paths

The worker path is production code. Inline-only tests would leave the
harness, RPC wrapper, transferable handling, and pool logic
uncovered. Two test layers:

1. **Engine smokes** against `encode()` / `decode()` inline.
   Microsecond-fast. Covers the algorithm. Already exists in
   `tests/node/`.
2. **Worker integration tests** exercising the actual worker path:
   worker boots, RPC happens, transferables arrive intact, cancel
   works, progress fires, errors propagate. Slower per test but
   verifies what the page hits. New layer.

Both run via `node --test tests/node/` and via
`tests/node/test-suite.html`. Node side uses the worker shim
(§4); browser side has Worker natively.

### 4. Cross-runtime worker shim

Built and verified by step 4 (commit forthcoming) with smoke tests
in `tests/node/worker-shim.test.js`. Two browser-safe ESM modules:

- **`js/src/worker/spawn.js`**: parent-side. Exports
  `createWorker(url) → workerObj` returning a wrapper with the
  browser-shaped surface: `postMessage(msg, transferList?)`,
  `onmessage = fn`, `onerror = fn`, `terminate()`. Detects
  `typeof Worker !== 'undefined'` (browser) and constructs a native
  module Worker; otherwise dynamically imports `node:worker_threads`
  and wraps `worker_threads.Worker`. Also exports
  `defaultPoolSize()`, returning `navigator.hardwareConcurrency` when
  available and 1 otherwise.
- **`js/src/worker/parent-port.js`**: worker-side. Imported at the
  top of any worker entrypoint. Exports a `parentPort` object with
  `postMessage(msg, transferList?)` and `onMessage(fn)` that wraps
  either `self` (browser worker) or `worker_threads.parentPort`
  (Node worker). Uses top-level await for the Node import.

Why both modules live under `js/src/` rather than `js/node/` or
`tests/`: they are browser-safe (the dynamic import of
`node:worker_threads` only fires when `process.versions.node` is
detected, which is never true in a browser). Keeping them in the
browser-safe core means the engine and the eventual worker pool
(step 5) can import them from one path that works in both runtimes.
A future bundler would need to know about the dynamic Node import,
but we are zero-deps with no bundler, so this is not a concern.

Verified end-to-end on the Node path (worker_threads):

- spawn + echo + terminate
- SharedArrayBuffer round-trip without copy
- ArrayBuffer transfer detaches sender, arrives intact in worker
- multiple round-trips on one worker

Browser-path verification: step 7 added all SAB and worker tests
to `tests/node/manifest.json`. The same test files run in both
runtimes, 117 in Node, 115 + 1 skip in the browser harness. The
skipped test is `worker-shim: SharedArrayBuffer arrives without
copy`, which requires browser cross-origin isolation (COOP/COEP).
`tools/serve.sh` does not set those headers, so SAB is unavailable
in the local browser; the engine falls back to per-worker
`ArrayBuffer` copies with the same byte layout (functional but no
sharing). Production hosting that sets COOP/COEP gets full SAB
behavior and the test passes.

As Node grows native Web Worker support (in progress per the v22+
roadmap), the Node branch quietly becomes a no-op: the
`typeof Worker !== 'undefined'` check resolves true in Node too, the
dynamic import of `node:worker_threads` never fires.

### 5. On-demand workers + parent-side SAB cache

Implemented in step 5 (commit forthcoming) by `js/src/worker/jobs.js`
plus `js/src/worker/engine-worker.js`. Replaces the earlier
"persistent pool + parent-as-broker registry (Variant B)" design.

**Model.** Workers are spawn-and-terminate. Each worker handles
exactly one job (load / encode / decode), posts a single result
message, and the parent terminates it. There is no worker pool, no
correlation IDs, no idle-worker management. Workers are stateless
transformers, conceptually like running shell commands.

**Parent-side resource cache.** The parent maintains a
`Map<path, Promise<sab>>` keyed by resource path. First job that
needs a dict spawns a loader worker; that worker JSON-parses, packs
to SAB, posts the SAB ref back, and is terminated. The parent caches
the SAB and reuses it for every subsequent job. Concurrent first-load
requests for the same path share the in-flight Promise so only one
loader worker spawns.

**Why not a persistent pool.** Worker boot in Node `worker_threads`
is ~50-200 ms; in browser similar. For a single-click encode that
takes 1-3 s total, that boot cost is invisible. The expensive part
of "first load" is the JSON.parse + pack (600 ms-2 s for master),
and the SAB cache makes that a once-per-session cost regardless of
how many workers are spawned.

**For batch parallelism (future).** The matrix figure and
eight-styles panel will fire many small encodes. A simple
*concurrency limiter* (cap on simultaneous worker spawns) is
sufficient, much smaller than a pool because workers don't need to
stay warm between jobs.

**For cycle-mode pipeline (future).** Spawn N workers concurrently,
wire them with `MessageChannel` + transferable streams, await the
tail. Workers exist for the pipeline's lifetime and terminate when
the pipeline drains. Same on-demand spawn model, just with overlapping
worker lifetimes.

**Public API** in `js/src/worker/jobs.js`:

- `loadResource(path, kind) → Promise<SAB>`: explicit cache fill;
  rarely needed by callers, used by the job runners internally.
- `encodeJob(spec) → Promise<string>`: spec carries `payload`,
  `dictPath`, optional `modelPath` or `grammarPath`, `mode`,
  `randomSeed`, `streamSeed`, `maxLength`, `onProgress`, `signal`.
  Returns the cover text.
- `decodeJob(spec) → Promise<Uint8Array>`: spec carries `payload`
  (cover text), `dictPath`, `onProgress`, `signal`. Returns
  recovered bytes.

Cancellation is `AbortSignal`-based: callers pass `spec.signal` and
abort the controller to cancel. The parent posts `{type: 'cancel'}`
to the in-flight worker; the worker's `onProgress` callback returns
`'cancel'`, which the engine raises as a tagged Error; the parent
rejects the job promise with a standard `AbortError`.

### 6. Workers do JSON parse + SAB pack; parent does the I/O

Resource loading happens in two stages, split between threads:

1. **Parent reads the resource text.** `fs.readFile` (Node) or
   `fetch` (browser). Async; the only main-thread cost is queueing
   the read. For a 16 MB master.dict.json on a typical SSD this is ~50 ms.
2. **Worker does JSON.parse + pack.** Receives the text from the
   parent's job message, parses (~200-400 ms for master), packs into
   a SAB (~200-1500 ms depending on artifact). Worker terminates;
   parent caches the SAB.

Why split: the worker stays browser-safe (no `fs` shim needed). The
heavy work (`JSON.parse` and pack) still happens off the main thread.
The minor I/O hop on the parent (~50 ms async) is invisible.

`setTimeout(0)` yields between phases of *our* pack code (the
multi-pass binary writer) are fine to add. They do not help during
`JSON.parse` itself (atomic). The parse-in-worker decision is what
keeps the main thread responsive.

**Path semantics:** `loadResource`, `encodeJob`, `decodeJob` accept
either a string path or a `URL` object. In browser, the string is
passed verbatim to `fetch` and resolves against the document URL.
In Node, the string must be an absolute filesystem path or a `file://`
URL; tests typically pass `new URL('../../fixtures/jfk-1.dict.sab.gz', import.meta.url)` (or use the `loadDictFixture(fixtureURL('jfk'))` helper in `tests/node/_helpers.js`, which wraps the SAB via `wrapDictionaryFromSAB`).

## What is not yet decided

These items are flagged for follow-up. Each decision gets developer
y/n approval before being locked in.

- **Pre-warm strategy**: when to trigger resource loads. Three
  candidates: pre-warm on dict-picker change (load fires when the
  user picks a chip or dropdown), lazy on first encode (load fires
  on Smuggle click, page shows progress), or hybrid (pre-warm small
  dicts at page load, lazy-load large ones). Decide when wiring
  `app.js` (step 6).
- **Concurrency limiter for batch parallelism**: not needed yet, but
  the matrix and eight-styles figures will fire many small encodes.
  A simple cap on simultaneous worker spawns plus a queue of pending
  job specs is sufficient. Design when those figures land.
- **Pool-sizing override**: a developer setting to override
  `navigator.hardwareConcurrency`. Where it lives (URL param,
  localStorage, settings UI) is open. Not load-bearing for v1.

## Companion document

`docs/architecture-sab.md` covers the SAB binary format, lookup
code path, and the "raof to Map to SAB" design journey that motivates
always-SAB. The two documents are paired: workers without SAB would
pay roughly 30 MB times N RAM for a parsed master dict; SAB without
workers would not bother because there would be nothing to share
with.
