// Round-trip matrix for the cover-share pipeline. Locks audit
// 2026-05-17 Findings 1, 2, 3 against regression.
//
// For every UI-permissible envelope × format-stack combination
// (17 envelopes × 28 stacks = 476 combos per cover; 21 cover shapes
// chosen to exercise every code path including the adversarial
// prose-prefix and CRLF cases that triggered the original bugs).
// One test() per cover so TAP progress shows roughly one event per
// 1-2 seconds. ~9,996 trials total; ~30s wall on a modern laptop.
//
// Lifted from tmp/probe-audit-cover-matrix.mjs (the audit probe);
// promoted here so the cover-share regression surface is part of
// every `npm test` run going forward.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  applyStack, autoStrip, escapeTransform,
} from '../../js/src/cover-pipeline.js';

const ENVELOPES = [
  // (latex hard-dropped 2026-05-17)
  'none', 'eml', 'html', 'html-active', 'markdown', 'nroff',
  'pdf', 'xml', 'bash', 'cpp', 'go', 'java', 'javascript', 'perl',
  'php', 'python', 'ruby',
];
const STACK_LAYERS = ['gzip', 'base64', 'uuencode'];
const STACK_CAP = 5;

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bytesToStream(bytes) {
  return new ReadableStream({
    start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
  });
}
async function streamToBytes(stream) {
  const r = stream.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function applyEscape(coverBytes) {
  return streamToBytes(bytesToStream(coverBytes).pipeThrough(escapeTransform()));
}
async function wrap(escapedBytes, stack) {
  return streamToBytes(applyStack(bytesToStream(escapedBytes), stack));
}
async function unwrap(wrappedBytes) {
  return streamToBytes(await autoStrip(bytesToStream(wrappedBytes)));
}

// Mirror wrapBuildLayers() in js/app.js: envelope innermost, format
// stack outward. `envelope === 'none'` skips the envelope layer.
function buildLayers(envelope, stackTypes, filename, subject) {
  const layers = [];
  let currentName = filename;
  if (envelope !== 'none') {
    layers.push({ type: envelope, filename: currentName, subject });
    currentName = `${currentName}.${envelope}`;
  }
  for (const t of stackTypes) {
    layers.push({ type: t, filename: currentName, subject });
    currentName = `${currentName}.${t}`;
  }
  return layers;
}

// Every ordered stack of length 0..maxDepth from STACK_LAYERS.
function* allStacks(maxDepth) {
  yield [];
  let prev = [[]];
  for (let d = 1; d <= maxDepth; d++) {
    const next = [];
    for (const tail of prev) {
      for (const t of STACK_LAYERS) next.push([t, ...tail]);
    }
    for (const s of next) yield s;
    prev = next;
  }
}

// Per-envelope combos: dense for depths 0-2 (1+3+9=13 stacks), sampled
// for depths 3-5 (5 patterns × 3 depths = 15 stacks). 28 stacks per
// envelope.
function combosForEnvelope(env) {
  const dense = [];
  for (const stack of allStacks(2)) dense.push({ env, stack });
  const sampled = [];
  for (let d = 3; d <= STACK_CAP; d++) {
    sampled.push({ env, stack: Array(d).fill('gzip') });
    sampled.push({ env, stack: Array(d).fill('base64') });
    sampled.push({ env, stack: Array(d).fill('uuencode') });
    sampled.push({ env, stack: Array.from({ length: d }, (_, i) => ['gzip', 'base64'][i % 2]) });
    sampled.push({ env, stack: Array.from({ length: d }, (_, i) => STACK_LAYERS[i % 3]) });
  }
  return [...dense, ...sampled];
}

const ALL_COMBOS = ENVELOPES.flatMap(combosForEnvelope);

// 21 cover shapes, natural + adversarial.
const COVERS = {
  empty:           '',
  tiny:            'Hello, world.\n',
  twoLines:        'Line one.\nLine two.\n',
  unicode:         'Café Naïve 北京 \u{1F600} ' + 'x'.repeat(120) + '\n',
  paragraph:       'The cat sat on the mat. '.repeat(40) + '\n',
  manyShortLines:  Array.from({ length: 300 }, (_, i) => `Sentence number ${i + 1}.`).join('\n') + '\n',
  kbCover:         ('The quick brown fox jumps over the lazy dog. ').repeat(2000),  // ~90 KB
  // Adversarial: covers that legitimately START with or CONTAIN marker
  // shapes. The escape pass head-only defense + per-apply body-safety
  // must keep these round-tripping.
  marker_doctype:  '<!DOCTYPE html>\nfake html-shaped cover.\n',
  marker_pdf:      '%PDF-1.4\nfake pdf-shaped cover.\n',
  marker_from:     'From: sender\nfake eml-shaped cover.\n',
  marker_md:       '# Subject heading\n\nbody starts here.\n',
  marker_latex:    '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
  marker_uue:      'begin 644 thing.txt\nM-data line-\nend\n',
  marker_xml:      '<?xml version="1.0"?>\n<note/>\n',
  marker_nroff:    '.TH X 7 "now" "" ""\n.SH NAME\nx \\- thing\n.SH DESCRIPTION\nbody\n',
  marker_php:      '<?php echo "x"; ?>\n',
  marker_bash:     '#!/bin/bash\necho hi\n',
  bare_base64:     'aGVsbG8gd29ybGQ=\nthen prose.\n',
  pdfTjEcho:       '(suspicious) Tj on its own line.\n',
  cdataClose:      'Some prose. ]]> more prose.\n',
  crlf:            'line1\r\nline2\r\nline3\r\n',
};

const enc = new TextEncoder();

// One test() per cover. ~476 combos per cover ≈ 1-2s each.
// Round-trip assertion: bytes after wrap+unwrap equal bytes after
// escape (NOT the raw cover, the escape pass intentionally prepends
// ` ! ` to covers whose head matches a known marker, and that ` ! `
// persists into the recovered bytes).
for (const [coverName, coverText] of Object.entries(COVERS)) {
  test(`cover-pipeline matrix: ${coverName}, ${ALL_COMBOS.length} envelope×stack combos`, async (ctx) => {
    const coverBytes = enc.encode(coverText);
    const escaped = await applyEscape(coverBytes);
    const failures = [];
    for (let i = 0; i < ALL_COMBOS.length; i++) {
      const combo = ALL_COMBOS[i];
      const layers = buildLayers(combo.env, combo.stack, 'message', 'Subject');
      try {
        const wrapped = await wrap(escaped, layers);
        const recovered = await unwrap(wrapped);
        if (!bytesEqual(escaped, recovered)) {
          failures.push({
            combo: `env=${combo.env},stack=[${combo.stack.join(',')}]`,
            escLen: escaped.length,
            recLen: recovered.length,
          });
        }
      } catch (e) {
        failures.push({
          combo: `env=${combo.env},stack=[${combo.stack.join(',')}]`,
          error: e?.message || String(e),
        });
      }
      // Live N/M sub-progress for the browser renderer. Cadence of 16
      // keeps the event load light (~30 events per cover) while still
      // ticking every ~250 ms on a typical run.
      if ((i + 1) % 16 === 0 || i + 1 === ALL_COMBOS.length) {
        await ctx.progress({ done: i + 1, total: ALL_COMBOS.length, label: 'combos' });
      }
    }
    assert.equal(
      failures.length, 0,
      `${failures.length} of ${ALL_COMBOS.length} combos failed for cover '${coverName}'.\n`
        + `First 5: ${JSON.stringify(failures.slice(0, 5), null, 2)}`,
    );
  });
}
