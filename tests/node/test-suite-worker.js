// Browser test-suite worker. Owns the harness so the main thread
// stays a thin renderer, same shape as stress-worker.js. The page
// (test-suite.html) spawns one instance per Run click and renders
// the events posted back here through runner-shell's mountRunner.
//
// Message protocol:
//   in  { type: 'run' }
//   in  { type: 'abort' }
//   out { type: 'event', event: { kind, … } }
//
// Event shapes (harness.js emits the first five via onProgress; this
// worker adds the last two for terminal states):
//   { phase: 'preload', total }
//   { phase: 'import',  done?, total }
//   { phase: 'run',     done, total, current }   // about to run test N
//   { phase: 'result',  result: { name, status, ms, error? } }
//   { phase: 'done',    total }
//   { phase: 'cancelled' }
//   { phase: 'fatal',   message }
//
// Stress's worker uses `kind` instead of `phase`; the shared shell
// (runner-shell.js) is vocabulary-agnostic, it just unwraps the
// envelope and forwards the inner event to the page's onEvent.
//
// Browser-safe ESM, no Node deps. Imports resolve as classic ES
// modules because the page spawns this worker with { type: 'module' }.

import { runAll } from './harness.js';

let controller = null;

self.addEventListener('message', async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'abort') {
    if (controller) controller.abort();
    return;
  }
  if (msg.type !== 'run') return;
  if (controller) {
    post({ phase: 'fatal', message: 'test-suite-worker: run already in flight' });
    return;
  }
  controller = new AbortController();
  try {
    await runAll({
      signal: controller.signal,
      onProgress: post,
    });
  } catch (e) {
    if (e?.message === 'cancelled' || controller?.signal?.aborted) {
      post({ phase: 'cancelled' });
    } else {
      post({ phase: 'fatal', message: String(e?.message || e) });
    }
  } finally {
    controller = null;
  }
});

function post(event) {
  self.postMessage({ type: 'event', event });
}
