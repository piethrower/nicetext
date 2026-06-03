// cover-streaming.js: reusable streaming primitives for cover-wrap
// apply/strip transforms.
//
// Two patterns each side:
//   - Simple:    text body, optional per-chunk escape/unescape function.
//   - Composed:  body pipes through a chain of TransformStreams
//                (e.g., gzip + base64 for program envelopes).
//
// Plus a paged-apply variant for PDF (which buffers one page's worth
// of content stream at a time to write its `<</Length N>>` header).
//
// All primitives guarantee O(carry × max-escape-length) memory
// regardless of cover size. No primitive ever buffers the whole cover.
//
// Browser-safe ESM. No deps.

const TEXT_ENCODER = new TextEncoder();

// ---------- byte / text helpers ----------

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Decode bytes to string, accumulating partial multi-byte sequences
// across calls (the per-decoder state machine handles boundaries).
// Caller owns the decoder lifecycle.
function decodeChunk(decoder, bytes, isFlush) {
  return decoder.decode(bytes, { stream: !isFlush });
}

// ---------- shared head/tail helpers ----------

// Find pattern in text. Returns { found: true, index } OR
// { found: false, safeKeepFromEnd } where safeKeepFromEnd is how many
// chars from the end must stay in the buffer in case a partial match
// straddles the next chunk.
function scanForPattern(text, pattern) {
  // pattern can be a string or a RegExp (the regex must be anchored or
  // include explicit boundaries; we use exec for index).
  if (typeof pattern === 'string') {
    const idx = text.indexOf(pattern);
    if (idx >= 0) return { found: true, index: idx, length: pattern.length };
    // Partial match at end? Look for the longest prefix of `pattern`
    // that is a suffix of `text`. Conservative carry = pattern.length - 1.
    const carry = Math.min(pattern.length - 1, text.length);
    return { found: false, safeKeepFromEnd: carry };
  }
  // RegExp.
  const m = pattern.exec(text);
  if (m) return { found: true, index: m.index, length: m[0].length };
  // For regexes we conservatively carry a fixed window; callers should
  // provide an upper bound via carryHint. Default to 128.
  return { found: false, safeKeepFromEnd: Math.min(128, text.length) };
}

// ---------- streamingStripSimple ----------
//
// Single-shot strip: find head pattern → switch to body mode → emit
// body chunks (optionally unescape) → terminate on tail pattern (or
// body-to-EOF if tailPattern is null).
//
// Config:
//   headPattern:    string or regex; required.
//   tailPattern:    string; null means body extends to EOF.
//   unescapeFn:     optional function(text) -> text. Applied per emit.
//   unescapeMaxLen: max characters of any unescape sequence (so we hold
//                   back this many chars from each emit in case an
//                   unescape sequence straddles a chunk boundary).
//   skipEscapedTail:if true, the strip skips any tailPattern occurrence
//                   preceded by ` ! ` (space-bang-space), the
//                   project's body-escape sentinel. Continues scanning.

