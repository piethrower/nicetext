// Round-trip tests for envelopes. Each envelope's apply → strip
// must recover the original cover text exactly, plus the wrapped output
// must contain its claimed format's signature (so a viewer can render
// it as that file type).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  htmlApplyTransform, htmlStripTransform,
  emlApplyTransform, emlStripTransform,
  markdownApplyTransform, markdownStripTransform,
  pdfApplyTransform, pdfStripTransform,
} from '../../js/src/envelopes.js';

function streamFromBytes(bytes, chunkSize = 0) {
  if (chunkSize <= 0) {
    return new ReadableStream({
      start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
    });
  }
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
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

async function roundTrip(applyT, stripT, payloadStr, chunkSize) {
  const payload = new TextEncoder().encode(payloadStr);
  const wrapped = await streamToBytes(
    streamFromBytes(payload, chunkSize).pipeThrough(applyT),
  );
  const recovered = await streamToBytes(
    streamFromBytes(wrapped, chunkSize).pipeThrough(stripT),
  );
  return { wrapped, recovered: new TextDecoder().decode(recovered) };
}

const SAMPLES = [
  '',
  'hello',
  'short cover text without any special chars',
  'multi\nline\ncover\ntext',
  'with < and > and & embedded for HTML escape test',
  'with ( and ) and \\ embedded for PDF escape test',
  'unicode: café résumé 日本語 emoji 🎉',
  'a'.repeat(200) + '\n' + 'b'.repeat(200), // long lines
  ('line ' + 'x'.repeat(40) + '\n').repeat(80), // forces PDF multi-page
];

for (const sample of SAMPLES) {
  const tag = sample.length > 30 ? `${sample.length}-char` : JSON.stringify(sample);

  test(`html round-trip: ${tag}`, async () => {
    const { wrapped, recovered } = await roundTrip(
      htmlApplyTransform({ filename: 'message', subject: 'Note' }),
      htmlStripTransform(),
      sample,
    );
    const wrappedText = new TextDecoder().decode(wrapped);
    assert.match(wrappedText, /^<!DOCTYPE html>/, 'doctype present');
    assert.match(wrappedText, /<\/html>\s*$/, 'closing html tag present');
    assert.equal(recovered, sample);
  });

  test(`eml round-trip: ${tag}`, async () => {
    const { wrapped, recovered } = await roundTrip(
      emlApplyTransform({ filename: 'message', subject: 'Note' }),
      emlStripTransform(),
      sample,
    );
    const wrappedText = new TextDecoder().decode(wrapped);
    assert.match(wrappedText, /^From: anon@example\.com\r\n/, 'From header present');
    assert.match(wrappedText, /\r\nSubject: Note\r\n/, 'Subject header present');
    assert.match(wrappedText, /\r\nDate: Thu, 01 Jan 1970 00:00:00 \+0000\r\n/, 'Date is epoch zero');
    assert.equal(recovered, sample);
  });

  test(`markdown round-trip: ${tag}`, async () => {
    const { wrapped, recovered } = await roundTrip(
      markdownApplyTransform({ filename: 'message', subject: 'Note' }),
      markdownStripTransform(),
      sample,
    );
    const wrappedText = new TextDecoder().decode(wrapped);
    assert.match(wrappedText, /^# Note\n\n/, 'subject heading present');
    assert.equal(recovered, sample);
  });

  // (LaTeX round-trip removed 2026-05-17, latex envelope dropped.)
}

// PDF tests separately because cover is split by newlines and re-joined;
// trailing-newline-handling and PDF-string escapes need explicit checks.

test('pdf: wrapped output starts with %PDF-1.4 and ends with %%EOF', async () => {
  const { wrapped } = await roundTrip(
    pdfApplyTransform({ filename: 'message', subject: 'Note' }),
    pdfStripTransform(),
    'hello world',
  );
  const text = new TextDecoder('utf-8', { fatal: false }).decode(wrapped);
  assert.match(text, /^%PDF-1\.4\n/);
  assert.match(text, /%%EOF\n?$/);
});

test('pdf: cover round-trips simple text', async () => {
  const { recovered } = await roundTrip(
    pdfApplyTransform({ filename: 'message', subject: 'Note' }),
    pdfStripTransform(),
    'hello world',
  );
  assert.equal(recovered, 'hello world');
});

test('pdf: cover round-trips multi-line', async () => {
  const sample = 'first line\nsecond line\nthird line';
  const { recovered } = await roundTrip(
    pdfApplyTransform({ filename: 'message', subject: 'Note' }),
    pdfStripTransform(),
    sample,
  );
  assert.equal(recovered, sample);
});

test('pdf: cover with parens and backslashes round-trips', async () => {
  const sample = 'text with (paren) and \\backslash and (nested (paren))';
  const { recovered } = await roundTrip(
    pdfApplyTransform({ filename: 'message', subject: 'Note' }),
    pdfStripTransform(),
    sample,
  );
  assert.equal(recovered, sample);
});

test('pdf: long cover spans multiple pages', async () => {
  const sample = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
  const { wrapped, recovered } = await roundTrip(
    pdfApplyTransform({ filename: 'message', subject: 'Note' }),
    pdfStripTransform(),
    sample,
  );
  const wrappedText = new TextDecoder('utf-8', { fatal: false }).decode(wrapped);
  // 80 lines + subject + blank = 82 lines, /Count 2 pages at ~46 lines/page
  // (or whatever PDF_LINES_PER_PAGE works out to).
  const countMatch = /\/Count (\d+)/.exec(wrappedText);
  assert.ok(countMatch, '/Count present');
  assert.ok(parseInt(countMatch[1], 10) >= 2, 'multi-page output');
  assert.equal(recovered, sample);
});

test('html: cover with HTML special chars round-trips', async () => {
  const sample = 'text with <tag> and & ampersand and "quotes"';
  const { wrapped, recovered } = await roundTrip(
    htmlApplyTransform({ filename: 'message', subject: 'Note' }),
    htmlStripTransform(),
    sample,
  );
  const text = new TextDecoder().decode(wrapped);
  assert.ok(text.includes('&lt;tag&gt;'), 'tags entity-escaped');
  assert.ok(text.includes('&amp; ampersand'), 'ampersand entity-escaped');
  assert.equal(recovered, sample);
});

test('chunked input: html survives 7-byte chunks', async () => {
  const sample = 'a chunk-friendly cover with no special chars';
  const { recovered } = await roundTrip(
    htmlApplyTransform({ filename: 'message', subject: 'Note' }),
    htmlStripTransform(),
    sample,
    7,
  );
  assert.equal(recovered, sample);
});

test('chunked input: eml survives 5-byte chunks', async () => {
  const sample = 'line one\nline two\nline three';
  const { recovered } = await roundTrip(
    emlApplyTransform({ filename: 'message', subject: 'Note' }),
    emlStripTransform(),
    sample,
    5,
  );
  assert.equal(recovered, sample);
});
