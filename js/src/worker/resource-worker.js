// Shared resource-loader worker. Runs one-shot resource loads
// requested by the main-thread resource-loader.js (which spawns a
// pool of these workers and dispatches per-job via the shared
// js/src/worker/pool.js contract).
//
// Job kinds:
//   load-raw-bytes   {url}            fetch + gunzip → SAB (no parse).
//                                     Used by raw-bytes pseudo-type
//                                     AND the SAB-first fast path for
//                                     /fixtures/*.<type>.sab.gz.
//   load-native      {url, type}      fetch + gunzip + decode text +
//                                     sab.pack(text, type) → SAB.
//                                     Used by the native-fallback
//                                     path when no .sab.gz exists.
//   load-grammar     {url}            fetch + parseGrammar + pack
//                                     → SAB. User .def files via CLI.
//
// Per-kind dict/model/twlist handlers were removed; their behavior
// now lives in `load-native` via sab.js's pack registrations.
//
// Message protocol (matches pool.js):
//   in   { jobId, kind, payload }
//   in   { type: 'shutdown' }
//   out  { jobId, ok: true,  result }                   final reply
//   out  { jobId, ok: false, error: { name, message } } final reply
//   out  { jobId, progress: { label } }                 intermediate
//
// Progress emits are time-throttled to >=1s in the handler.
//
// Browser-safe and node-safe ESM.

import { parentPort } from './parent-port.js';
import { copyIntoSharedArrayBuffer } from '../eve/packed-strings-sab.js';
import { packGrammarToSAB } from '../builder/grammar-pack.js';
import { parseGrammar } from '../grammar/parser.js';
import { pack as sabPack } from '../sab.js';

const IS_NODE = typeof process !== 'undefined'
  && typeof process.versions === 'object'
  && typeof process.versions.node === 'string';

function throttleProgress(progress, intervalMs = 1000) {
  if (!progress) return null;
  let last = 0;
  return (label) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    progress(label);
  };
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// fetchText: returns the (gunzipped, if .gz) text body of url. The
// optional `byteProgress` callback receives { bytesReceived,
// bytesTotal } as compressed bytes flow in. bytesTotal is the
// Content-Length header value (raw compressed bytes for a .gz
// fixture served as octet-stream), or 0 when the server didn't
// send one. Node path is one-shot (local disk); emits a single
// final byteProgress with the full size.
async function fetchText(url, byteProgress = null) {
  if (IS_NODE) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(new URL(url));
    if (byteProgress) byteProgress({ bytesReceived: buf.length, bytesTotal: buf.length });
    if (String(url).endsWith('.gz')) {
      const { promisify } = await import('node:util');
      const { gunzip } = await import('node:zlib');
      const out = await promisify(gunzip)(buf);
      return out.toString('utf8');
    }
    return buf.toString('utf8');
  } else {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
    const total = Number(r.headers.get('Content-Length') || 0);
    const counted = countingStream(r.body, total, byteProgress);
    if (String(url).endsWith('.gz')) {
      const stream = counted.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    }
    return await new Response(counted).text();
  }
}

// fetchToSAB: returns a SharedArrayBuffer of the gunzipped bytes.
// Same byteProgress contract as fetchText.
async function fetchToSAB(url, byteProgress = null) {
  if (IS_NODE) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(new URL(url));
    if (byteProgress) byteProgress({ bytesReceived: buf.length, bytesTotal: buf.length });
    let ab;
    if (String(url).endsWith('.gz')) {
      const { promisify } = await import('node:util');
      const { gunzip } = await import('node:zlib');
      const out = await promisify(gunzip)(buf);
      ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    } else {
      ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    return copyIntoSharedArrayBuffer(ab);
  } else {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
    const total = Number(r.headers.get('Content-Length') || 0);
    const counted = countingStream(r.body, total, byteProgress);
    if (String(url).endsWith('.gz')) {
      const stream = counted.pipeThrough(new DecompressionStream('gzip'));
      const ab = await new Response(stream).arrayBuffer();
      return copyIntoSharedArrayBuffer(ab);
    }
    const ab = await new Response(counted).arrayBuffer();
    return copyIntoSharedArrayBuffer(ab);
  }
}