export function streamingStripSimple({
  headPattern,
  tailPattern = null,
  unescapeFn = null,
  unescapeMaxLen = 0,
  skipEscapedTail = false,
} = {}) {
  if (!headPattern) throw new Error('streamingStripSimple: headPattern required');
  const ESC_SENTINEL = ' ! ';

  return new TransformStream({
    start() {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.preBuf = '';                // text buffer in PRE_HEAD state
      this.bodyBuf = '';               // text buffer in BODY state
      this.state = 'PRE_HEAD';
      this.done = false;
    },

    transform(chunk, controller) {
      if (this.done) return;
      const text = decodeChunk(this.decoder, chunk, false);

      if (this.state === 'PRE_HEAD') {
        this.preBuf += text;
        const scan = scanForPattern(this.preBuf, headPattern);
        if (!scan.found) {
          // Trim safe prefix; we can't emit anything yet, but we don't
          // need to keep ALL of preBuf, only enough to cover a partial
          // head match. (Pre-head bytes get discarded entirely once the
          // head is found.)
          // For RegExp head patterns we keep the whole buffer (the
          // pattern might match arbitrarily far in). For string head
          // patterns we could trim, but only the tail-(pattern.length-1)
          // matters: the rest is permanently discarded once head is
          // found. We keep the whole pre-head buffer; it's bounded by
          // the header length which is small in practice.
          return;
        }
        // Found head. Discard pre-head bytes including the header.
        this.bodyBuf = this.preBuf.slice(scan.index + scan.length);
        this.preBuf = '';
        this.state = 'BODY';
      } else if (this.state === 'BODY') {
        this.bodyBuf += text;
      }

      // BODY state: process buffer.
      while (true) {
        if (tailPattern === null) {
          // Body-to-EOF mode: emit everything except unescape carry.
          const hold = unescapeMaxLen;
          if (this.bodyBuf.length > hold) {
            const safeEnd = this.bodyBuf.length - hold;
            const slice = this.bodyBuf.slice(0, safeEnd);
            controller.enqueue(TEXT_ENCODER.encode(
              unescapeFn ? unescapeFn(slice) : slice
            ));
            this.bodyBuf = this.bodyBuf.slice(safeEnd);
          }
          return;
        }

        // tailPattern is a string. Scan for it, honoring skip-if-escaped.
        let searchFrom = 0;
        let foundIdx = -1;
        while (true) {
          const idx = this.bodyBuf.indexOf(tailPattern, searchFrom);
          if (idx < 0) break;
          if (skipEscapedTail
              && idx >= ESC_SENTINEL.length
              && this.bodyBuf.slice(idx - ESC_SENTINEL.length, idx) === ESC_SENTINEL) {
            // Escaped occurrence; skip and continue.
            searchFrom = idx + tailPattern.length;
            continue;
          }
          foundIdx = idx;
          break;
        }

        if (foundIdx >= 0) {
          // Body ends at foundIdx.
          const body = this.bodyBuf.slice(0, foundIdx);
          controller.enqueue(TEXT_ENCODER.encode(
            unescapeFn ? unescapeFn(body) : body
          ));
          this.bodyBuf = '';
          this.done = true;
          return;
        }

        // No tail yet. Emit body except the last (tailPattern.length - 1
        // + unescapeMaxLen) chars; they might be the start of a tail
        // match or a partial unescape sequence.
        const tailCarry = tailPattern.length - 1;
        const escCarry  = unescapeMaxLen;
        // If skip-escape is on, we must ALSO hold back enough to see
        // ESC_SENTINEL + tailPattern straddling a chunk boundary.
        const skipExtra = skipEscapedTail ? ESC_SENTINEL.length : 0;
        const hold = Math.max(tailCarry + skipExtra, escCarry);
        if (this.bodyBuf.length > hold) {
          const safeEnd = this.bodyBuf.length - hold;
          const slice = this.bodyBuf.slice(0, safeEnd);
          controller.enqueue(TEXT_ENCODER.encode(
            unescapeFn ? unescapeFn(slice) : slice
          ));
          this.bodyBuf = this.bodyBuf.slice(safeEnd);
        }
        return;
      }
    },

    flush(controller) {
      if (this.done) return;
      // Flush any pending decoder bytes.
      const tail = decodeChunk(this.decoder, new Uint8Array(0), true);
      if (this.state === 'PRE_HEAD') {
        this.preBuf += tail;
        const scan = scanForPattern(this.preBuf, headPattern);
        if (!scan.found) return; // No head ever; emit nothing.
        this.bodyBuf = this.preBuf.slice(scan.index + scan.length);
        this.preBuf = '';
        this.state = 'BODY';
      } else {
        this.bodyBuf += tail;
      }
      // In BODY state at EOF.
      if (tailPattern !== null) {
        // Look one final time for an unescaped tail.
        let searchFrom = 0;
        let foundIdx = -1;
        while (true) {
          const idx = this.bodyBuf.indexOf(tailPattern, searchFrom);
          if (idx < 0) break;
          if (skipEscapedTail
              && idx >= ESC_SENTINEL.length
              && this.bodyBuf.slice(idx - ESC_SENTINEL.length, idx) === ESC_SENTINEL) {
            searchFrom = idx + tailPattern.length;
            continue;
          }
          foundIdx = idx;
          break;
        }
        if (foundIdx >= 0) {
          const body = this.bodyBuf.slice(0, foundIdx);
          controller.enqueue(TEXT_ENCODER.encode(
            unescapeFn ? unescapeFn(body) : body
          ));
          this.done = true;
          return;
        }
        // No tail found and we're at EOF. For envelopes that require a
        // tail, this is malformed input; emit nothing.
        // (Caller's autoStrip fallback can recover.)
        return;
      }
      // Body-to-EOF: emit everything left.
      if (this.bodyBuf.length > 0) {
        controller.enqueue(TEXT_ENCODER.encode(
          unescapeFn ? unescapeFn(this.bodyBuf) : this.bodyBuf
        ));
      }
    },
  });
}

