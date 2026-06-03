// Parent-side helpers for running encode/decode in workers, streaming.
//
// Model: on-demand workers, no persistent pool. Each job spawns a
// fresh engine worker, hands it two MessagePorts (one for the input
// byte stream, one for the output byte stream), pipes the caller's
// input ReadableStream into the worker's input port, and returns a
// ReadableStream wrapping the worker's output port. The worker is
// terminated when the output stream is fully consumed, errors, or
// the caller cancels.
//
// Resource SABs (dict / model / grammar) are still loaded by a
// separate one-shot worker and cached by path so subsequent jobs hit
// zero-copy.
//
// Browser-safe ESM. No Node deps at module-load time.
// (The Node read path imports `node:fs/promises` lazily.)
//
// See docs/architecture-workers.md.

import { createWorker } from './spawn.js';
import { portReadable, portWritable } from './streams.js';
import {
  loadResource as sharedLoadResource,
  _clearCache as sharedClearCache,
  _cacheSize as sharedCacheSize,
  _registerResource as sharedRegisterResource,
} from '../resource-loader.js';

const ENGINE_WORKER_URL = new URL('./engine-worker.js', import.meta.url);

function makeAbortError() {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('aborted', 'AbortError');
  }
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function urlKey(path) {
  return path instanceof URL ? path.href : String(path);
}

// Thin pass-through to the shared resource-loader. Existing callers
// (encodeJob/decodeJob, app.js, and the CLI bins) pass full paths /
// URLs (or `pageLifeSpan:` synthetic keys for in-RAM artifacts), so
// the default path uses fixture: false. The rewriter category is
// special: callers pass a bare id (e.g., `xanax`, `typos-forward`,
// `voice-pirate-categories`) and the shared loader composes
// `/fixtures/<id>.rewriter.sab.gz` via the fixture:true path.
export function loadResource(path, resourceCategory) {
  const key = urlKey(path);
  const opts = { fixture: resourceCategory === 'rewriter' };
  return sharedLoadResource(key, resourceCategory, opts);
}

// Run an encode job in a fresh worker.
//
// spec:
//   input       ReadableStream<Uint8Array>  : secret bytes
//   dictPath    string|URL                  : dict JSON path
//   modelPath   string|URL?                 : sentence-model-table JSON path
//   grammarPath string|URL?                 : .def grammar path
//                                             (mutually exclusive with modelPath;
//                                              if both omitted, falls back to a
//                                              weighted typeStream)
//   mode        'random'|'sequential'       : for model-table only
//   randomSeed  number?                     : engine RNG seed (for SIZER tail)
//   streamSeed  number?                     : typeStream/modelStream RNG seed
//   maxLength   number?                     : recursive grammar cap
//   onProgress  (info) => void?             : progress callback (parent thread)
//   onValidateProgress (info) => void?      : round-trip self-check progress
//                                             (encode only; fires as the
//                                             validator decode pass runs)
//   signal      AbortSignal?                : cancellation
//
// Returns Promise<ReadableStream<Uint8Array>> resolving to the cover-text
// byte stream. Reading to {done:true} terminates the worker.
export async function encodeJob(spec) {
  return runStreamingJob('encode', spec);
}

// Run a decode job. spec.input is the cover-text byte stream.
// Returns Promise<ReadableStream<Uint8Array>> resolving to the
// recovered secret-byte stream.
export async function decodeJob(spec) {
  return runStreamingJob('decode', spec);
}

