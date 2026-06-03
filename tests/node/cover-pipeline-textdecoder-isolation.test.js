// Regression test for audit 2026-05-17 Finding 3.
//
// The cover-pipeline / envelopes / wrappers / cover-escape
// modules previously shared a single module-level TextDecoder instance.
// TextDecoder is stateful under {stream: true}, a partial-multi-byte
// buffered from one transform's last chunk leaked into the next,
// unrelated transform's first decode, silently corrupting bytes from
// the front of the recovered cover body.
//
// This test runs a sequence of round-trips on a cover whose body starts
// with a UTF-8 multi-byte sequence (`Café`). With the shared decoder,
// the 5th iteration failed (`rec=143` vs `expected=146`); 6th and on
// also failed. With per-factory decoders, every iteration round-trips
// cleanly.

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

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const COVER_BYTES = new TextEncoder().encode(
  'Café Naïve 北京 \u{1F600} ' + 'x'.repeat(120) + '\n',
);

async function escapedCover() {
  return streamToBytes(streamFromBytes(COVER_BYTES).pipeThrough(escapeTransform()));
}

async function wrapUnwrap(escaped, stack) {
  const wrapped = await streamToBytes(applyStack(streamFromBytes(escaped), stack));
  return streamToBytes(await autoStrip(streamFromBytes(wrapped)));
}

// One process runs 30 round-trips in sequence across several envelope +
// stack combinations. Pre-fix: failed at trial 5 (eml + [gzip, gzip])
// and several later trials. Post-fix: every trial passes.
test('cover-pipeline: 30 unicode-leading round-trips in sequence', async () => {
  const escaped = await escapedCover();
  const combos = [
    { env: 'eml', stack: [] },
    { env: 'eml', stack: ['gzip'] },
    { env: 'eml', stack: ['base64'] },
    { env: 'eml', stack: ['uuencode'] },
    { env: 'eml', stack: ['gzip', 'gzip'] },
    { env: 'eml', stack: ['gzip', 'base64'] },
    { env: 'html', stack: [] },
    { env: 'html', stack: ['gzip'] },
    { env: 'html', stack: ['base64'] },
    { env: 'html', stack: ['uuencode'] },
    { env: 'html', stack: ['gzip', 'gzip'] },
    { env: 'html', stack: ['gzip', 'base64'] },
    { env: 'pdf', stack: [] },
    { env: 'pdf', stack: ['gzip'] },
    { env: 'pdf', stack: ['base64'] },
    { env: 'pdf', stack: ['uuencode'] },
    { env: 'pdf', stack: ['gzip', 'gzip'] },
    { env: 'pdf', stack: ['gzip', 'base64'] },
    { env: 'markdown', stack: [] },
    { env: 'markdown', stack: ['gzip'] },
    { env: 'markdown', stack: ['base64'] },
    { env: 'markdown', stack: ['uuencode'] },
    { env: 'markdown', stack: ['gzip', 'gzip'] },
    { env: 'markdown', stack: ['gzip', 'base64'] },
    // (latex envelope dropped 2026-05-17, see audit Finding 1 redesign)
  ];
  for (let i = 0; i < combos.length; i++) {
    const { env, stack: stackTypes } = combos[i];
    const layers = [
      { type: env, filename: 'm', subject: 'S' },
      ...stackTypes.map(t => ({ type: t, filename: `m.${env}`, subject: 'S' })),
    ];
    const recovered = await wrapUnwrap(escaped, layers);
    assert.ok(
      bytesEqual(escaped, recovered),
      `trial ${i + 1} (env=${env}, stack=[${stackTypes.join(',')}]): `
        + `recovered length ${recovered.length} != escaped length ${escaped.length}`,
    );
  }
});

// Smaller, faster smoke for the specific case that originally failed
// (trial 5 of the matrix above): eml envelope + [gzip, gzip] stack on
// a multi-byte-leading cover, run 10 times in one process.
test('cover-pipeline: eml + [gzip, gzip] multi-byte cover survives sequential calls', async () => {
  const escaped = await escapedCover();
  const layers = [
    { type: 'eml', filename: 'm', subject: 'S' },
    { type: 'gzip', filename: 'm.eml', subject: 'S' },
    { type: 'gzip', filename: 'm.eml.gz', subject: 'S' },
  ];
  for (let i = 0; i < 10; i++) {
    const recovered = await wrapUnwrap(escaped, layers);
    assert.equal(
      recovered.length, escaped.length,
      `iteration ${i + 1}: recovered ${recovered.length} != escaped ${escaped.length}`,
    );
    assert.ok(bytesEqual(escaped, recovered), `iteration ${i + 1}: byte mismatch`);
  }
});

