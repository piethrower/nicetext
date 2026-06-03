// Tests for the cover-escape TransformStream after the 2026-05-17
// audit redesign. Confirms:
//   - pass-through for cover whose head doesn't look like a wrapper
//   - gzip magic at the head gets ` ! ` prepended
//   - text head matching any HEAD_MARKERS prefix gets ` ! ` prepended
//   - body lines that look like markers do NOT get escaped (the
//     responsibility moved to apply transforms)
//   - escape is idempotent, running it twice doesn't double-escape
//
// Pre-redesign, escape walked every line of the cover and inserted
// ` ! ` before any marker-shaped line. After the redesign:
//   - autoStrip's detector only looks at the head
//   - each apply transform handles body safety internally (entity-
//     escape, CDATA-escape, gzip+base64, etc.)
//   - LaTeX (the lone exception that needed cover-side body escape)
//     was dropped
// So escape becomes head-only.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { escapeTransform } from '../../js/src/cover-escape.js';

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

async function runEscape(input, chunkSize = 0) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const out = await streamToBytes(
    streamFromBytes(bytes, chunkSize).pipeThrough(escapeTransform()),
  );
  return new TextDecoder().decode(out);
}

test('passthrough: cover with non-marker head is unchanged', async () => {
  const input = 'hello world\nthis is a natural cover\nwith ordinary content\n';
  const out = await runEscape(input);
  assert.equal(out, input);
});

test('gzip magic at the head is disambiguated with leading ` ! `', async () => {
  const input = new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x41, 0x42, 0x43]);
  const out = await runEscape(input);
  assert.ok(out.startsWith(' ! '), `expected leading ' ! ', got ${JSON.stringify(out.slice(0, 10))}`);
});

test('cover head starting with `<!DOCTYPE html>` gets disambiguated', async () => {
  const input = '<!DOCTYPE html>\nfake html prose\n';
  const out = await runEscape(input);
  assert.equal(out, ' ! <!DOCTYPE html>\nfake html prose\n');
});

test('cover head starting with markdown title gets disambiguated', async () => {
  const input = '# Title\n\nbody content\n';
  const out = await runEscape(input);
  assert.equal(out, ' ! # Title\n\nbody content\n');
});

test('cover head starting with EML `From: ` gets disambiguated', async () => {
  const input = 'From: someone\nbody content\n';
  const out = await runEscape(input);
  assert.equal(out, ' ! From: someone\nbody content\n');
});

test('cover head starting with PHP full apply prefix gets disambiguated', async () => {
  const input = '<?php\necho gzdecode(base64_decode("rest of fake cover\n';
  const out = await runEscape(input);
  assert.ok(out.startsWith(' ! '), `expected leading ' ! ', got ${JSON.stringify(out.slice(0, 16))}`);
});

test('cover head starting with `<?php` PROSE (not full PHP apply) is NOT escaped', async () => {
  // After the 2026-05-17 redesign, program-envelope detection requires
  // the FULL apply prefix. Prose starting with `<?php is a server
  // language…` doesn't match → no escape → cover content untouched.
  const input = '<?php is a server language used by many sites.\n';
  const out = await runEscape(input);
  assert.equal(out, input, 'prose-prefix should not be escaped');
});

test('body lines that look like markers are NOT escaped (redesign)', async () => {
  // After the redesign, escape is head-only. Marker-shaped lines in
  // the BODY pass through unchanged. Each apply transform handles its
  // own body safety internally (e.g., html entity-escapes, xml CDATA-
  // escapes, etc.).
  const input = 'normal first line\n.SH DESCRIPTION\nFrom: x\n%%EOF\nend\n';
  const out = await runEscape(input);
  assert.equal(out, input);
});

test('escape is idempotent: second pass leaves output unchanged', async () => {
  const inputs = [
    'plain cover\nnothing tricky here\n',
    '<!DOCTYPE html>\nfake html\n',
    'From: x\nbody\n',
  ];
  for (const input of inputs) {
    const once = await runEscape(input);
    const twice = await runEscape(once);
    assert.equal(twice, once, `escape applied twice differs from once for ${JSON.stringify(input.slice(0, 30))}`);
  }
});

test('chunked input: 1-byte chunks survive (head decided at peek size)', async () => {
  const input = '<!DOCTYPE html>\nbody content\n';
  const out = await runEscape(input, 1);
  assert.equal(out, ' ! <!DOCTYPE html>\nbody content\n');
});

test('cover shorter than peek-bytes: still gets head check at flush', async () => {
  // Cover smaller than HEAD_PEEK_BYTES, the head check happens in
  // flush() rather than mid-transform.
  const input = '# X\n\n';  // 5 chars; satisfies markdown title pattern
  const out = await runEscape(input);
  assert.equal(out, ' ! # X\n\n');
});

test('empty cover: passes through unchanged', async () => {
  const out = await runEscape('');
  assert.equal(out, '');
});

test('cover head looking like bare base64 gets disambiguated', async () => {
  // A cover that starts with a base64-looking line (alphabet only,
  // length-mod-4) would be misclassified as a base64 wrapper by
  // autoStrip. The head check defangs it.
  const input = 'SGVsbG8gd29ybGQ=\nactual body\n';
  const out = await runEscape(input);
  assert.equal(out, ' ! SGVsbG8gd29ybGQ=\nactual body\n');
});