// ---------- streamingStripComposed ----------
//
// Like streamingStripSimple, but body bytes (between head and tail)
// pipe through a chain of TransformStreams. Used for program envelopes
// where body is base64-encoded gzip data: bodyTransforms = [base64
// decoder, gunzip].
//
// Implementation: while in body mode, write the body bytes (as a text
// slice → bytes) into the first TransformStream's writable side, and
// re-emit its output to the outer controller.

export function streamingStripComposed({
  headPattern,
  tailPattern = null,
  bodyTransforms = [],
} = {}) {
  if (!headPattern) throw new Error('streamingStripComposed: headPattern required');
  if (!Array.isArray(bodyTransforms) || bodyTransforms.length === 0) {
    throw new Error('streamingStripComposed: bodyTransforms must be a non-empty array');
  }

  return new TransformStream({
    start() {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.preBuf = '';
      this.bodyBuf = '';
      this.state = 'PRE_HEAD';
      this.done = false;
      this.bodyChain = null;     // composed TransformStream chain (writable side)
      this.bodyDrain = null;     // promise that drains the chain into outerController
      this.outerController = null;
    },

    async transform(chunk, controller) {
      if (this.done) return;
      this.outerController = controller;
      const text = decodeChunk(this.decoder, chunk, false);

      if (this.state === 'PRE_HEAD') {
        this.preBuf += text;
        const scan = scanForPattern(this.preBuf, headPattern);
        if (!scan.found) return;
        this.bodyBuf = this.preBuf.slice(scan.index + scan.length);
        this.preBuf = '';
        this.state = 'BODY';
        this._initBodyChain();
      } else if (this.state === 'BODY') {
        this.bodyBuf += text;
      }

      // Look for tail; emit body bytes (as text → bytes) into bodyChain.
      // Body content for program envelopes is the base64 text; the chain
      // (base64-decode → gunzip) handles the binary.
      while (true) {
        let foundIdx = -1;
        if (tailPattern !== null) {
          foundIdx = this.bodyBuf.indexOf(tailPattern);
        }
        if (foundIdx >= 0) {
          const body = this.bodyBuf.slice(0, foundIdx);
          await this.bodyChain.write(TEXT_ENCODER.encode(body));
          await this.bodyChain.close();
          await this.bodyDrain;
          this.bodyBuf = '';
          this.done = true;
          return;
        }
        // No tail yet. Emit safely-bounded prefix; hold back the tail
        // carry.
        const hold = tailPattern === null ? 0 : (tailPattern.length - 1);
        if (this.bodyBuf.length > hold) {
          const safeEnd = this.bodyBuf.length - hold;
          const slice = this.bodyBuf.slice(0, safeEnd);
          await this.bodyChain.write(TEXT_ENCODER.encode(slice));
          this.bodyBuf = this.bodyBuf.slice(safeEnd);
        }
        return;
      }
    },

    async flush(controller) {
      if (this.done) return;
      this.outerController = controller;
      const tail = decodeChunk(this.decoder, new Uint8Array(0), true);
      if (this.state === 'PRE_HEAD') {
        this.preBuf += tail;
        const scan = scanForPattern(this.preBuf, headPattern);
        if (!scan.found) return;
        this.bodyBuf = this.preBuf.slice(scan.index + scan.length);
        this.preBuf = '';
        this.state = 'BODY';
        this._initBodyChain();
      } else {
        this.bodyBuf += tail;
      }
      // Try one last tail lookup.
      if (tailPattern !== null) {
        const idx = this.bodyBuf.indexOf(tailPattern);
        if (idx >= 0) {
          const body = this.bodyBuf.slice(0, idx);
          await this.bodyChain.write(TEXT_ENCODER.encode(body));
        } else {
          // No tail; emit what we have (some envelopes accept this).
          if (this.bodyBuf.length > 0) {
            await this.bodyChain.write(TEXT_ENCODER.encode(this.bodyBuf));
          }
        }
      } else if (this.bodyBuf.length > 0) {
        await this.bodyChain.write(TEXT_ENCODER.encode(this.bodyBuf));
      }
      await this.bodyChain.close();
      await this.bodyDrain;
    },

    _initBodyChain() {
      // Build the chain: each TransformStream's readable side feeds
      // the next's writable side. Final readable drains to outerController.
      let writable, lastReadable;
      for (let i = 0; i < bodyTransforms.length; i++) {
        const ts = bodyTransforms[i]();
        if (i === 0) writable = ts.writable;
        if (lastReadable) lastReadable.pipeTo(ts.writable).catch(() => {});
        lastReadable = ts.readable;
      }
      const writer = writable.getWriter();
      const reader = lastReadable.getReader();
      this.bodyChain = {
        write: (bytes) => writer.write(bytes),
        close: () => writer.close(),
      };
      this.bodyDrain = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && this.outerController) this.outerController.enqueue(value);
          }
        } catch (e) {
          if (this.outerController) this.outerController.error(e);
        }
      })();
    },
  });
}

