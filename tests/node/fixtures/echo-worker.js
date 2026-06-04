// Smoke-test worker: handles two message kinds and replies via
// the unified parentPort shim. Used by tests/node/worker-shim.test.js.
//
// Loaded as a module worker (browser path) and as a worker_threads
// worker (Node path) via js/src/worker/spawn.js.

import { parentPort } from '../../../js/src/worker/parent-port.js';

parentPort.onMessage((msg) => {
  if (msg.type === 'echo') {
    parentPort.postMessage({ type: 'echo-reply', value: msg.value });
    return;
  }
  if (msg.type === 'sab-sum') {
    // msg.sab is a SharedArrayBuffer (no copy in the parent → worker
    // hop). Sum its bytes and reply with the total.
    const u8 = new Uint8Array(msg.sab);
    let sum = 0;
    for (let i = 0; i < u8.length; i++) sum += u8[i];
    parentPort.postMessage({ type: 'sab-sum-reply', sum });
    return;
  }
  if (msg.type === 'transfer-buf') {
    // msg.buf is a transferred ArrayBuffer (ownership moved). Inspect
    // length and first byte, reply.
    const u8 = new Uint8Array(msg.buf);
    parentPort.postMessage({
      type: 'transfer-buf-reply',
      length: u8.length,
      firstByte: u8[0] ?? -1,
    });
    return;
  }
  parentPort.postMessage({ type: 'error', reason: `unknown msg type ${msg.type}` });
});

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// handler registration; createWorker() awaits this before resolving.
parentPort.postMessage({ type: 'ready' });