async function runStreamingJob(kind, spec) {
  if (spec.signal?.aborted) throw makeAbortError();
  if (!spec.input) throw new Error(`${kind}Job: spec.input (ReadableStream) is required`);

  // loadResource is silent on a cache miss (fetch + parse + pack to
  // SAB inside a one-shot worker). On the first encode/decode after a
  // page load this can take several seconds with no UI feedback, so
  // emit synthetic setup-phase progress events. Cached calls return
  // synchronously and the user never sees these.
  const onSetup = (detail) => {
    if (spec.onProgress) {
      try { spec.onProgress({ phase: 'setup', detail }); } catch {}
    }
  };
  onSetup('Loading dictionary...');
  const dictSab = await loadResource(spec.dictPath, 'dict');
  let modelSab, grammarSab;
  if (kind === 'encode') {
    if (spec.modelPath && spec.grammarPath) {
      throw new Error('encodeJob: modelPath and grammarPath are mutually exclusive');
    }
    if (spec.modelPath) {
      onSetup('Loading sentence model...');
      modelSab = await loadResource(spec.modelPath, 'model');
    }
    if (spec.grammarPath) {
      onSetup('Loading grammar...');
      grammarSab = await loadResource(spec.grammarPath, 'grammar');
    }
  }

  // Cover-transforms rewriter apply-time fixtures. For each enabled
  // rewriter in spec.rewriter (byos universal `{enabled, intensity,
  // mode?}` per-field shape), load its fixtures/<name>.rewriter.sab
  // .gz (NTRW). The engine worker unpacks each into a Map<string,
  // Set<string>> and dispatches via setRewriterData() before encode
  // runs. Absent / null spec.rewriter, or no field enabled, means
  // nothing to load. Each loaded SAB is cached in resource-loader,
  // so subsequent jobs hit cache.
  let rewriterSabs = null;
  if (kind === 'encode' && spec.rewriter) {
    for (const [name, field] of Object.entries(spec.rewriter)) {
      if (!field || field.enabled !== true || !(field.intensity > 0)) continue;
      // Multi-mode rewriters ship one NTRW fixture per mode; the id
      // is `<name>-<mode>` (e.g., `typos-forward` / `typos-reverse`).
      // Unimodal rewriters keep their plain `<name>` id (xanax).
      const resourceId = typeof field.mode === 'string' && field.mode.length > 0
        ? `${name}-${field.mode}`
        : name;
      onSetup(`Loading rewriter (${resourceId})...`);
      const sab = await loadResource(resourceId, 'rewriter');
      if (!rewriterSabs) rewriterSabs = {};
      rewriterSabs[name] = sab;
    }
  }

  // Cover-transforms reformatter apply-time fixtures. The voice
  // reformatter consumes a per-mode categories NTRW
  // (fixtures/voice-<mode>-categories.rewriter.sab.gz, packed as
  // Map<category, Set<typename>>); the engine worker unpacks each
  // into a Map and dispatches via setRewriterData() before encode
  // runs. case / lineBreak / sentenceEnd are stateless and require
  // no fixture. SAB cache hits second + subsequent jobs.
  let reformatterSabs = null;
  if (kind === 'encode' && spec.reformatter) {
    for (const [name, field] of Object.entries(spec.reformatter)) {
      if (!field || field.enabled !== true || !(field.intensity > 0)) continue;
      if (name !== 'voice') continue; // only voice needs fixture today
      if (typeof field.mode !== 'string' || field.mode.length === 0) continue;
      const resourceId = `${name}-${field.mode}-categories`;
      onSetup(`Loading reformatter (${resourceId})...`);
      const sab = await loadResource(resourceId, 'rewriter');
      if (!reformatterSabs) reformatterSabs = {};
      reformatterSabs[name] = sab;
    }
  }

  if (spec.signal?.aborted) throw makeAbortError();

  const w = await createWorker(ENGINE_WORKER_URL);

  // Two MessageChannels: input direction (parent → worker), output
  // direction (worker → parent). Each channel is owned end-to-end by
  // a portWritable / portReadable pair.
  const chanIn = new MessageChannel();
  const chanOut = new MessageChannel();
  const inputWritable = portWritable(chanIn.port1);
  const outputReadablePort = portReadable(chanOut.port2);

  // Hand the worker its halves.
  w.postMessage(
    {
      type: kind,
      dictSab, modelSab, grammarSab,
      mode: spec.mode,
      randomSeed: spec.randomSeed,
      streamSeed: spec.streamSeed,
      maxLength: spec.maxLength,
      inputPort: chanIn.port2,
      outputPort: chanOut.port1,
      // Cover-transforms blocks (docs/cover-transforms.md). Both
      // carry the byos universal `{enabled, intensity, mode?}` per-
      // field shape; the engine worker forwards them straight to
      // encode() opts. rewriterSabs is { <name>: SharedArrayBuffer }
      // of NTRW SABs pre-loaded above; the engine worker unpacks
      // each per-job. All default to null when the caller doesn't
      // override.
      rewriter: spec.rewriter || null,
      rewriterSabs: rewriterSabs || null,
      reformatter: spec.reformatter || null,
      reformatterSabs: reformatterSabs || null,
    },
    [chanIn.port2, chanOut.port1],
  );

  // Cleanup runs once the job is fully drained, erroed, or cancelled.
  let cleaned = false;
  let abortListener = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (abortListener && spec.signal) {
      spec.signal.removeEventListener('abort', abortListener);
    }
    try { w.terminate(); } catch {}
  };

  // Wrap the output port-readable so we can (a) terminate the worker
  // when the consumer is done, and (b) force-error the stream if the
  // worker dies outside the engine path (e.g., dict-SAB unwrap throws
  // before encode runs and only a {type:'error'} parent-port message
  // surfaces it).
  let outController;
  let outReader;
  const output = new ReadableStream({
    start(c) {
      outController = c;
      outReader = outputReadablePort.getReader();
    },
    async pull(c) {
      try {
        const { value, done } = await outReader.read();
        if (done) {
          c.close();
          cleanup();
        } else {
          c.enqueue(value);
        }
      } catch (err) {
        c.error(err);
        cleanup();
      }
    },
    cancel(reason) {
      const r = reason ?? makeAbortError();
      try { outReader.cancel(r); } catch {}
      try { inputWritable.abort(r); } catch {}
      cleanup();
    },
  });

  // Forward 'progress' messages to spec.onProgress; force-error the
  // output if the worker reports a fatal error before the engine has
  // had a chance to abort the output port itself. 'validateProgress'
  // is the encode-only round-trip self-check pass; routed to a
  // separate callback so the UI can show a second progress bar.
  w.onmessage = ({ data }) => {
    if (data?.type === 'progress' && spec.onProgress) {
      try { spec.onProgress(data.info); } catch {}
      return;
    }
    if (data?.type === 'validateProgress' && spec.onValidateProgress) {
      try { spec.onValidateProgress(data.info); } catch {}
      return;
    }
    if (data?.type === 'error') {
      const err = new Error(data.error);
      try { outController.error(err); } catch {}
      // inputWritable is held by pipeTo's lock; abort() rejects async
      // when locked, so swallow the returned promise's rejection too.
      Promise.resolve(inputWritable.abort(err)).catch(() => {});
      cleanup();
    }
  };
  w.onerror = (err) => {
    try { outController.error(err); } catch {}
    Promise.resolve(inputWritable.abort(err)).catch(() => {});
    cleanup();
  };

  // Pipe caller's input into the worker's input port. pipeTo handles
  // backpressure and propagates abort/cancel either way. We hand
  // pipeTo the same AbortSignal so cancellation aborts the pipe
  // operation cleanly, pipeTo itself releases the writer lock and
  // aborts inputWritable internally. Without this, the cancel
  // listener below would try to abort a writable still locked by
  // pipeTo and the rejection escaped as an unhandledrejection.
  spec.input.pipeTo(inputWritable, { signal: spec.signal }).catch(() => {
    // Source-side errors and signal-driven aborts are already mirrored
    // into the writable; the worker's portReadable will surface them
    // as a read rejection.
  });

  // Cancel: parent-driven abort propagates through both streams plus
  // a terminate backstop in case the worker is wedged in pure compute.
  // Input side is handled by the pipeTo signal above; here we error
  // the output stream and cancel the port reader. Both calls return
  // promises that may reject (already-closed / locked); swallow.
  if (spec.signal) {
    abortListener = () => {
      const reason = makeAbortError();
      try { outController.error(reason); } catch {}
      Promise.resolve(outReader.cancel(reason)).catch(() => {});
      setTimeout(() => { try { w.terminate(); } catch {} }, 50);
    };
    spec.signal.addEventListener('abort', abortListener);
  }

  // Round-trip self-check skip (encode only): when the caller fires
  // this signal mid-job, post a control message that flips the
  // worker's local AbortController. The worker's encode() then detaches
  // the validator branch, the in-worker decode stops eating CPU and
  // the fan-out writer stops pacing to validator backpressure, so the
  // remaining encode races at user-writer speed. { once:true } so the
  // listener self-removes on the first abort; on natural completion
  // the per-job AbortController goes out of scope with its caller.
  if (kind === 'encode' && spec.skipValidationSignal) {
    const post = () => {
      try { w.postMessage({ type: 'skipValidation' }); } catch {}
    };
    if (spec.skipValidationSignal.aborted) post();
    else spec.skipValidationSignal.addEventListener('abort', post, { once: true });
  }

  return output;
}

// Test/diagnostic helper: clear the resource cache. Production
// code shouldn't need this; the cache lives the session.
export function _clearResourceCache() {
  sharedClearCache();
}

// Test/diagnostic helper: report cache state.
export function _resourceCacheSize() {
  return sharedCacheSize();
}

// Pre-populate the cache for an in-memory SAB (e.g., a custom-built
// dict from build-session-worker) under a synthetic `pageLifeSpan:`
// key + resourceCategory. encodeJob/decodeJob then resolve that key
// to the SAB without re-fetching. Caller owns the key namespace;
// collisions overwrite. `resourceCategory` must match what callers
// later pass to loadResource (the cache key is
// `${resourceCategory}::${id}`).
export function _registerResource(key, resourceCategory, sabOrPromise) {
  sharedRegisterResource(urlKey(key), resourceCategory, sabOrPromise);
}
