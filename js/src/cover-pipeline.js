// cover-pipeline.js
//
// Composer for the cover-text post-processor stack. Two entry points:
//
//   applyStack(inputStream, stack) -> ReadableStream
//     Pipes `inputStream` through each layer of `stack` in order. Each
//     layer is { type, filename, subject } where `type` is one of
//     'gzip' | 'base64' | 'uuencode' | 'html' | 'pdf' | 'eml' |
//     'markdown'. Empty stack returns the input unchanged.
//
//   autoStrip(inputStream) -> Promise<ReadableStream>
//     Iteratively detects the wrapper at the head of the stream via
//     the shared HEAD_MARKERS registry (cover-markers.js), pipes
//     through the matching strip TransformStream, and repeats.
//     Terminates when no known wrapper marker matches the new head,
//     yielding the bare cover stream. The escape pass on the send side
//     (cover-escape.js) is what guarantees this terminates cleanly on
//     covers that legitimately start with text resembling a marker.
//
// Re-exports `escapeTransform` from cover-escape.js for one-stop
// imports.

import {
  gzipApplyTransform, gzipStripTransform,
  base64ApplyTransform, base64StripTransform,
  uuencodeApplyTransform, uuencodeStripTransform,
} from './wrappers.js';
import {
  htmlApplyTransform, htmlStripTransform,
  htmlActiveApplyTransform,
  pdfApplyTransform, pdfStripTransform,
  emlApplyTransform, emlStripTransform,
  markdownApplyTransform, markdownStripTransform,
  pythonApplyTransform, pythonStripTransform,
  javascriptApplyTransform, javascriptStripTransform,
  cppApplyTransform, cppStripTransform,
  javaApplyTransform, javaStripTransform,
  nroffApplyTransform, nroffStripTransform,
  xmlApplyTransform, xmlStripTransform,
  perlApplyTransform, perlStripTransform,
  phpApplyTransform, phpStripTransform,
  rubyApplyTransform, rubyStripTransform,
  bashApplyTransform, bashStripTransform,
  goApplyTransform, goStripTransform,
} from './envelopes.js';
import { escapeTransform } from './cover-escape.js';
import { matchHead, HEAD_PEEK_BYTES } from './cover-markers.js';

export { escapeTransform };

export const KNOWN_LAYER_TYPES = [
  // Wrapper layers (wrappers.js)
  'gzip', 'base64', 'uuencode',
  // Document envelopes (envelopes.js)
  'html', 'html-active', 'pdf', 'eml', 'markdown',
  'nroff', 'xml',
  // Program envelopes (envelopes.js)
  'python', 'javascript', 'cpp', 'java', 'perl', 'php', 'ruby', 'bash', 'go',
];

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function applyFactoryFor(layer) {
  const opts = {
    filename: layer.filename || 'message',
    subject: layer.subject || 'Note',
  };
  switch (layer.type) {
    case 'gzip':         return gzipApplyTransform(opts);
    case 'base64':       return base64ApplyTransform(opts);
    case 'uuencode':     return uuencodeApplyTransform(opts);
    case 'html':         return htmlApplyTransform(opts);
    case 'html-active':  return htmlActiveApplyTransform(opts);
    case 'pdf':          return pdfApplyTransform(opts);
    case 'eml':          return emlApplyTransform(opts);
    case 'markdown':     return markdownApplyTransform(opts);
    case 'nroff':        return nroffApplyTransform(opts);
    case 'xml':          return xmlApplyTransform(opts);
    case 'python':       return pythonApplyTransform(opts);
    case 'javascript':   return javascriptApplyTransform(opts);
    case 'cpp':          return cppApplyTransform(opts);
    case 'java':         return javaApplyTransform(opts);
    case 'perl':         return perlApplyTransform(opts);
    case 'php':          return phpApplyTransform(opts);
    case 'ruby':         return rubyApplyTransform(opts);
    case 'bash':         return bashApplyTransform(opts);
    case 'go':           return goApplyTransform(opts);
    default: throw new Error(`applyStack: unknown layer type "${layer.type}"`);
  }
}

function stripFactoryFor(wrapper) {
  switch (wrapper) {
    case 'gzip':         return gzipStripTransform();
    case 'base64':       return base64StripTransform();
    case 'uuencode':     return uuencodeStripTransform();
    case 'html':         return htmlStripTransform();         // handles both plain and active
    case 'pdf':          return pdfStripTransform();
    case 'eml':          return emlStripTransform();
    case 'markdown':     return markdownStripTransform();
    case 'nroff':        return nroffStripTransform();
    case 'xml':          return xmlStripTransform();
    case 'python':       return pythonStripTransform();
    case 'javascript':   return javascriptStripTransform();
    case 'cpp':          return cppStripTransform();
    case 'java':         return javaStripTransform();
    case 'perl':         return perlStripTransform();
    case 'php':          return phpStripTransform();
    case 'ruby':         return rubyStripTransform();
    case 'bash':         return bashStripTransform();
    case 'go':           return goStripTransform();
    default: throw new Error(`autoStrip: unknown wrapper "${wrapper}"`);
  }
}

// Detect which wrapper format the leading bytes belong to. Returns the
// wrapper name (string) or null when no known marker matches, meaning
// the stream is already bare cover.
//
// All marker logic lives in the shared registry (cover-markers.js) so
// escape and detector cannot drift apart. Audit 2026-05-17 Findings 1
// and 2 both came from that drift; the registry eliminates the bug
// class structurally.
function detectWrapper(peeked) {
  return matchHead(peeked);
}

