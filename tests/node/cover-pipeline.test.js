// Round-trip tests for the apply-stack composer and auto-strip driver.
// Confirms:
//   - empty stack passes the cover through unchanged
//   - single-layer stacks round-trip for every layer type
//   - multi-layer stacks (mixed format + envelope) round-trip
//   - escape + applyStack on the send side, autoStrip on the receive
//     side, recovers the original cover

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  applyStack, autoStrip, escapeTransform, KNOWN_LAYER_TYPES,
} from '../../js/src/cover-pipeline.js';

function streamFromString(s) {
  const bytes = new TextEncoder().encode(s);
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

async function fullRoundTrip(cover, stack) {
  const escaped = streamFromString(cover).pipeThrough(escapeTransform());
  const wrapped = applyStack(escaped, stack);
  const bare = await autoStrip(wrapped);
  return await streamToString(bare);
}

test('empty stack: cover passes through unchanged (after escape)', async () => {
  const cover = 'hello world\nordinary cover\n';
  const recovered = await fullRoundTrip(cover, []);
  assert.equal(recovered, cover);
});

test('known layer types is the expected set (latex dropped 2026-05-17)', () => {
  assert.deepEqual(
    [...KNOWN_LAYER_TYPES].sort(),
    [
      'base64', 'bash', 'cpp', 'eml', 'go', 'gzip', 'html', 'html-active',
      'java', 'javascript', 'markdown', 'nroff', 'pdf', 'perl',
      'php', 'python', 'ruby', 'uuencode', 'xml',
    ],
  );
});

const COVER_TEXT = 'first line of cover\nsecond line\nthird line with (parens) and <tags> & ampersands\n';

for (const layerType of [
  // Formats
  'gzip', 'base64', 'uuencode',
  // Document envelopes
  'html', 'html-active', 'eml', 'markdown', 'pdf', 'nroff', 'xml',
  // Program envelopes
  'python', 'javascript', 'cpp', 'java', 'perl', 'php', 'ruby', 'bash', 'go',
]) {
  test(`single-layer round-trip: ${layerType}`, async () => {
    const recovered = await fullRoundTrip(COVER_TEXT, [{ type: layerType, filename: 'note.bin', subject: 'Test' }]);
    assert.equal(recovered, COVER_TEXT);
  });
}

test('two-layer stack [gzip, base64]: round-trips', async () => {
  const recovered = await fullRoundTrip(COVER_TEXT, [
    { type: 'gzip', filename: 'message' },
    { type: 'base64', filename: 'message.gz' },
  ]);
  assert.equal(recovered, COVER_TEXT);
});

test('three-layer stack [gzip, base64, gzip]: round-trips', async () => {
  const recovered = await fullRoundTrip(COVER_TEXT, [
    { type: 'gzip', filename: 'message' },
    { type: 'base64', filename: 'message.gz' },
    { type: 'gzip', filename: 'message.gz.b64' },
  ]);
  assert.equal(recovered, COVER_TEXT);
});

test('envelope + format stack [html, gzip, base64]: round-trips', async () => {
  const recovered = await fullRoundTrip(COVER_TEXT, [
    { type: 'html', subject: 'Note' },
    { type: 'gzip', filename: 'message.html' },
    { type: 'base64', filename: 'message.html.gz' },
  ]);
  assert.equal(recovered, COVER_TEXT);
});

test('full 5-layer stack [pdf, gzip, b64, uuencode, gzip]: round-trips', async () => {
  const recovered = await fullRoundTrip(COVER_TEXT, [
    { type: 'pdf', subject: 'Memo' },
    { type: 'gzip', filename: 'memo.pdf' },
    { type: 'base64', filename: 'memo.pdf.gz' },
    { type: 'uuencode', filename: 'memo.pdf.gz.b64' },
    { type: 'gzip', filename: 'memo.pdf.gz.b64.uue' },
  ]);
  // PDF apply re-flows the cover by lines; round-trip preserves
  // content but not necessarily the trailing newline.
  assert.ok(recovered.startsWith(COVER_TEXT.trimEnd()),
    `5-layer round-trip mismatch: got ${JSON.stringify(recovered.slice(0, 80))}`);
});

test('cover with format-marker-shaped lines in body survives round-trip unchanged', async () => {
  // A cover whose BODY happens to contain lines that look like wrapper
  // markers. After the 2026-05-17 redesign, escape is head-only; body
  // lines no longer get ` ! ` prepended. Each apply transform handles
  // its own body safety internally (here gzip just binary-encodes the
  // bytes; the body lines round-trip unchanged inside the gzip envelope).
  const trickyCover = [
    'normal first line',
    'begin 644 something',
    'natural body content',
    '.SH DESCRIPTION',
    'middle content',
    '<?xml version="1.0"?>',
    '%%EOF',
    'tail content',
  ].join('\n') + '\n';
  const recovered = await fullRoundTrip(trickyCover, [
    { type: 'gzip', filename: 'message' },
  ]);
  assert.equal(recovered, trickyCover);
});

test('cover whose HEAD looks like a wrapper marker gets disambiguator prepended', async () => {
  // Cover starts with `<!DOCTYPE html>`, bare-cover autoStrip would
  // fire `html` detection on this and shred the content. The head-only
  // escape pass prepends ` ! ` so the recipient's autoStrip sees
  // ` ! <!DOCTYPE html>…` and treats it as bare cover. The ` ! ` reads
  // as WHITESPACE-PUNCT-WHITESPACE to the decoder (0 bits) so the
  // payload survives untouched.
  const cover = '<!DOCTYPE html>\nfake html in prose\n';
  const escaped = streamFromString(cover).pipeThrough(escapeTransform());
  const bare = await autoStrip(escaped);
  const recovered = await streamToString(bare);
  assert.equal(recovered, ' ! <!DOCTYPE html>\nfake html in prose\n');
});

test('autoStrip on bare cover (no wrapper) returns it unchanged', async () => {
  const cover = 'natural cover text\nwith multiple lines\n';
  const escaped = streamFromString(cover).pipeThrough(escapeTransform());
  const bare = await autoStrip(escaped);
  const recovered = await streamToString(bare);
  assert.equal(recovered, cover);
});

test('autoStrip is idempotent: bare cover survives multiple autoStrip calls', async () => {
  const cover = 'simple cover\n';
  const escaped = streamFromString(cover).pipeThrough(escapeTransform());
  const first = await autoStrip(escaped);
  // pipe the bare output through autoStrip again, should be unchanged.
  const second = await autoStrip(first);
  const recovered = await streamToString(second);
  assert.equal(recovered, cover);
});