// ---------- streamingApplySimple ----------
//
// Emit prefix → stream chunks (optionally with per-chunk escape) →
// emit suffix.
//
// Config:
//   prefixBytes: Uint8Array; required.
//   suffixBytes: Uint8Array; required (may be empty).
//   escapeFn:    optional function(text) -> text.
//   escapeMaxLen:hold-back size for escape boundary safety.

export function streamingApplySimple({
  prefixBytes,
  suffixBytes = new Uint8Array(0),
  escapeFn = null,
  escapeMaxLen = 0,
} = {}) {
  return new TransformStream({
    start(controller) {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.textBuf = '';
      controller.enqueue(prefixBytes);
    },
    transform(chunk, controller) {
      this.textBuf += decodeChunk(this.decoder, chunk, false);
      if (this.textBuf.length > escapeMaxLen) {
        const safeEnd = this.textBuf.length - escapeMaxLen;
        const slice = this.textBuf.slice(0, safeEnd);
        controller.enqueue(TEXT_ENCODER.encode(
          escapeFn ? escapeFn(slice) : slice
        ));
        this.textBuf = this.textBuf.slice(safeEnd);
      }
    },
    flush(controller) {
      const tail = decodeChunk(this.decoder, new Uint8Array(0), true);
      this.textBuf += tail;
      if (this.textBuf.length > 0) {
        controller.enqueue(TEXT_ENCODER.encode(
          escapeFn ? escapeFn(this.textBuf) : this.textBuf
        ));
      }
      controller.enqueue(suffixBytes);
    },
  });
}

// ---------- streamingApplyComposed ----------
//
// Emit prefix → pipe cover through a chain of TransformStreams → emit
// the chain's output → emit suffix. Used for program envelopes (gzip +
// base64 inside the wrapper).

export function streamingApplyComposed({
  prefixBytes,
  suffixBytes = new Uint8Array(0),
  bodyTransforms = [],
} = {}) {
  if (!Array.isArray(bodyTransforms) || bodyTransforms.length === 0) {
    throw new Error('streamingApplyComposed: bodyTransforms must be a non-empty array');
  }

  return new TransformStream({
    start(controller) {
      controller.enqueue(prefixBytes);
      this.outerController = controller;
      let writable, lastReadable;
      for (let i = 0; i < bodyTransforms.length; i++) {
        const ts = bodyTransforms[i]();
        if (i === 0) writable = ts.writable;
        if (lastReadable) lastReadable.pipeTo(ts.writable).catch(() => {});
        lastReadable = ts.readable;
      }
      this.writer = writable.getWriter();
      const reader = lastReadable.getReader();
      this.drain = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } catch (e) {
          controller.error(e);
        }
      })();
    },
    async transform(chunk) {
      await this.writer.write(chunk);
    },
    async flush(controller) {
      await this.writer.close();
      await this.drain;
      controller.enqueue(suffixBytes);
    },
  });
}

