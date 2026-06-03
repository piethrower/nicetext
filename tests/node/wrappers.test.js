// Round-trip tests for wrappers (gzip, base64, uuencode) as
// TransformStreams. Each wrapper's apply → strip pipeline must
// reproduce the original byte stream exactly, across a range of
// payload sizes including edge-of-chunk boundaries (multiples of 3
// for base64, 45 for uuencode).

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import {
  gzipApplyTransform, gzipStripTransform,
  base64ApplyTransform, base64StripTransform,
  uuencodeApplyTransform, uuencodeStripTransform,
} from '../../js/src/wrappers.js';

function bytesFromString(s) {
  return new TextEncoder().encode(s);
}

function bytesFromPattern(n, seed = 0x42) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xFF;
  }
  return out;
}

function streamFromBytes(bytes, chunkSize = 0) {
  if (chunkSize <= 0) {
    return new ReadableStream({
      start(c) { if (bytes.length) c.enqueue(bytes); c.close(); },
    });
  }
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        c.enqueue(bytes.slice(i, i + chunkSize));
      }
      c.close();
    },
  });
}

async function streamToBytes(stream) {
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
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

async function roundTrip(applyTransform, stripTransform, payload, chunkSize) {
  const wrapped = await streamToBytes(
    streamFromBytes(payload, chunkSize).pipeThrough(applyTransform),
  );
  const recovered = await streamToBytes(
    streamFromBytes(wrapped, chunkSize).pipeThrough(stripTransform),
  );
  return { wrapped, recovered };
}

const SIZES = [0, 1, 2, 3, 4, 44, 45, 46, 100, 1000, 4096];

for (const size of SIZES) {
  test(`gzip: round-trip ${size}-byte payload`, async () => {
    const payload = bytesFromPattern(size);
    const { wrapped, recovered } = await roundTrip(
      gzipApplyTransform({ filename: 'message' }),
      gzipStripTransform(),
      payload,
    );
    assert.equal(wrapped[0], 0x1F, 'gzip magic byte 0');
    assert.equal(wrapped[1], 0x8B, 'gzip magic byte 1');
    assert.equal(wrapped[3] & 0x08, 0x08, 'FNAME flag set');
    assert.equal(recovered.length, payload.length, `recovered length ${recovered.length} vs payload ${payload.length}`);
    for (let i = 0; i < payload.length; i++) {
      assert.equal(recovered[i], payload[i], `byte ${i} mismatch`);
    }
  });

  test(`base64: round-trip ${size}-byte payload`, async () => {
    const payload = bytesFromPattern(size);
    const { wrapped, recovered } = await roundTrip(
      base64ApplyTransform(),
      base64StripTransform(),
      payload,
    );
    const wrappedText = new TextDecoder().decode(wrapped);
    // Bare base64 (Linux-compatible): alphabet only, 76-char wrap, no
    // PEM framing.
    for (const line of wrappedText.split('\n')) {
      if (line.length === 0) continue;
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(line), `line not pure base64: ${JSON.stringify(line.slice(0, 30))}`);
      assert.ok(line.length <= 76, `line over 76 chars: ${line.length}`);
    }
    assert.equal(recovered.length, payload.length);
    for (let i = 0; i < payload.length; i++) {
      assert.equal(recovered[i], payload[i], `byte ${i} mismatch`);
    }
  });

  test(`uuencode: round-trip ${size}-byte payload`, async () => {
    const payload = bytesFromPattern(size);
    const { wrapped, recovered } = await roundTrip(
      uuencodeApplyTransform({ filename: 'message' }),
      uuencodeStripTransform(),
      payload,
    );
    const wrappedText = new TextDecoder().decode(wrapped);
    assert.match(wrappedText, /^begin 644 message\n/, 'uuencode begin line');
    assert.match(wrappedText, /\n`\nend\n$/, 'uuencode end line');
    assert.equal(recovered.length, payload.length);
    for (let i = 0; i < payload.length; i++) {
      assert.equal(recovered[i], payload[i], `byte ${i} mismatch`);
    }
  });
}

test('gzip: filename appears in FNAME field', async () => {
  const payload = bytesFromString('hello world');
  const wrapped = await streamToBytes(
    streamFromBytes(payload).pipeThrough(gzipApplyTransform({ filename: 'note.txt' })),
  );
  // FNAME starts at byte 10 (after fixed 10-byte header), NUL-terminated.
  let end = 10;
  while (end < wrapped.length && wrapped[end] !== 0x00) end++;
  const fnameBytes = wrapped.slice(10, end);
  assert.equal(new TextDecoder().decode(fnameBytes), 'note.txt');
});

test('base64: output is Linux base64(1)-compatible', async () => {
  // `base64(1)` (coreutils) emits the alphabet only, 76 chars per line,
  // optional `=` padding at end, single trailing newline. No PEM framing.
  const payload = bytesFromString('Hello, World!');
  const wrapped = await streamToBytes(
    streamFromBytes(payload).pipeThrough(base64ApplyTransform()),
  );
  const text = new TextDecoder().decode(wrapped);
  // No `-----BEGIN` / `-----END` lines anywhere.
  assert.ok(!text.includes('-----BEGIN'), 'no PEM begin line');
  assert.ok(!text.includes('-----END'), 'no PEM end line');
  // Single trailing newline.
  assert.ok(text.endsWith('\n'), 'trailing newline present');
});

test('uuencode: begin line carries the supplied filename', async () => {
  const payload = bytesFromString('hi');
  const wrapped = await streamToBytes(
    streamFromBytes(payload).pipeThrough(uuencodeApplyTransform({ filename: 'note.bin' })),
  );
  const text = new TextDecoder().decode(wrapped);
  assert.match(text, /^begin 644 note\.bin\n/);
});

test('chunked input: gzip survives 1-byte chunks', async () => {
  const payload = bytesFromPattern(200);
  const { recovered } = await roundTrip(
    gzipApplyTransform({ filename: 'message' }),
    gzipStripTransform(),
    payload,
    1,
  );
  assert.equal(recovered.length, payload.length);
  for (let i = 0; i < payload.length; i++) {
    assert.equal(recovered[i], payload[i], `byte ${i}`);
  }
});

test('chunked input: base64 survives 1-byte chunks', async () => {
  const payload = bytesFromPattern(200);
  const { recovered } = await roundTrip(
    base64ApplyTransform(),
    base64StripTransform(),
    payload,
    1,
  );
  assert.equal(recovered.length, payload.length);
  for (let i = 0; i < payload.length; i++) {
    assert.equal(recovered[i], payload[i], `byte ${i}`);
  }
});

test('chunked input: uuencode survives 7-byte chunks', async () => {
  const payload = bytesFromPattern(200);
  const { recovered } = await roundTrip(
    uuencodeApplyTransform({ filename: 'message' }),
    uuencodeStripTransform(),
    payload,
    7,
  );
  assert.equal(recovered.length, payload.length);
  for (let i = 0; i < payload.length; i++) {
    assert.equal(recovered[i], payload[i], `byte ${i}`);
  }
});

test('base64: emitted body lines are 76 chars wide (Linux default)', async () => {
  const payload = bytesFromPattern(200);
  const wrapped = await streamToBytes(
    streamFromBytes(payload).pipeThrough(base64ApplyTransform()),
  );
  const text = new TextDecoder().decode(wrapped);
  const lines = text.split('\n').filter(l => l.length > 0);
  // All lines but possibly the last should be exactly 76 chars.
  for (let i = 0; i < lines.length - 1; i++) {
    assert.equal(lines[i].length, 76, `line ${i} not 76 chars: ${lines[i].length}`);
  }
});

test('uuencode: emitted data lines start with a length char', async () => {
  const payload = bytesFromPattern(135); // 3 full 45-byte chunks
  const wrapped = await streamToBytes(
    streamFromBytes(payload).pipeThrough(uuencodeApplyTransform({ filename: 'message' })),
  );
  const text = new TextDecoder().decode(wrapped);
  const lines = text.split('\n');
  // lines[0] = "begin 644 message"; lines[1..3] = data; lines[4] = "`"; lines[5] = "end".
  for (let i = 1; i <= 3; i++) {
    const lengthChar = lines[i].charCodeAt(0);
    const decodedLength = (lengthChar - 32) & 0x3F;
    assert.equal(decodedLength, 45, `line ${i} length char should encode 45`);
  }
});
