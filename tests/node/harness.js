// Runtime-portable test harness. Loads tests/node/manifest.json,
// preloads fixtures into the node-fs shim (browser only), imports
// each test file (which registers tests via the shimmed `test()`),
// then runs every collected test sequentially. Reports pass / fail
// with timing and any AssertionError details via onProgress events.
//
// Used by:
//   - tests/node/run-node.mjs            (Node CLI: `npm test`)
//   - tests/node/test-suite-worker.js    (browser test page)
//
// Both runtimes hit the same code path; the shims handle the rest.

import { __preload, __reset as __fsReset } from './shims/node-fs.js';
import { __collected, __reset as __testReset } from './shims/node-test.js';
import { cardFixturePaths } from './cards-fixtures.js';

const isNode = typeof process !== 'undefined' && !!process?.versions?.node;
const MANIFEST_URL = new URL('./manifest.json', import.meta.url);

export async function loadManifest() {
  if (isNode) {
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8'));
  }
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error(`harness: GET manifest -> ${r.status}`);
  return r.json();
}

// Fixtures + test files in the manifest are URLs relative to
// tests/node/, the directory the manifest lives in.
function resolveAgainstManifest(spec) {
  return new URL(spec, MANIFEST_URL).href;
}

export async function runAll({ onProgress, signal } = {}) {
  __fsReset();
  __testReset();

  const manifest = await loadManifest();
  // Per-card dict/model/corpus paths come from cards.data.js + byos.js,
  // not the static manifest list, so adding a card is a zero-edit
  // change here. See tests/node/cards-fixtures.js.
  const fixturePaths = (manifest.fixtures || []).concat(cardFixturePaths());
  const fixtureUrls = fixturePaths.map(resolveAgainstManifest);
  const testUrls    = (manifest.tests    || []).map(resolveAgainstManifest);

  if (onProgress) onProgress({ phase: 'preload', total: fixtureUrls.length });
  await __preload(fixtureUrls, MANIFEST_URL.href);

  if (onProgress) onProgress({ phase: 'import', total: testUrls.length });
  // Import sequentially so a failing top-level evaluation in one
  // file doesn't spuriously fail-by-association tests in others.
  for (let i = 0; i < testUrls.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      await import(/* @vite-ignore */ testUrls[i]);
    } catch (e) {
      // Surface as a synthetic test failure so the user sees which
      // file failed to load (e.g., a missing fixture).
      const test = __collected();
      test.push({
        name: `[load] ${manifest.tests[i]}: ${e.message || e}`,
        fn: () => { throw e; },
      });
    }
    if (onProgress) onProgress({ phase: 'import', done: i + 1, total: testUrls.length });
  }

  const tests = __collected();
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    const t = tests[i];
    // Cooperative yield: a macrotask boundary between tests so the
    // event loop turns regardless of how fast the test body resolves.
    // Without this, runs of microtask-only tests starve every other
    // event source (timers, paint, postMessage). Universal best
    // practice: same reason engine paths (encode/decode/builder)
    // yield on their own cadence.
    if (i > 0) await new Promise(r => setTimeout(r, 0));
    if (onProgress) onProgress({ phase: 'run', done: i, total: tests.length, current: t.name });
    if (t.skip) { results.push({ name: t.name, status: 'skip' }); continue; }
    if (t.todo) { results.push({ name: t.name, status: 'todo' }); continue; }
    const t0 = performance.now();
    // Stub context object passed to test fns. Node's `node:test` provides
    // a real test context with diagnostic / skip / assert / etc. We only
    // implement what existing tests use today (diagnostic). Anything else
    // throws on access, which is the right signal that the shim needs
    // expanding.
    // Stub context object passed to test fns. Node's node:test provides
    // diagnostic / skip / assert / test (subtests). We support diagnostic
    // and test; subtests run inline, and a thrown subtest error is
    // re-thrown with the subtest label prepended so the parent's failure
    // message identifies which case failed. Granularity-per-subtest in
    // the results list isn't preserved (the parent owns the result entry).
    const ctx = {
      diagnostic(msg) { console.info(`# ${msg}`); },
      async test(subname, subfn) {
        try {
          await subfn(ctx);
        } catch (e) {
          if (e && typeof e === 'object') {
            e.message = `[${subname}] ${e.message || ''}`;
          }
          throw e;
        }
      },
      // Tests with internal loops can call ctx.progress to emit a
      // subprogress event AND yield to the event loop. Renderers
      // (browser test page) read it for live N/M ticks inside one
      // long-running test. Node runner ignores it. Cadence is the
      // caller's choice; call every 8-32 iterations to keep the
      // event load light.
      async progress(info) {
        if (onProgress) {
          onProgress({ phase: 'subprogress', test: t.name, ...info });
        }
        await new Promise(r => setTimeout(r, 0));
      },
    };
    let result;
    try {
      await t.fn(ctx);
      result = { name: t.name, status: 'pass', ms: performance.now() - t0 };
    } catch (e) {
      result = { name: t.name, status: 'fail', ms: performance.now() - t0, error: e };
    }
    results.push(result);
    if (onProgress) onProgress({ phase: 'result', result });
  }
  if (onProgress) onProgress({ phase: 'done', total: tests.length });
  return { manifest, results };
}