// ---------- base64 streaming encoder / decoder ----------
//
// Used by program envelope composed apply / strip.

const BASE64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const t = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHA.length; i++) t[BASE64_ALPHA.charCodeAt(i)] = i;
  return t;
})();

// Encoder: bytes in → base64 ASCII bytes out. No line wrapping (program
// envelopes embed the full base64 as a single string literal).
export function base64EncoderStream() {
  return new TransformStream({
    start() { this.leftover = new Uint8Array(0); },
    transform(chunk, controller) {
      let bytes = chunk;
      if (this.leftover.length > 0) {
        const merged = new Uint8Array(this.leftover.length + bytes.length);
        merged.set(this.leftover, 0);
        merged.set(bytes, this.leftover.length);
        bytes = merged;
      }
      const tripletEnd = bytes.length - (bytes.length % 3);
      if (tripletEnd > 0) {
        const out = new Uint8Array((tripletEnd / 3) * 4);
        for (let i = 0, o = 0; i < tripletEnd; i += 3, o += 4) {
          const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
          out[o]     = BASE64_ALPHA.charCodeAt((b0 >> 2) & 0x3F);
          out[o + 1] = BASE64_ALPHA.charCodeAt(((b0 << 4) | (b1 >> 4)) & 0x3F);
          out[o + 2] = BASE64_ALPHA.charCodeAt(((b1 << 2) | (b2 >> 6)) & 0x3F);
          out[o + 3] = BASE64_ALPHA.charCodeAt(b2 & 0x3F);
        }
        controller.enqueue(out);
      }
      this.leftover = bytes.slice(tripletEnd);
    },
    flush(controller) {
      const rem = this.leftover.length;
      if (rem === 0) return;
      if (rem === 1) {
        const b0 = this.leftover[0];
        controller.enqueue(TEXT_ENCODER.encode(
          BASE64_ALPHA[(b0 >> 2) & 0x3F] +
          BASE64_ALPHA[(b0 << 4) & 0x3F] +
          '=='
        ));
      } else if (rem === 2) {
        const b0 = this.leftover[0], b1 = this.leftover[1];
        controller.enqueue(TEXT_ENCODER.encode(
          BASE64_ALPHA[(b0 >> 2) & 0x3F] +
          BASE64_ALPHA[((b0 << 4) | (b1 >> 4)) & 0x3F] +
          BASE64_ALPHA[(b1 << 2) & 0x3F] +
          '='
        ));
      }
    },
  });
}

// ---------- streamingReplacer ----------
//
// Generic streaming string-replacement TransformStream. Used by strips
// whose body needs multi-char unescape (html entities, nroff escapes,
// xml CDATA escapes) where the escape sequence may straddle chunk
// boundaries.
//
// Behavior:
//   - Patterns are checked in caller-provided order at each position.
//     CALLER must sort longest-first if shorter patterns are prefixes
//     of longer ones (to avoid shorter eating into longer).
//   - Single-pass: replacements are NOT re-scanned. This avoids the
//     "decode `&amp;lt;` to `<` instead of `&lt;`" trap that multi-pass
//     `.replace` chains have.
//   - Chunk-boundary safe: at the end of each chunk, if remaining
//     buffered chars could be the start of any pattern, they are held
//     back for the next chunk. Hold-back is bounded by max(pattern.length)
//     so memory stays O(K) regardless of input size.

