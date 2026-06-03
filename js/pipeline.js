// pipeline.js: pipeline-mode driver. File-stream ingress, engine
// worker, Service-Worker save-as-stream egress; queue with a per-batch
// concurrency cap; per-row hooks for the pipeline progress modal.
//
// Mode is selected at the call site by shouldUsePipeline(): file size
// > T_secret/T_cover, or fileCount > 1. Below those thresholds the
// existing "load into the box" flow is unchanged.
//
// Browser-only. Uses Service Worker, ReadableStream, MessageChannel,
// and transferable streams. Lazy-registers the SW on the first call
// to ensurePipelineSW so users who never trigger pipeline don't pay
// the SW activation cost.

import { encodeJob, decodeJob } from './src/index.js';
import {
  detectLayersFromFactory as coverDetectLayersFromFactory,
  applyStripsToStream as coverApplyStripsToStream,
  applyStack as coverApplyStack,
  escapeTransform as coverEscapeTransform,
} from './src/cover-pipeline.js';
import { createEtaTracker } from './src/eta-tracker.js';

// ---- Thresholds ----
// Above these, a single-file load triggers the consent modal with the
// pipeline-or-load-into-box choice. Easy to revisit.
export const T_SECRET_BYTES = 64 * 1024;
export const T_COVER_BYTES = 1024 * 1024;

export function shouldUsePipeline(files, kind) {
  if (!files || files.length === 0) return false;
  if (files.length > 1) return true;
  const f = files[0];
  if (kind === 'encode') return f.size > T_SECRET_BYTES;
  if (kind === 'decode') return f.size > T_COVER_BYTES;
  return false;
}

// ---- Filename derivation ----
// Keep the original extension as part of the stem so round-trip is
// readable (foo.bin → foo.bin.cover.txt → foo.bin.cover.txt.recovered.bin).
export function deriveOutputName(inputName, kind) {
  const base = inputName || (kind === 'encode' ? 'secret' : 'cover');
  const suffix = kind === 'encode' ? '.cover.txt' : '.recovered.bin';
  return base + suffix;
}

// ---- Concurrency cap ----
// hwcc - 1 (leave one logical core for the main thread), floored to 1
// so a 1-core machine doesn't get zero workers. Treat undefined hwcc
// as 2 (older / privacy-restricted browsers).
export function defaultConcurrency(fileCount) {
  const hwcc = navigator.hardwareConcurrency || 2;
  return Math.min(Math.max(1, hwcc - 1), Math.max(1, fileCount));
}

// ---- Service worker registration ----
// Pipeline mode requires the browser to support transferring a
// ReadableStream via postMessage to a Service Worker. Safari < 16.4
// (and other older WebKit) returns a DataCloneError on this transfer,
// pipeline mode would otherwise fail silently with empty downloads.
// One-shot capability check, cached. Runs in a sandboxed try/catch
// because some browsers throw synchronously.
let _transferableStreamSupport = null;
export function pipelineCapable() {
  if (_transferableStreamSupport !== null) return _transferableStreamSupport;
  if (typeof ReadableStream === 'undefined' || typeof MessageChannel === 'undefined') {
    _transferableStreamSupport = false;
    return false;
  }
  try {
    const rs = new ReadableStream();
    const mc = new MessageChannel();
    mc.port1.postMessage({ rs }, [rs]);
    mc.port1.close();
    mc.port2.close();
    _transferableStreamSupport = true;
  } catch {
    _transferableStreamSupport = false;
  }
  return _transferableStreamSupport;
}

// Lazy: only fires on the first pipeline call. If coi.js already
// registered the SW for COI, getRegistration() returns it and we just
// wait for the page to be controlled.
let swRegisterPromise = null;
export function ensurePipelineSW() {
  if (swRegisterPromise) return swRegisterPromise;
  if (!('serviceWorker' in navigator)) {
    return Promise.reject(new Error('Service workers are not supported in this browser.'));
  }
  if (!pipelineCapable()) {
    return Promise.reject(new Error(
      'This browser cannot transfer streams to a service worker. ' +
      'Pipeline mode needs Safari 16.4+ or a recent Chromium / Firefox. ' +
      'Use the load-into-box option, or upgrade.'
    ));
  }
  swRegisterPromise = (async () => {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      // SW URL is the deployment-root coi-sw.js, computed relative to
      // this module (js/pipeline.js → ../coi-sw.js). Wrap in a
      // Trusted Types policy under strict CSP.
      const swUrl = new URL('../coi-sw.js', import.meta.url);
      let registerArg = swUrl;
      if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
        try {
          const policy = trustedTypes.createPolicy('pipeline-sw-url', {
            createScriptURL: (input) => input,
          });
          registerArg = policy.createScriptURL(swUrl.href);
        } catch {
          // Policy may already exist (rare); fall back to URL object.
        }
      }
      reg = await navigator.serviceWorker.register(registerArg);
    }
    if (!navigator.serviceWorker.controller) {
      // Wait until the SW is controlling this page; controllerchange
      // fires when skipWaiting + clients.claim takes effect.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Pipeline service worker did not activate within 5s.')),
          5000,
        );
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    return reg;
  })();
  swRegisterPromise.catch(() => { swRegisterPromise = null; });
  return swRegisterPromise;
}