// Audit 2026-05-17 Finding 2: bare covers whose first line is a short
// alphanumeric word (LF or CRLF) used to be misdetected as base64 by
// autoStrip, then the base64 strip decoded the entire cover as base64
// garbage. Fix: isBase64LeadingLine now requires length-mod-4 OR
// trailing `=`, AND detectWrapper requires a second base64-shaped line
// (unless line 1 is terminal-padded). Real base64 wrappers satisfy
// these; natural prose essentially never does.
//
// These covers must round-trip exactly through the zero-wrap path
// (i.e., autoStrip on bare bytes returns the bare bytes unchanged
// after escape).
test('cover-pipeline: CRLF cover with short alphanumeric first word is not misdetected as base64', async () => {
  const enc = new TextEncoder();
  const cases = [
    'line1\r\nline2\r\nline3\r\n',
    'Hello\r\nworld\r\n',
    'abc\r\ndef\r\nghi\r\n',
    'cat\r\ndog\r\n',
  ];
  for (const cover of cases) {
    const coverBytes = enc.encode(cover);
    const escaped = await streamToBytes(
      streamFromBytes(coverBytes).pipeThrough(escapeTransform()),
    );
    const recovered = await streamToBytes(await autoStrip(streamFromBytes(escaped)));
    assert.ok(
      bytesEqual(escaped, recovered),
      `CRLF cover ${JSON.stringify(cover)} not preserved: `
        + `escaped=${escaped.length}, recovered=${recovered.length}`,
    );
  }
});

test('cover-pipeline: LF cover with short alphanumeric-only first word is not misdetected as base64', async () => {
  const enc = new TextEncoder();
  const cases = [
    // 4-char first word, passes mod-4 alone, needs the second-line gate.
    'abcd\nefgh ijkl\n',
    'word\nsecond line with spaces.\n',
    // 8-char first word, also passes mod-4 alone.
    'greeting\nsecond line of cover.\n',
    // Naturally-shaped covers with short first lines.
    'A.\nThe quick brown fox.\n',
  ];
  for (const cover of cases) {
    const coverBytes = enc.encode(cover);
    const escaped = await streamToBytes(
      streamFromBytes(coverBytes).pipeThrough(escapeTransform()),
    );
    const recovered = await streamToBytes(await autoStrip(streamFromBytes(escaped)));
    assert.ok(
      bytesEqual(escaped, recovered),
      `LF cover ${JSON.stringify(cover)} not preserved: `
        + `escaped=${escaped.length}, recovered=${recovered.length}`,
    );
  }
});

// Audit 2026-05-17 Finding 1: bare covers whose first line is prose
// starting with a program-envelope marker (`<?php`, `package main`,
// `import base64`, `#include <iostream>`, `require 'base64'`,
// `#!/usr/bin/perl`, `#!/bin/bash`, `#!/usr/bin/env bash`,
// `import java.util.Base64;`) used to slip past the escape pass
// (which required exact-line match) and trigger the detector (which
// matched the prefix without an end-of-line anchor). The program-
// envelope strip would then look for the envelope's interior payload
// markers, fail to find them, and emit zero bytes, the cover was
// silently shredded.
//
// Fix: the escape pass's LINE_MARKER_REGEXES for program envelopes
// now use \b instead of $, matching the detector's reach. Any prose
// line starting with these tokens gets the ` ! ` disambiguator and
// the detector no longer fires.
test('cover-pipeline: prose starting with program-envelope marker survives autoStrip', async () => {
  const enc = new TextEncoder();
  const cases = [
    '<?php is a server language used by many sites.\n',
    'package main contains the entry point of every Go program.\n',
    'import base64 module if you need it.\n',
    '#include <iostream> at the top of every file.\n',
    "require 'base64' in your Ruby code.\n",
    '#!/usr/bin/perl is the typical perl shebang line.\n',
    '#!/bin/bash starts a bash script.\n',
    '#!/usr/bin/env bash is the more portable variant.\n',
    'import java.util.Base64; in any Java file enables base64 helpers.\n',
  ];
  for (const cover of cases) {
    const coverBytes = enc.encode(cover);
    const escaped = await streamToBytes(
      streamFromBytes(coverBytes).pipeThrough(escapeTransform()),
    );
    const recovered = await streamToBytes(await autoStrip(streamFromBytes(escaped)));
    assert.ok(
      bytesEqual(escaped, recovered),
      `prose cover ${JSON.stringify(cover.slice(0, 40))} shredded by autoStrip: `
        + `escaped=${escaped.length}, recovered=${recovered.length}`,
    );
  }
});

// Counter-test: real base64 wrappers must still be detected and
// stripped. The fix tightens the heuristic; it must not break the
// happy path.
test('cover-pipeline: real bare-base64 wrappers still round-trip', async () => {
  const enc = new TextEncoder();
  // A cover that survives the lexer round-trip: plain text, multi-line.
  const cover = 'the cat sat on the mat and looked at a tiny brown mouse.\n'.repeat(3);
  const escaped = await streamToBytes(
    streamFromBytes(enc.encode(cover)).pipeThrough(escapeTransform()),
  );
  const wrapped = await streamToBytes(
    applyStack(streamFromBytes(escaped), [{ type: 'base64', filename: 'm' }]),
  );
  const recovered = await streamToBytes(await autoStrip(streamFromBytes(wrapped)));
  assert.ok(
    bytesEqual(escaped, recovered),
    `bare-base64 wrapper not detected: escaped=${escaped.length}, recovered=${recovered.length}`,
  );
});
