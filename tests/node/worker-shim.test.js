// Smoke tests for the cross-runtime worker shim. Verifies the shim
// works end-to-end on the Node path (worker_threads). The browser
// path uses native Worker + module worker; structural correctness is
// the same code, exercised by tests/node/test-suite.html when that is
// extended in step 7.
//
// See js/src/worker/spawn.js + js/src/worker/parent-port.js, and
// docs/architecture-workers.md §4 (Cross-runtime worker shim).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { createWorker, defaultPoolSize } from '../../js/src/worker/spawn.js';

const WORKER_URL = new URL('./fixtures/echo-worker.js', import.meta.url);

// Wrap the shim in a tiny RPC helper: send a message, await one reply.
// One pending request at a time per worker, which is fine for these
// smokes; the real pool will multiplex via correlation IDs in step 5.
function rpc(worker, msg, transferList) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => { worker.unref(); resolve(data); };
    worker.onerror   = (err) => { worker.unref(); reject(err); };
    // The onmessage/onerror setters each end with unref() (workers are
    // idle-by-default per spawn.js wrapNodeWorker), so ref() must come
    // AFTER them: it keeps the worker handle counting toward event-loop
    // liveness while we await the reply. Without it, in a shared-process
    // runner (run-node.mjs) with no other live handle the loop drains
    // mid-RPC and the reply never arrives. The handlers unref() on settle.
    worker.ref();
    worker.postMessage(msg, transferList);
  });
}

test('worker-shim: defaultPoolSize returns a positive integer', () => {
  const n = defaultPoolSize();
  assert.ok(Number.isInteger(n) && n >= 1, `expected positive int, got ${n}`);
});

test('worker-shim: spawn worker, echo a message, terminate', async () => {
  const w = await createWorker(WORKER_URL);
  try {
    const reply = await rpc(w, { type: 'echo', value: 42 });
    assert.deepEqual(reply, { type: 'echo-reply', value: 42 });
  } finally {
    await w.terminate();
  }
});

const SAB_AVAILABLE = typeof SharedArrayBuffer !== 'undefined';

test('worker-shim: SharedArrayBuffer arrives without copy', {
  skip: SAB_AVAILABLE ? false : 'requires cross-origin isolation (COOP/COEP)',
}, async () => {
  const sab = new SharedArrayBuffer(256);
  const u8 = new Uint8Array(sab);
  for (let i = 0; i < 256; i++) u8[i] = i;
  // Expected sum 0+1+...+255 = 32640.
  const expectedSum = (255 * 256) / 2;

  const w = await createWorker(WORKER_URL);
  try {
    const reply = await rpc(w, { type: 'sab-sum', sab });
    assert.equal(reply.type, 'sab-sum-reply');
    assert.equal(reply.sum, expectedSum);
    // After the worker reads the SAB, the parent still has full access.
    u8[0] = 99;
    assert.equal(u8[0], 99);
  } finally {
    await w.terminate();
  }
});

test('worker-shim: ArrayBuffer transfer detaches sender and arrives intact', async () => {
  const buf = new ArrayBuffer(8);
  new Uint8Array(buf)[0] = 0xAB;
  const w = await createWorker(WORKER_URL);
  try {
    const reply = await rpc(w, { type: 'transfer-buf', buf }, [buf]);
    assert.equal(reply.type, 'transfer-buf-reply');
    assert.equal(reply.length, 8);
    assert.equal(reply.firstByte, 0xAB);
    // Parent's copy is detached (zero byteLength).
    assert.equal(buf.byteLength, 0, 'sender ArrayBuffer should be detached');
  } finally {
    await w.terminate();
  }
});

test('worker-shim: multiple round-trips over one worker', async () => {
  const w = await createWorker(WORKER_URL);
  try {
    for (let i = 0; i < 5; i++) {
      const reply = await rpc(w, { type: 'echo', value: `msg-${i}` });
      assert.equal(reply.value, `msg-${i}`);
    }
  } finally {
    await w.terminate();
  }
});
