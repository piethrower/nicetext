// Edge-case test: wrapped-cover files with CRLF line endings.
// Files saved on Windows (or run through a CRLF-conscious editor) get
// every \n converted to \r\n. autoStrip should still detect and peel
// the wrapper. detectWrapper's regexes are line-based for several
// envelopes (markdown's ^# X\n\n, eml's ^From: ...\n, etc.), so CRLF
// can break detection in subtle ways.
//
// We test by manually constructing a CRLF-converted wrapper output and
// running it through autoStrip. If detection fails the recovered text
// will still contain the envelope's framing.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  applyStack, autoStrip, escapeTransform,
} from '../../js/src/cover-pipeline.js';

function streamFromBytes(bytes) {
  return new ReadableStream({
    start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
  });
}

async function streamToString(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

async function streamToBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const COVER = 'crlf-edge-cover\nsecond cover line\nthird line\n';

async function wrapToBytes(stack) {
  const escaped = streamFromBytes(new TextEncoder().encode(COVER)).pipeThrough(escapeTransform());
  const wrapped = applyStack(escaped, stack);
  return await streamToBytes(wrapped);
}

function lfToCrlf(bytes) {
  // Convert standalone \n to \r\n. Don't touch existing \r\n.
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0A) {
      const prev = i > 0 ? bytes[i - 1] : -1;
      if (prev !== 0x0D) out.push(0x0D);
    }
    out.push(bytes[i]);
  }
  return new Uint8Array(out);
}

// Markdown wrapper: header `# Note\n\n` becomes `# Note\r\n\r\n`. The
// recovered body still carries CRLF (the wrapper carried CRLF bytes).
test('autoStrip handles CRLF-converted markdown wrapper', async () => {
  const lf = await wrapToBytes([{ type: 'markdown', subject: 'Note' }]);
  const crlf = lfToCrlf(lf);
  const bare = await autoStrip(streamFromBytes(crlf));
  const recovered = await streamToString(bare);
  // Wrapper detected + stripped; body content survives. CRLF in body
  // stays CRLF. Reveal's tokenizer treats whitespace as PUNCT, so
  // CRLF doesn't change the decode.
  assert.ok(
    recovered === COVER || recovered === COVER.replace(/\n/g, '\r\n'),
    `markdown CRLF strip: got ${JSON.stringify(recovered.slice(0, 60))}`,
  );
});

// EML: `From: anon@...\n` becomes `From: anon@...\r\n`. The detection
// regex `^From: ` only checks the first line prefix; emlStripTransform
// already uses `\r?\n\r?\n` for the header/body separator. CRLF body
// passes through.
test('autoStrip handles CRLF-converted EML wrapper', async () => {
  const lf = await wrapToBytes([{ type: 'eml', subject: 'CrlfTest' }]);
  const crlf = lfToCrlf(lf);
  const bare = await autoStrip(streamFromBytes(crlf));
  const recovered = await streamToString(bare);
  assert.ok(
    recovered === COVER || recovered === COVER.replace(/\n/g, '\r\n'),
    `eml CRLF strip: got ${JSON.stringify(recovered.slice(0, 60))}`,
  );
});

// HTML: `<!DOCTYPE html>\n<html...>` becomes `<!DOCTYPE html>\r\n...`.
// Detection regex `^<!DOCTYPE html>` is case-insensitive prefix; CRLF
// after that doesn't affect the match.
test('autoStrip handles CRLF-converted HTML wrapper', async () => {
  const lf = await wrapToBytes([{ type: 'html', subject: 'CrlfTest' }]);
  const crlf = lfToCrlf(lf);
  const bare = await autoStrip(streamFromBytes(crlf));
  const recovered = await streamToString(bare);
  // We just want the cover content somewhere in the output; the
  // current strip uses textContent-style entity decode which may or
  // may not normalize CRLF. Accept either exact or CRLF-converted.
  assert.ok(
    recovered === COVER || recovered === lfToCrlf(new TextEncoder().encode(COVER)).reduce((s, b) => s + String.fromCharCode(b), ''),
    `recovered: ${JSON.stringify(recovered.slice(0, 100))}`,
  );
});

// Bare base64 detection uses isBase64LeadingLine, which checks chars
// against the BASE64 alphabet. \r is not in the alphabet, caller
// strips trailing \r before the check.
test('autoStrip handles CRLF-converted bare base64', async () => {
  const lf = await wrapToBytes([{ type: 'base64', filename: 'message' }]);
  const crlf = lfToCrlf(lf);
  const bare = await autoStrip(streamFromBytes(crlf));
  const recovered = await streamToString(bare);
  // base64 strip decodes the alphabet bytes; the body decoded back is
  // the original LF cover (the LF bytes were base64-encoded).
  assert.equal(recovered, COVER);
});