// Read up to `n` bytes from `stream`, returning the peeked buffer plus
// a new ReadableStream that re-emits those bytes followed by anything
// still buffered in the original. The original stream is consumed.
async function peekAndReconstruct(stream, n) {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let finished = false;
  while (buf.length < n) {
    const { value, done } = await reader.read();
    if (done) { finished = true; break; }
    if (value && value.length > 0) buf = concat(buf, value);
  }
  reader.releaseLock();
  const rest = new ReadableStream({
    async start(controller) {
      if (buf.length > 0) controller.enqueue(buf);
      if (finished) { controller.close(); return; }
      const r2 = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await r2.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } finally {
        controller.close();
        try { r2.releaseLock(); } catch {}
      }
    },
  });
  return { peeked: buf, rest };
}

export function applyStack(inputStream, stack) {
  let s = inputStream;
  for (const layer of stack || []) {
    s = s.pipeThrough(applyFactoryFor(layer));
  }
  return s;
}

// Peek window large enough for every marker in the registry. Program
// envelopes have the longest prefixes (ruby's full apply prefix is
// ~110 chars; markdown's title-plus-blank-line can be ~135 chars).
// Sized for headroom, sourced from cover-markers.js.
const AUTOSTRIP_PEEK_BYTES = HEAD_PEEK_BYTES;

// Drain a ReadableStream into a single Uint8Array. Used by detectLayers
// (needs re-readable bytes for the layer-picker UX) and by the fallback
// path (needs to inspect the full output before deciding whether to
// fall back to raw input).
async function streamToBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.length > 0) { chunks.push(value); total += value.length; }
  }
  try { reader.releaseLock(); } catch {}
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function bytesToStream(bytes) {
  return new ReadableStream({
    start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
  });
}

// Walk the wrapper chain by detect-then-strip in a loop, recording the
// chain. Internal helper used by both autoStrip (silent) and
// detectLayers (which returns the chain for UI display).
async function chainDetect(source, opts = {}) {
  const maxIterations = opts.maxIterations ?? 10;
  const layers = [];
  for (let i = 0; i < maxIterations; i++) {
    const { peeked, rest } = await peekAndReconstruct(source, AUTOSTRIP_PEEK_BYTES);
    const wrapper = detectWrapper(peeked);
    if (!wrapper) return { layers, source: rest };
    layers.push(wrapper);
    source = rest.pipeThrough(stripFactoryFor(wrapper));
  }
  return { layers, source };
}

export async function autoStrip(inputStream, opts = {}) {
  const { source } = await chainDetect(inputStream, opts);
  return source;
}

// Detect the wrapper chain on `inputStream` without committing to a
// specific strip. Returns:
//   { layers, bytes }
// where `layers` is the ordered wrapper-name chain (top-to-bottom; same
// order autoStrip would peel) and `bytes` is the buffered original
// input, re-readable. The picker UI shows `layers` as checkboxes; the
// caller then passes the user-chosen subset to applyStrips(bytes, chosen).
//
// Memory cost: the input is fully buffered (Uint8Array of input.length).
// Picker interaction needs re-readable input, and the typical cover-share
// flow is one detect-then-strip per load (not per byte), so buffering at
// this boundary is acceptable.
export async function detectLayers(inputStream, opts = {}) {
  const bytes = await streamToBytes(inputStream);
  const { layers } = await chainDetect(bytesToStream(bytes), opts);
  return { layers, bytes };
}

// Factory-based detectLayers: avoids buffering the full input. Caller
// passes a streamFactory function that returns a fresh ReadableStream
// each call (e.g., `() => file.stream()`). chainDetect consumes one
// stream from the factory to walk the wrapper chain; the consumed
// stream is cancelled. The caller then constructs the stripped input
// for downstream consumers via a SECOND factory call plus applyStripsToStream.
//
// Memory cost: O(HEAD_PEEK_BYTES * num_layers) for the peek buffers
// during detection. Crucially does NOT buffer the file body, suitable
// for pipeline-mode covers that may be >100MB.
export async function detectLayersFromFactory(streamFactory, opts = {}) {
  const stream = streamFactory();
  const { layers, source } = await chainDetect(stream, opts);
  try { await source.cancel(); } catch {}
  return layers;
}

// Strip the named layers (in order) from `bytes`. Returns a
// ReadableStream of the stripped output. Caller typically passes
// the output of detectLayers (possibly with some layers omitted).
// Unknown layer names throw.
export function applyStrips(bytes, layerNames) {
  return applyStripsToStream(bytesToStream(bytes), layerNames);
}

// Stream-in variant of applyStrips. Used by pipeline-mode (where the
// input is the file's web stream, not buffered bytes), pipes through
// the named strip transforms in order.
export function applyStripsToStream(inputStream, layerNames) {
  let s = inputStream;
  for (const name of layerNames || []) s = s.pipeThrough(stripFactoryFor(name));
  return s;
}

// applyStrips with empty/decode-failure/non-UTF8 fallback. If the strip
// chain emits zero bytes, throws mid-stream, or produces non-UTF-8
// bytes, returns the ORIGINAL input bytes as a stream instead. Used by
// the picker UX: when the user picks a chain that doesn't actually work
// (or unchecks layers in an order that decompresses to garbage),
// falling back to raw input beats silently emitting an empty cover.
//
// Returns: { bytes: Uint8Array, fellBack: boolean, error?: Error }
//   bytes: the stripped result if successful, otherwise original input.
//   fellBack: true if we fell back to raw input.
//   error: set when fellBack is true and the cause was an exception.
export async function stripWithFallback(bytes, layerNames) {
  let out;
  try {
    out = await streamToBytes(applyStrips(bytes, layerNames));
  } catch (error) {
    return { bytes, fellBack: true, error };
  }
  if (out.length === 0) {
    return { bytes, fellBack: true };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(out);
  } catch (error) {
    return { bytes, fellBack: true, error };
  }
  return { bytes: out, fellBack: false };
}
