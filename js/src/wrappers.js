// wrappers.js
//
// Stream-friendly format wrappers for the cover-text post-processing
// pipeline. Each format exposes an `*ApplyTransform` and `*StripTransform`
// that return a `TransformStream<Uint8Array, Uint8Array>` so they can be
// composed with `.pipeThrough(...)`. Backpressure flows natively through
// the chain.
//
// Three formats in the v1 set:
//   - gzip:     native CompressionStream / DecompressionStream wrapper,
//               with a custom gzip header carrying the user-supplied
//               filename in the FNAME field so `gzip -l` reports it.
//   - base64:   PEM-style framing, `-----BEGIN <filename>-----` /
//               `-----END <filename>-----` brackets around 64-char-wrapped
//               base64 body lines.
//   - uuencode: classic Unix uuencode, `begin 644 <filename>` /
//               `end` brackets around per-line length-char + encoded data.
//
// All three are streamable both directions with single-digit-to-low-
// hundreds of bytes of buffering (per-line for the text encoders, per-
// chunk for gzip).

// TEXT_DECODER is stateful under {stream: true}; a module-level shared
// instance leaks partial-multi-byte state across unrelated covers
// (audit 2026-05-17 Finding 3). Each factory now owns its own.
const TEXT_ENCODER = new TextEncoder();

// ---------- CRC32 (IEEE 802.3 polynomial, reflected) ----------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
})();

function crc32Init() { return 0xFFFFFFFF >>> 0; }
function crc32Step(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc >>> 0;
}
function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

// ---------- gzip ----------

// Build a gzip member header. FLG=0x08 sets FNAME. mtime=0, XFL=0, OS=0xFF
// (unknown) so the header is bit-stable across machines / runs.
function makeGzipHeader(filename) {
  const nameBytes = TEXT_ENCODER.encode(String(filename ?? ''));
  const out = new Uint8Array(10 + nameBytes.length + 1);
  out[0] = 0x1F; out[1] = 0x8B; out[2] = 0x08; // ID1, ID2, CM=deflate
  out[3] = 0x08;                                // FLG: FNAME set
  // mtime=0 (bytes 4-7), XFL=0 (byte 8), OS=0xFF unknown (byte 9)
  out[9] = 0xFF;
  out.set(nameBytes, 10);
  out[10 + nameBytes.length] = 0x00;            // NUL terminator
  return out;
}

// Parse a gzip header off the front of a buffer. Returns
// { filename, consumedBytes } on success or null if the buffer is too
// short to determine. Only handles the subset of FLG bits we ourselves
// emit (FNAME optional, no FEXTRA / FCOMMENT / FHCRC). Throws if magic
// is wrong or other flags are set (so we never feed malformed gzip into
// downstream).
function parseGzipHeader(buf) {
  if (buf.length < 10) return null;
  if (buf[0] !== 0x1F || buf[1] !== 0x8B) {
    throw new Error('gzip: bad magic bytes');
  }
  if (buf[2] !== 0x08) {
    throw new Error('gzip: unsupported compression method');
  }
  const flg = buf[3];
  // We accept FNAME (0x08) and ignore FHCRC (0x02), anything else is
  // out of scope for v1.
  if (flg & ~(0x08 | 0x02)) {
    throw new Error('gzip: unsupported header flags');
  }
  let pos = 10;
  let filename = '';
  if (flg & 0x08) {
    let end = pos;
    while (end < buf.length && buf[end] !== 0x00) end++;
    if (end >= buf.length) return null; // need more bytes
    filename = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(pos, end));
    pos = end + 1;
  }
  if (flg & 0x02) {
    if (pos + 2 > buf.length) return null;
    pos += 2; // skip CRC16
  }
  return { filename, consumedBytes: pos };
}