// ---- Save stream registration ----
// Hand the SW a transferable ReadableStream and a filename, get back
// the magic URL whose fetch the SW will satisfy with that stream.
export async function registerSaveStream(id, readable, filename) {
  await ensurePipelineSW();
  const sw = navigator.serviceWorker.controller;
  if (!sw) throw new Error('Pipeline service worker is not controlling this page.');
  const chan = new MessageChannel();
  const ack = new Promise((resolve, reject) => {
    chan.port1.onmessage = ({ data }) => {
      if (data?.type === 'registered') resolve();
      else if (data?.type === 'error') reject(new Error(data.error));
    };
    chan.port1.onmessageerror = () => reject(new Error('SW ack channel error'));
  });
  sw.postMessage(
    { type: 'pipeline-save-register', id, stream: readable, filename, ackPort: chan.port2 },
    [readable, chan.port2],
  );
  await ack;
  return new URL(`__pipeline-save/${id}`, location.href).href;
}

// Hidden iframe navigation. SW's Content-Disposition: attachment makes
// the browser save the response instead of rendering it; iframes don't
// disturb the main document the way `<a download>` clicks can. Iframe
// is removed once the download has had time to start.
export function triggerDownload(url, filename) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = url;
  document.body.appendChild(iframe);
  // Leave the iframe long enough for the navigation to register and
  // the response headers to be received. 60 s is generous; the iframe
  // is invisible and weighs nothing.
  setTimeout(() => {
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  }, 60_000);
}

// ---- Helpers ----
function randomId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  let s = '';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return s;
}

function isCancelError(e) {
  return e && (e.code === 'cancelled' || e.name === 'AbortError');
}

function isWorkerSpawnError(e) {
  if (!e) return false;
  const msg = (e.message || String(e)).toLowerCase();
  // Browsers throw with various shapes when Worker construction fails
  // (browser cap reached, SecurityError, OOM). Match conservatively;
  // anything else is treated as a job-level failure.
  return /worker/.test(msg) && /(failed|construct|create|cannot|denied|security)/.test(msg);
}

