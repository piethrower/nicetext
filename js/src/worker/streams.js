// MessagePort-backed ReadableStream / WritableStream pairs with
// per-chunk ack-based backpressure. Each chunk posted by the writer
// carries a sequence number; the writer's underlying-sink write
// callback returns a Promise that resolves only when the reader sends
// back an 'ack' for that seq. The reader emits an 'ack' from its
// ReadableStream's pull callback, which the streams machinery invokes
// when the consumer has just freed a queue slot. Combined with the
// default highWaterMark of 1, this means at most one chunk is in
// flight and one chunk waits in each side's queue, with end-to-end
// flow control all the way back to the original producer.
//
// Pair shape: each MessagePort carries one direction's data (writer
// side to reader side as 'chunk' / 'close' / 'abort' messages, plus
// 'ack' from reader to writer) and the reader's cancel signal back
// (reader to writer as 'cancel'). A single port is owned by either
// portWritable or portReadable, never both, since each installs its
// own port.onmessage handler.
//
// A streaming job uses two channels: one for input bytes, one for
// output bytes. Parent and worker each own one end of each channel.
//
// Cross-runtime: works in browsers (native MessagePort) and Node 15+
// (node:worker_threads MessagePort, which exposes onmessage in the
// browser-compatible {data} shape).
//
// Chunk transfer is opt-in via `portWritable(port, { transfer: true })`.
// Default is structured-clone copy so callers retain valid references
// to their original Uint8Arrays. Use the transfer option only on the
// worker-to-parent direction where the chunk is throwaway.

function serializeReason(reason) {
  if (reason && typeof reason === 'object' && 'message' in reason) {
    return { name: reason.name ?? 'Error', message: String(reason.message) };
  }
  return { name: 'Error', message: String(reason) };
}

function deserializeReason(payload) {
  const err = new Error(payload?.message ?? 'aborted');
  err.name = payload?.name ?? 'Error';
  return err;
}

// Build a WritableStream<Uint8Array> backed by `port`. Each write posts
// {type:'chunk', chunk, seq} and returns a Promise that resolves on
// the matching {type:'ack', seq} message from the reader side. close
// and abort signal in-band. A 'cancel' message from the reader errors
// this writable and rejects every pending ack.
//
// Options:
//   transfer: when true, the chunk's underlying ArrayBuffer is
//             transferred (zero-copy) and the caller's view becomes
//             detached. Default false: structured-clone copy.
export function portWritable(port, { transfer = false } = {}) {
  let controller;
  const pendingAcks = new Map(); // seq -> { resolve, reject }
  let nextSeq = 0;

  function rejectAll(err) {
    for (const { reject } of pendingAcks.values()) reject(err);
    pendingAcks.clear();
  }

  const writable = new WritableStream({
    start(c) { controller = c; },
    write(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('portWritable: chunk must be a Uint8Array');
      }
      const seq = nextSeq++;
      return new Promise((resolve, reject) => {
        pendingAcks.set(seq, { resolve, reject });
        try {
          if (transfer) port.postMessage({ type: 'chunk', chunk, seq }, [chunk.buffer]);
          else port.postMessage({ type: 'chunk', chunk, seq });
        } catch (err) {
          pendingAcks.delete(seq);
          reject(err);
        }
      });
    },
    close() {
      try { port.postMessage({ type: 'close' }); } catch {}
    },
    abort(reason) {
      try { port.postMessage({ type: 'abort', reason: serializeReason(reason) }); } catch {}
      const err = reason instanceof Error ? reason : new Error(String(reason));
      rejectAll(err);
    },
  });

  port.onmessage = (e) => {
    const msg = e?.data;
    if (!msg) return;
    if (msg.type === 'ack') {
      const pending = pendingAcks.get(msg.seq);
      if (pending) {
        pendingAcks.delete(msg.seq);
        pending.resolve();
      }
      return;
    }
    if (msg.type === 'cancel') {
      const err = deserializeReason(msg.reason);
      try { controller.error(err); } catch {}
      rejectAll(err);
    }
  };
  if (typeof port.start === 'function') port.start();
  return writable;
}

// Build a ReadableStream<Uint8Array> backed by `port`. Receives
// {type:'chunk' | 'close' | 'abort'} from the writer side. Each
// 'chunk' is enqueued and its seq is remembered; pull (called by the
// streams machinery when the consumer frees a queue slot) sends
// {type:'ack', seq} back so the writer's awaiting write resolves and
// the next chunk can be posted. Reader cancellation posts
// {type:'cancel'} back across the same port so the writer can stop.
export function portReadable(port) {
  let controller;
  let unackedSeq = null;

  const readable = new ReadableStream({
    start(c) { controller = c; },
    pull() {
      if (unackedSeq !== null) {
        const seq = unackedSeq;
        unackedSeq = null;
        try { port.postMessage({ type: 'ack', seq }); } catch {}
      }
    },
    cancel(reason) {
      try { port.postMessage({ type: 'cancel', reason: serializeReason(reason) }); } catch {}
    },
  });

  port.onmessage = (e) => {
    const msg = e?.data;
    if (!msg) return;
    if (msg.type === 'chunk') {
      // Set unackedSeq BEFORE enqueue. enqueue synchronously fulfills
      // any pending read and synchronously fires pull; if seq is still
      // null when pull runs, the ack never goes out and the writer
      // hangs.
      unackedSeq = msg.seq;
      try { controller.enqueue(msg.chunk); } catch {}
    } else if (msg.type === 'close') {
      try { controller.close(); } catch {}
    } else if (msg.type === 'abort') {
      try { controller.error(deserializeReason(msg.reason)); } catch {}
    }
  };
  if (typeof port.start === 'function') port.start();
  return readable;
}