// Concat helper for Uint8Arrays.
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function gzipApplyTransform({ filename = 'message' } = {}) {
  let crc = crc32Init();
  let isize = 0;
  let headerEnqueued = false;
  const compressor = new CompressionStream('deflate-raw');
  const compressorWriter = compressor.writable.getWriter();
  const compressorReader = compressor.readable.getReader();
  let outerController = null;
  let drainPromise = null;

  function startDrain() {
    if (drainPromise) return;
    drainPromise = (async () => {
      try {
        while (true) {
          const { value, done } = await compressorReader.read();
          if (done) break;
          if (value && outerController) outerController.enqueue(value);
        }
      } catch (e) {
        if (outerController) outerController.error(e);
      }
    })();
  }

  return new TransformStream({
    start(controller) {
      outerController = controller;
      controller.enqueue(makeGzipHeader(filename));
      headerEnqueued = true;
      startDrain();
    },
    async transform(chunk) {
      crc = crc32Step(crc, chunk);
      isize = (isize + chunk.length) >>> 0;
      await compressorWriter.write(chunk);
    },
    async flush(controller) {
      await compressorWriter.close();
      await drainPromise;
      const trailer = new Uint8Array(8);
      const view = new DataView(trailer.buffer);
      view.setUint32(0, crc32Final(crc), true);
      view.setUint32(4, isize, true);
      controller.enqueue(trailer);
    },
  });
}

export function gzipStripTransform() {
  let headerBuf = new Uint8Array(0);
  let headerParsed = false;
  let decompressor = null;
  let decompressorWriter = null;
  let decompressorReader = null;
  let outerController = null;
  let drainPromise = null;
  // gzip ends with an 8-byte trailer (CRC32 + ISIZE) that we must NOT
  // feed into the deflate-raw decompressor. Keep a rolling 8-byte tail
  // and only forward bytes once they've aged past the tail.
  let tail = new Uint8Array(0);

  function startDrain() {
    drainPromise = (async () => {
      try {
        while (true) {
          const { value, done } = await decompressorReader.read();
          if (done) break;
          if (value && outerController) outerController.enqueue(value);
        }
      } catch (e) {
        if (outerController) outerController.error(e);
      }
    })();
  }

  return new TransformStream({
    start(controller) { outerController = controller; },
    async transform(chunk) {
      let bytes = chunk;
      if (!headerParsed) {
        headerBuf = concat(headerBuf, bytes);
        const parsed = parseGzipHeader(headerBuf);
        if (!parsed) return; // need more bytes
        headerParsed = true;
        bytes = headerBuf.slice(parsed.consumedBytes);
        headerBuf = new Uint8Array(0);
        decompressor = new DecompressionStream('deflate-raw');
        decompressorWriter = decompressor.writable.getWriter();
        decompressorReader = decompressor.readable.getReader();
        startDrain();
      }
      // Buffer the last 8 bytes (the gzip trailer); forward the rest.
      const combined = concat(tail, bytes);
      if (combined.length <= 8) {
        tail = combined;
        return;
      }
      const forwardEnd = combined.length - 8;
      const toForward = combined.slice(0, forwardEnd);
      tail = combined.slice(forwardEnd);
      await decompressorWriter.write(toForward);
    },
    async flush() {
      // `tail` holds the final 8 trailer bytes; we intentionally do
      // not feed them to deflate-raw. (CRC verification is a future
      // hardening pass; v1 trusts the inner deflate stream's own
      // termination behavior.)
      if (decompressorWriter) {
        await decompressorWriter.close();
        await drainPromise;
      }
    },
  });
}

// ---------- base64 (bare, Linux-compatible) ----------
//
// Output matches `base64(1)` exactly: 76-char lines, single trailing
// newline, no PEM framing, no filename metadata. `base64 -d` on the
// receive side decodes our output directly; conversely, anything
// produced by `base64(1)` is consumed cleanly by our strip.
//
// Detection on strip is structural (not magic-byte): the first line of
// input must be entirely base64-alphabet characters with no interior
// whitespace, length-bounded. Natural cover text (which always has
// interior spaces in lines longer than one word) never trips it.

const BASE64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHA.length; i++) t[BASE64_ALPHA.charCodeAt(i)] = i;
  return t;
})();

const BASE64_LINE_LEN = 76; // base64(1) default