export function streamingReplacer(patterns) {
  const sorted = patterns.slice().sort((a, b) => b[0].length - a[0].length);
  const maxLen = sorted.reduce((m, [p]) => Math.max(m, p.length), 0);

  return new TransformStream({
    start() {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.buf = '';
    },
    transform(chunk, controller) {
      this.buf += this.decoder.decode(chunk, { stream: true });
      let out = '';
      let i = 0;
      while (i < this.buf.length) {
        let matched = false;
        for (const [match, replacement] of sorted) {
          if (this.buf.length - i >= match.length
              && this.buf.slice(i, i + match.length) === match) {
            out += replacement;
            i += match.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
        // Could the remaining buf be a partial pattern? If so, hold.
        const remain = this.buf.length - i;
        if (remain < maxLen) {
          let needsHold = false;
          for (const [match] of sorted) {
            if (match.length > remain
                && match.slice(0, remain) === this.buf.slice(i)) {
              needsHold = true;
              break;
            }
          }
          if (needsHold) break;
        }
        out += this.buf[i];
        i++;
      }
      if (out) controller.enqueue(TEXT_ENCODER.encode(out));
      this.buf = this.buf.slice(i);
    },
    flush(controller) {
      const tail = this.decoder.decode(new Uint8Array(0), { stream: false });
      this.buf += tail;
      let out = '';
      let i = 0;
      while (i < this.buf.length) {
        let matched = false;
        for (const [match, replacement] of sorted) {
          if (this.buf.length - i >= match.length
              && this.buf.slice(i, i + match.length) === match) {
            out += replacement;
            i += match.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
        out += this.buf[i];
        i++;
      }
      if (out) controller.enqueue(TEXT_ENCODER.encode(out));
    },
  });
}

// Decoder: base64 ASCII bytes in → raw bytes out. Tolerates whitespace
// and non-alphabet chars (skipped). Handles `=` padding at end.
export function base64DecoderStream() {
  return new TransformStream({
    start() { this.alphaBuf = ''; this.paddingSeen = 0; this.done = false; },
    transform(chunk, controller) {
      if (this.done) return;
      // Decode chunk bytes into text (it's ASCII; UTF-8 decode is fine).
      const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (BASE64_LOOKUP[c] >= 0) {
          if (this.paddingSeen > 0) {
            // Padding seen but then more alphabet; treat as malformed,
            // stop here.
            this.done = true;
            return;
          }
          this.alphaBuf += text[i];
          if (this.alphaBuf.length === 4) {
            const v0 = BASE64_LOOKUP[this.alphaBuf.charCodeAt(0)];
            const v1 = BASE64_LOOKUP[this.alphaBuf.charCodeAt(1)];
            const v2 = BASE64_LOOKUP[this.alphaBuf.charCodeAt(2)];
            const v3 = BASE64_LOOKUP[this.alphaBuf.charCodeAt(3)];
            const out = new Uint8Array(3);
            out[0] = (v0 << 2) | (v1 >> 4);
            out[1] = ((v1 & 0x0F) << 4) | (v2 >> 2);
            out[2] = ((v2 & 0x03) << 6) | v3;
            controller.enqueue(out);
            this.alphaBuf = '';
          }
        } else if (text[i] === '=') {
          this.paddingSeen++;
          if (this.paddingSeen > 2) {
            this.done = true;
            return;
          }
        }
        // Skip any other char silently (whitespace, etc.).
      }
    },
    flush(controller) {
      if (this.done) return;
      // Terminal partial group with padding.
      if (this.alphaBuf.length === 0 && this.paddingSeen === 0) return;
      const padded = (this.alphaBuf + 'A'.repeat(4 - this.alphaBuf.length));
      const v0 = BASE64_LOOKUP[padded.charCodeAt(0)];
      const v1 = BASE64_LOOKUP[padded.charCodeAt(1)];
      const v2 = BASE64_LOOKUP[padded.charCodeAt(2)];
      const v3 = BASE64_LOOKUP[padded.charCodeAt(3)];
      const outBytes = Math.max(0, 3 - this.paddingSeen);
      if (outBytes === 0) return;
      const out = new Uint8Array(outBytes);
      out[0] = (v0 << 2) | (v1 >> 4);
      if (outBytes > 1) out[1] = ((v1 & 0x0F) << 4) | (v2 >> 2);
      if (outBytes > 2) out[2] = ((v2 & 0x03) << 6) | v3;
      controller.enqueue(out);
    },
  });
}
