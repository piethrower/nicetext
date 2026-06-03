// Worker-side shim: imported at the top of any worker entrypoint so
// engine code can use one parentPort API regardless of host. In a
// browser worker, wraps `self`. In a Node worker_threads thread,
// wraps `parentPort`.
//
// Usage in a worker file:
//
//   import { parentPort } from './parent-port.js';
//   parentPort.onMessage(async (msg) => {
//     parentPort.postMessage({ result: doWork(msg) });
//   });
//
// Top-level await loads node:worker_threads only on the Node path.

const IS_NODE = typeof process !== 'undefined'
  && typeof process.versions === 'object'
  && typeof process.versions.node === 'string';

let port;

if (IS_NODE) {
  const { parentPort: nodePort } = await import('node:worker_threads');
  if (!nodePort) {
    throw new Error('worker/parent-port: not running inside a Node worker_threads worker');
  }
  port = {
    postMessage(msg, transferList) { nodePort.postMessage(msg, transferList); },
    onMessage(fn) { nodePort.on('message', fn); },
    // Additive message listener so multiple consumers (e.g., the
    // resource-loader-client and the worker's own protocol) can
    // share the parent port without clobbering each other.
    // Returns an unsubscribe fn.
    addMessageListener(fn) {
      nodePort.on('message', fn);
      return () => nodePort.off('message', fn);
    },
  };
} else {
  // Browser worker context. self.postMessage and self.onmessage are
  // the standard Worker globals.
  port = {
    postMessage(msg, transferList) { self.postMessage(msg, transferList); },
    onMessage(fn) { self.onmessage = (e) => fn(e.data); },
    addMessageListener(fn) {
      const wrapped = (e) => fn(e.data);
      self.addEventListener('message', wrapped);
      return () => self.removeEventListener('message', wrapped);
    },
  };
}

export const parentPort = port;
