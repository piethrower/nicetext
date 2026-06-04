// worker-ready-protocol.test.js
//
// Tripwire for the worker-ready protocol. Every Worker entry file
// MUST end with `postMessage({type:'ready'})` as the last statement
// after its top-level imports + handler registration, so that the
// shared createWorker() helper in js/src/worker/spawn.js can await
// that signal before resolving its Promise.
//
// Why this matters: on iOS Safari, concurrently-spawned workers
// loading the same module graph through the Service Worker can
// silently stall one or more of the workers. Forcing each worker to
// announce ready before createWorker() resolves serializes module
// load across concurrent spawns and eliminates the race. The
// protocol is only effective if EVERY worker entry file participates.
//
// This test scans each known worker entry file's source and asserts
// the ready emit is present. It runs identically under
// `npm test` (Node, via run-node.mjs) and in tests/node/test-suite.html
// (browser). Manifest preloads the worker files into the
// node-fs shim's cache for the browser path.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { readFileSync } from './shims/node-fs.js';

// Each entry: a worker entry file the codebase spawns via
// js/src/worker/spawn.js#createWorker. Paths are relative to THIS
// test file (so the same string resolves cleanly under Node's
// new URL(...) and the browser shim's URL resolution).
const WORKER_ENTRY_FILES = [
  '../../js/src/worker/resource-worker.js',
  '../../js/src/eve/job-worker-entry.js',
  '../../js/src/worker/aug-worker.js',
  '../../js/src/worker/engine-worker.js',
  '../../js/src/worker/preclean-worker.js',
  '../../js/src/worker/build-session-worker.js',
  '../../js/eve-worker.js',
];

// Accept either `parentPort.postMessage({type:'ready'})` (workers
// using the parent-port shim) or `self.postMessage({type:'ready'})`
// (workers that go straight through the Worker global). Whitespace
// inside the object literal is flexible; the key can be quoted or
// bare; the value can be single- or double-quoted.
const READY_EMIT_RE =
  /(parentPort|self)\.postMessage\s*\(\s*\{\s*['"]?type['"]?\s*:\s*['"]ready['"]\s*\}\s*\)/;

for (const path of WORKER_ENTRY_FILES) {
  test(`worker ${path} emits postMessage({type:'ready'})`, () => {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(
      src,
      READY_EMIT_RE,
      `${path} is missing the ready-protocol emit. Add ` +
      `\`parentPort.postMessage({ type: 'ready' });\` (or the self.* ` +
      `equivalent) as the LAST statement after top-level imports + ` +
      `handler registration. See js/src/worker/spawn.js for context.`,
    );
  });
}