// First-line check for autoStrip detection. Line must be 4..80 chars of
// pure base64 alphabet AND length-mod-4 OR trailing `=` padding (real
// base64 lines are groups of 4 chars; only terminal lines carry `=`).
// Audit 2026-05-17 Finding 2: an earlier version skipped the mod-4
// check and let short single-word lines like `line1`, `Hello`, etc.
// trigger spurious base64 detection on CRLF and LF covers alike.
//
// The detectWrapper caller adds a second gate (either trailing `=` on
// line 1 OR line 2 also base64-shaped) before committing the stream as
// base64. This per-line function is the inner predicate.
export function isBase64LeadingLine(line) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.length < 4 || line.length > 80) return false;
  let paddingCount = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (BASE64_LOOKUP[c] >= 0) continue;
    if (line[i] === '=' && i >= line.length - 2) {
      paddingCount++;
      continue;
    }
    return false;
  }
  return paddingCount > 0 || (line.length % 4 === 0);
}

export function base64ApplyTransform() {
  let leftover = new Uint8Array(0); // 0..2 bytes carried between chunks
  let lineCharsEmitted = 0;

  function emitChars(controller, str) {
    let i = 0;
    while (i < str.length) {
      const remaining = BASE64_LINE_LEN - lineCharsEmitted;
      const take = Math.min(remaining, str.length - i);
      controller.enqueue(TEXT_ENCODER.encode(str.slice(i, i + take)));
      lineCharsEmitted += take;
      i += take;
      if (lineCharsEmitted === BASE64_LINE_LEN) {
        controller.enqueue(TEXT_ENCODER.encode('\n'));
        lineCharsEmitted = 0;
      }
    }
  }

  function encodeTriplet(b0, b1, b2) {
    return (
      BASE64_ALPHA[(b0 >> 2) & 0x3F] +
      BASE64_ALPHA[((b0 << 4) | (b1 >> 4)) & 0x3F] +
      BASE64_ALPHA[((b1 << 2) | (b2 >> 6)) & 0x3F] +
      BASE64_ALPHA[b2 & 0x3F]
    );
  }

  return new TransformStream({
    transform(chunk, controller) {
      const bytes = leftover.length > 0 ? concat(leftover, chunk) : chunk;
      const tripletEnd = bytes.length - (bytes.length % 3);
      let out = '';
      for (let i = 0; i < tripletEnd; i += 3) {
        out += encodeTriplet(bytes[i], bytes[i + 1], bytes[i + 2]);
      }
      if (out) emitChars(controller, out);
      leftover = bytes.slice(tripletEnd);
    },
    flush(controller) {
      let out = '';
      if (leftover.length === 1) {
        const b0 = leftover[0];
        out =
          BASE64_ALPHA[(b0 >> 2) & 0x3F] +
          BASE64_ALPHA[(b0 << 4) & 0x3F] +
          '==';
      } else if (leftover.length === 2) {
        const b0 = leftover[0], b1 = leftover[1];
        out =
          BASE64_ALPHA[(b0 >> 2) & 0x3F] +
          BASE64_ALPHA[((b0 << 4) | (b1 >> 4)) & 0x3F] +
          BASE64_ALPHA[(b1 << 2) & 0x3F] +
          '=';
      }
      if (out) emitChars(controller, out);
      if (lineCharsEmitted > 0) controller.enqueue(TEXT_ENCODER.encode('\n'));
    },
  });
}