// Wrap a ReadableStream in a passthrough TransformStream that
// tallies chunk byteLengths and reports them to byteProgress. The
// counter sits upstream of decompression so the count tracks
// compressed bytes, what the network actually delivered, which
// matches Content-Length and is the meaningful "download progress"
// signal on a slow link. No-op when byteProgress is null.
function countingStream(body, bytesTotal, byteProgress) {
  if (!byteProgress) return body;
  let received = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      try { byteProgress({ bytesReceived: received, bytesTotal }); } catch {}
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(counter);
}

// load-raw-bytes: fetch + gunzip → SAB. Used both by the raw-bytes
// pseudo-type (consumers decode locally) and by the SAB-first fast
// path of the new (id, type) loader (fixtures already packed).
async function handleLoadRawBytes({ url }, progress) {
  const throttled = throttleProgress(progress);
  const stem = String(url).split('/').pop();
  if (throttled) throttled(`${stem}: starting`);
  const byteProgress = makeByteProgress(stem, throttled);
  const sab = await fetchToSAB(url, byteProgress);
  // Final emit is unthrottled so the last "ready" label always
  // lands (throttleProgress drops trailing events inside its
  // interval; a fast load could otherwise show no terminal label).
  if (progress) progress(`${stem}: ${formatBytes(sab.byteLength)} ready`);
  return sab;
}

// Build a per-resource byte-progress callback that emits throttled
// labels. The callback is shaped to match fetchToSAB / fetchText's
// byteProgress contract: { bytesReceived, bytesTotal }. bytesTotal
// of 0 means "no Content-Length" (server didn't send one); the
// label degrades gracefully to running-count-only.
function makeByteProgress(stem, throttled) {
  if (!throttled) return null;
  return ({ bytesReceived, bytesTotal }) => {
    if (bytesTotal > 0) {
      throttled(`${stem}: ${formatBytes(bytesReceived)} / ${formatBytes(bytesTotal)}`);
    } else {
      throttled(`${stem}: ${formatBytes(bytesReceived)} received`);
    }
  };
}

// load-native: fetch + gunzip + decode text + sab.pack(text, type)
// → SAB. The native-fallback half of the SAB-first/native-fallback
// resolution policy. Routes through js/src/sab.js so every per-type
// pack lives in exactly one place.
async function handleLoadNative({ url, type }, progress) {
  const throttled = throttleProgress(progress);
  const stem = String(url).split('/').pop();
  if (throttled) throttled(`${stem}: starting`);
  const byteProgress = makeByteProgress(stem, throttled);
  const text = await fetchText(url, byteProgress);
  if (throttled) throttled(`${stem}: packing ${type} (${text.length.toLocaleString()} chars)`);
  const sab = sabPack(text, type);
  if (progress) progress(`${stem}: ${formatBytes(sab.byteLength)} ready`);
  return sab;
}

async function handleLoadGrammar({ url }, progress) {
  const throttled = throttleProgress(progress);
  const stem = String(url).split('/').pop();
  if (throttled) throttled(`${stem}: starting`);
  const byteProgress = makeByteProgress(stem, throttled);
  const text = await fetchText(url, byteProgress);
  if (throttled) throttled(`${stem}: parsing .def`);
  const parsed = parseGrammar(text);
  if (throttled) throttled(`${stem}: packing grammar`);
  const sab = packGrammarToSAB(parsed);
  if (progress) progress(`${stem}: ${formatBytes(sab.byteLength)} ready`);
  return sab;
}

async function dispatch(kind, payload, progress) {
  switch (kind) {
    case 'load-raw-bytes':         return await handleLoadRawBytes(payload, progress);
    case 'load-native':            return await handleLoadNative(payload, progress);
    case 'load-grammar':           return await handleLoadGrammar(payload, progress);
    default:
      throw new Error(`resource-worker: unknown kind "${kind}"`);
  }
}

parentPort.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    if (IS_NODE) process.exit(0);
    else self.close();
    return;
  }
  const { jobId, kind, payload } = msg;
  const progress = (label) => {
    parentPort.postMessage({ jobId, progress: { label } });
  };
  try {
    const result = await dispatch(kind, payload, progress);
    parentPort.postMessage({ jobId, ok: true, result });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    parentPort.postMessage({
      jobId,
      ok: false,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack || null,
      },
    });
  }
});