// ---- Batch runner ----
// Runs a list of files through encode or decode in parallel, capped
// at concurrency. Each file:
//   1. f.stream() into the engine worker via encodeJob/decodeJob.
//   2. engine output ReadableStream piped into a TransformStream whose
//      readable side is transferred to the SW.
//   3. SW serves it as a Content-Disposition attachment under the
//      magic URL; the browser starts a save-as.
//
// Hooks (all optional):
//   onRowState(idx: state)   state in {'queued','running','saved','failed'}
//   onRowProgress(idx: fraction)   fraction is 0..1 or null (indeterminate)
//   onRowSaved(idx: filename)
//   onRowError(idx: friendlyMessage)
//   onConcurrencyChange(newCap)
//
// Resolves to { saved, failed } counts when all rows are settled.
// signal: AbortSignal, when fired, in-flight jobs abort and the
// remaining queue is marked failed with the cancel reason.
export async function runPipelineBatch({
  files, kind,
  dictPath, modelPath, grammarPath, mode,
  hooks = {}, signal,
  // Encode-only. When present, each row's engine output is piped
  // through the cover-escape transform and then through the layered
  // wrap stack BEFORE reaching the SW save stream, same chain
  // wrapCoverToBytes uses in the single-file Save Cover flow, but
  // stream-native so SW download backpressure propagates back to the
  // engine. wrap = { layers, filenameSuffix, customBasename? }.
  wrap = null,
}) {
  const job = kind === 'encode' ? encodeJob : decodeJob;
  let cap = defaultConcurrency(files.length);
  let nextIdx = 0;
  let failed = 0;
  let saved = 0;

  for (let i = 0; i < files.length; i++) hooks.onRowState?.(i, 'queued');

  const cancelEverythingQueued = (reason) => {
    while (nextIdx < files.length) {
      hooks.onRowError?.(nextIdx, reason);
      hooks.onRowState?.(nextIdx, 'failed');
      failed++;
      nextIdx++;
    }
  };

  async function runOne(idx) {
    if (signal?.aborted) return;
    hooks.onRowState?.(idx, 'running');
    const f = files[idx];
    // Encode pipeline output naming follows the wrap-controls rule:
    //   <inputName>.<basename><filenameSuffix>
    // where basename is the wrap-controls filename input (default
    // "message") and filenameSuffix is the active envelope+stack
    // extension chain (default ".txt"). Decode pipeline keeps the
    // legacy `.recovered.bin` convention via deriveOutputName.
    let outName;
    if (kind === 'encode' && wrap) {
      outName = `${f.name}.${wrap.basename || 'message'}${wrap.filenameSuffix || ''}`;
    } else {
      outName = deriveOutputName(f.name, kind);
    }
    const id = randomId();
    const inputBytes = f.size; // for fraction; only meaningful for encode

    // Decode-mode: detect cover wrapper chain on a peek (no buffering),
    // show the layer-picker via hook, and pipe the chosen strips into
    // the engine. Closes audit 2026-05-17 Finding 8 (pipeline-mode
    // skipping auto-strip on wrapped covers). Empty chain → straight
    // file stream as before; user cancel → row marked cancelled.
    let chosenStrips = null;
    if (kind === 'decode' && hooks.onCoverLayerPicker) {
      try {
        const layers = await coverDetectLayersFromFactory(() => f.stream());
        if (layers.length > 0) {
          const chosen = await hooks.onCoverLayerPicker(idx, f, layers);
          if (chosen === null) {
            hooks.onRowError?.(idx, 'Cancelled at unwrap picker.');
            hooks.onRowState?.(idx, 'failed');
            failed++;
            return;
          }
          chosenStrips = chosen;
        }
      } catch (err) {
        // Detection failed (e.g., read error). Fall through to engine
        // with raw stream; the engine's own error path handles the rest.
        hooks.onRowProgress?.(idx, null, `Detect failed (${err?.message || 'unknown'}); using raw input...`);
      }
    }

    // Encode-mode: one ETA tracker per row, persists across retries.
    // Decode has no a-priori byte total without scanning, so skip.
    // ETA display throttled to ≥1 s of jitter-free intervals; the
    // tracker is fed on every event so the EWMA stays smooth.
    const etaTracker = (kind === 'encode' && inputBytes > 0)
      ? createEtaTracker({ totalBytes: inputBytes })
      : null;
    let lastEtaDisplay = '';
    let lastEtaWriteMs = 0;
    const ETA_MIN_WRITE_INTERVAL_MS = 1000;

    // Per-row skip-validation controller (encode only). Fired by the
    // pipeline modal's per-row "Skip verify" button via the
    // onRowSkipValidationAvailable hook. Detaches the validator side
    // for THIS row only, other rows continue verifying.
    const skipValidationController = kind === 'encode' ? new AbortController() : null;
    let skipValidationAdvertised = false;

    let attempts = 0;
    let coverOrRecoveredStream;
    while (true) {
      attempts++;
      try {
        const seed = (Math.random() * 0x100000000) >>> 0;
        const baseStream = f.stream();
        const engineInput = (chosenStrips && chosenStrips.length > 0)
          ? coverApplyStripsToStream(baseStream, chosenStrips)
          : baseStream;
        coverOrRecoveredStream = await job({
          input: engineInput,
          dictPath, modelPath, grammarPath, mode,
          randomSeed: seed,
          streamSeed: seed,
          signal,
          skipValidationSignal: skipValidationController?.signal,
          onValidateProgress: (info) => {
            if (!skipValidationAdvertised && skipValidationController) {
              skipValidationAdvertised = true;
              try {
                hooks.onRowSkipValidationAvailable?.(idx, () => {
                  try { skipValidationController.abort(); } catch {}
                });
              } catch {}
            }
            // (No row-level UI for validate progress text today; the
            // validator runs concurrently with encode. Hook surface
            // kept minimal, just the skip-available signal.)
          },
          onProgress: (info) => {
            // Setup phase fires before the engine starts (first-time
            // dict / model / grammar fetch). Bar holds indeterminate.
            if (info?.phase === 'setup') {
              hooks.onRowProgress?.(idx, null, info.detail || 'Loading...');
              return;
            }
            // Encode: bitsRead → bytes processed; total = f.size.
            // Decode: wordsProcessed only; no total without scanning.
            let fraction = null;
            let detail = '';
            if (kind === 'encode') {
              const bytesProcessed = info && typeof info.bitsRead === 'number'
                ? Math.floor(info.bitsRead / 8) : 0;
              if (inputBytes > 0) {
                fraction = Math.max(0, Math.min(1, (info?.bitsRead ?? 0) / (8 * inputBytes)));
              }
              // Feed the EWMA every event; throttle only the display.
              const etaStr = etaTracker ? etaTracker.update(bytesProcessed) : null;
              if (etaStr) {
                const now = performance.now();
                if (now - lastEtaWriteMs >= ETA_MIN_WRITE_INTERVAL_MS) {
                  lastEtaDisplay = ` · ETA ${etaStr}`;
                  lastEtaWriteMs = now;
                }
              }
              detail = `${bytesProcessed.toLocaleString()} / ${inputBytes.toLocaleString()} bytes${lastEtaDisplay}`;
            } else {
              const wp = info?.wordsProcessed ?? 0;
              detail = `${wp.toLocaleString()} words checked`;
            }
            hooks.onRowProgress?.(idx, fraction, detail);
          },
        });
        break;
      } catch (err) {
        if (isWorkerSpawnError(err) && cap > 1 && attempts < 5) {
          cap -= 1;
          hooks.onConcurrencyChange?.(cap);
          // Yield briefly; another in-flight job may free a worker slot.
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        if (isWorkerSpawnError(err) && cap === 1) {
          // We can't spawn even one worker. Halt: this row fails AND
          // remaining queued rows fail with the same reason.
          hooks.onRowError?.(idx, "Couldn't start a worker.");
          hooks.onRowState?.(idx, 'failed');
          failed++;
          cancelEverythingQueued("Couldn't start a worker.");
          return;
        }
        // Non-spawn error: this file fails, batch continues.
        const friendly = isCancelError(err) ? 'Cancelled.' : (err?.message || String(err ?? 'unknown error'));
        hooks.onRowError?.(idx, friendly);
        hooks.onRowState?.(idx, 'failed');
        failed++;
        return;
      }
    }

    // Engine output → save stream. TransformStream gives a paired
    // readable (transferred to SW) and writable (we pipe into).
    const { readable, writable } = new TransformStream();
    let url;
    try {
      url = await registerSaveStream(id, readable, outName);
    } catch (err) {
      const friendly = err?.message || String(err ?? 'unknown error');
      hooks.onRowError?.(idx, friendly);
      hooks.onRowState?.(idx, 'failed');
      failed++;
      try { writable.abort(err); } catch {}
      return;
    }

    // Trigger the download AFTER the SW has the stream registered.
    // The browser issues the fetch; the SW returns the stream as the
    // response body; chunks land on disk as we write them.
    triggerDownload(url, outName);

    try {
      // Encode + wrap: insert escape → applyStack between engine and
      // SW. Stream-native (CompressionStream + pure-JS TransformStreams),
      // so SW download backpressure propagates back through the wrap
      // chain to the engine, engine throttles when disk write slows.
      const finalStream = (kind === 'encode' && wrap?.layers?.length)
        ? coverApplyStack(coverOrRecoveredStream.pipeThrough(coverEscapeTransform()), wrap.layers)
        : coverOrRecoveredStream;
      await finalStream.pipeTo(writable, { signal });
      hooks.onRowProgress?.(idx, 1);
      hooks.onRowSaved?.(idx, outName);
      hooks.onRowState?.(idx, 'saved');
      saved++;
    } catch (err) {
      const friendly = isCancelError(err) ? 'Cancelled.' : (err?.message || String(err ?? 'unknown error'));
      hooks.onRowError?.(idx, friendly);
      hooks.onRowState?.(idx, 'failed');
      failed++;
    }
  }

  async function workerLoop() {
    while (true) {
      if (signal?.aborted) break;
      const idx = nextIdx++;
      if (idx >= files.length) break;
      await runOne(idx);
    }
  }

  // If cancelled while running, mark whatever's still queued as failed
  // (in-flight jobs abort via signal propagation through encodeJob).
  const onAbort = () => cancelEverythingQueued('Cancelled.');
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const initial = Math.min(cap, files.length);
    const loops = [];
    for (let i = 0; i < initial; i++) loops.push(workerLoop());
    await Promise.all(loops);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  return { saved, failed };
}