export function base64StripTransform() {
  // Two-phase streaming decoder. Phase 1: confirm the first line is
  // base64-shaped (handled by the autoStrip driver via
  // isBase64LeadingLine before we even get here, but we still validate
  // line by line). Phase 2: accumulate alphabet chars across line
  // boundaries, emit complete 4-char groups as 3 output bytes,
  // handle final `=` padding at EOF or first non-base64 line.
  const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
  let textBuf = '';
  let alphaPending = '';    // 0..3 leftover alphabet chars between flushes
  let paddingSeen = 0;      // count of `=` seen so far (0, 1, or 2)
  let done = false;

  function decodeCompleteGroups(controller, str) {
    // str holds only alphabet chars (no padding, no whitespace). Decode
    // groups of 4 chars → 3 bytes each. Return the residue (0..3 chars).
    const groups = Math.floor(str.length / 4);
    if (groups === 0) return str;
    const out = new Uint8Array(groups * 3);
    for (let g = 0; g < groups; g++) {
      const i = g * 4;
      const v0 = BASE64_LOOKUP[str.charCodeAt(i)];
      const v1 = BASE64_LOOKUP[str.charCodeAt(i + 1)];
      const v2 = BASE64_LOOKUP[str.charCodeAt(i + 2)];
      const v3 = BASE64_LOOKUP[str.charCodeAt(i + 3)];
      out[g * 3]     = (v0 << 2) | (v1 >> 4);
      out[g * 3 + 1] = ((v1 & 0x0F) << 4) | (v2 >> 2);
      out[g * 3 + 2] = ((v2 & 0x03) << 6) | v3;
    }
    controller.enqueue(out);
    return str.slice(groups * 4);
  }

  function finalize(controller) {
    if (alphaPending.length === 0 && paddingSeen === 0) return;
    const totalChars = alphaPending.length + paddingSeen;
    if (totalChars !== 4) {
      // Padding only meaningful on a complete 4-char terminal group.
      // Tolerate gracefully: skip if malformed.
      if (alphaPending.length === 0) return;
    }
    // Decode the terminal group with `A` padding for any positions
    // beyond the alphabet chars and padding count.
    const padded = alphaPending + 'A'.repeat(4 - alphaPending.length);
    const v0 = BASE64_LOOKUP[padded.charCodeAt(0)];
    const v1 = BASE64_LOOKUP[padded.charCodeAt(1)];
    const v2 = BASE64_LOOKUP[padded.charCodeAt(2)];
    const v3 = BASE64_LOOKUP[padded.charCodeAt(3)];
    const outBytes = 3 - paddingSeen;
    if (outBytes <= 0) return;
    const out = new Uint8Array(outBytes);
    out[0] = (v0 << 2) | (v1 >> 4);
    if (outBytes > 1) out[1] = ((v1 & 0x0F) << 4) | (v2 >> 2);
    if (outBytes > 2) out[2] = ((v2 & 0x03) << 6) | v3;
    controller.enqueue(out);
    alphaPending = '';
    paddingSeen = 0;
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      textBuf += TEXT_DECODER.decode(chunk, { stream: true });
      // Process complete lines. Defer the trailing partial line for
      // the next chunk.
      let nl;
      while ((nl = textBuf.indexOf('\n')) >= 0) {
        const line = textBuf.slice(0, nl).replace(/\r$/, '');
        textBuf = textBuf.slice(nl + 1);
        if (line.length === 0) continue;
        // Per-line shape check: alphabet + optional trailing `=`,
        // no interior whitespace. If a line fails the check we stop
        // and treat the layer as done.
        let lineOk = true;
        let alphaOnly = '';
        let trailingPad = 0;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (BASE64_LOOKUP[c.charCodeAt(0)] >= 0) {
            if (trailingPad > 0) { lineOk = false; break; }
            alphaOnly += c;
          } else if (c === '=') {
            trailingPad++;
            if (trailingPad > 2) { lineOk = false; break; }
          } else {
            lineOk = false;
            break;
          }
        }
        if (!lineOk) {
          finalize(controller);
          done = true;
          return;
        }
        if (alphaOnly.length > 0) {
          alphaPending = decodeCompleteGroups(controller, alphaPending + alphaOnly);
        }
        if (trailingPad > 0) {
          paddingSeen += trailingPad;
          // Padding marks end of body; finalize and stop.
          finalize(controller);
          done = true;
          return;
        }
      }
    },
    flush(controller) {
      if (done) return;
      // Final partial line without trailing newline.
      const line = textBuf.replace(/\r$/, '');
      if (line.length > 0) {
        let alphaOnly = '';
        let trailingPad = 0;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (BASE64_LOOKUP[c.charCodeAt(0)] >= 0) alphaOnly += c;
          else if (c === '=') trailingPad++;
          else { alphaOnly = ''; trailingPad = 0; break; }
        }
        if (alphaOnly.length > 0) {
          alphaPending = decodeCompleteGroups(controller, alphaPending + alphaOnly);
        }
        if (trailingPad > 0) paddingSeen += trailingPad;
      }
      finalize(controller);
    },
  });
}

// ---------- uuencode ----------

function uuChar(v) { return v === 0 ? '`' : String.fromCharCode((v & 0x3F) + 32); }
function uuVal(ch) { return (ch === '`' ? 0 : (ch.charCodeAt(0) - 32)) & 0x3F; }

export function uuencodeApplyTransform({ filename = 'message' } = {}) {
  let pending = new Uint8Array(0);
  let totalBytes = 0;

  function emitLine(controller, bytes) {
    let line = uuChar(bytes.length);
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i] ?? 0;
      const b1 = bytes[i + 1] ?? 0;
      const b2 = bytes[i + 2] ?? 0;
      line += uuChar((b0 >> 2) & 0x3F);
      line += uuChar(((b0 << 4) | (b1 >> 4)) & 0x3F);
      line += uuChar(((b1 << 2) | (b2 >> 6)) & 0x3F);
      line += uuChar(b2 & 0x3F);
    }
    controller.enqueue(TEXT_ENCODER.encode(line + '\n'));
  }

  return new TransformStream({
    start(controller) {
      controller.enqueue(TEXT_ENCODER.encode(`begin 644 ${filename}\n`));
    },
    transform(chunk, controller) {
      const bytes = pending.length > 0 ? concat(pending, chunk) : chunk;
      const full = bytes.length - (bytes.length % 45);
      for (let i = 0; i < full; i += 45) {
        emitLine(controller, bytes.slice(i, i + 45));
        totalBytes += 45;
      }
      pending = bytes.slice(full);
    },
    flush(controller) {
      if (pending.length > 0) {
        emitLine(controller, pending);
        totalBytes += pending.length;
      }
      controller.enqueue(TEXT_ENCODER.encode('`\nend\n'));
    },
  });
}

const UUENCODE_BEGIN_RE = /^begin \d{3} [^\n]{1,128}\r?\n/;
// End-of-body marker: ` (zero-length data line) followed by "end\n".
// Matched anywhere in textBuf (preceded either by start-of-buffer or by
// a newline from the previous data line).
const UUENCODE_END_RE = /(?:^|\n)`\r?\nend\r?\n?/;

function decodeUuencodeLine(line) {
  if (line.length === 0) return new Uint8Array(0);
  const len = uuVal(line.charAt(0));
  if (len === 0) return new Uint8Array(0);
  const out = new Uint8Array(len);
  let oi = 0;
  let i = 1;
  while (oi < len) {
    const v0 = uuVal(line.charAt(i));
    const v1 = uuVal(line.charAt(i + 1));
    const v2 = uuVal(line.charAt(i + 2));
    const v3 = uuVal(line.charAt(i + 3));
    if (oi < len) out[oi++] = ((v0 << 2) | (v1 >> 4)) & 0xFF;
    if (oi < len) out[oi++] = ((v1 << 4) | (v2 >> 2)) & 0xFF;
    if (oi < len) out[oi++] = ((v2 << 6) | v3) & 0xFF;
    i += 4;
  }
  return out;
}

export function uuencodeStripTransform() {
  const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
  let rawBuf = new Uint8Array(0);
  let textBuf = '';
  let headerSkipped = false;
  let done = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      if (!headerSkipped) {
        rawBuf = concat(rawBuf, chunk);
        const text = TEXT_DECODER.decode(rawBuf, { stream: true });
        const m = UUENCODE_BEGIN_RE.exec(text);
        if (!m) return;
        const headerBytes = TEXT_ENCODER.encode(m[0]).length;
        textBuf = TEXT_DECODER.decode(rawBuf.slice(headerBytes), { stream: true });
        rawBuf = new Uint8Array(0);
        headerSkipped = true;
      } else {
        textBuf += TEXT_DECODER.decode(chunk, { stream: true });
      }
      // Buffer until the end marker is visible somewhere in textBuf.
      // The marker is "`\nend\n" preceded by a newline (or by start-of-
      // buffer if the body is empty). Decoding the body in one pass
      // sidesteps the "`-as-zero-length-data-line" / "`-as-trailer-start"
      // ambiguity that line-by-line consumption ran into.
      const m = UUENCODE_END_RE.exec(textBuf);
      if (!m) return;
      const bodyText = textBuf.slice(0, m.index);
      for (const rawLine of bodyText.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.length === 0) continue;
        const decoded = decodeUuencodeLine(line);
        if (decoded.length > 0) controller.enqueue(decoded);
      }
      done = true;
      textBuf = '';
    },
    flush() { /* no-op */ },
  });
}
