// Streamable wrap/unwrap. Replaces the length-prefixed SIZER.
//
// Wire layout: [escaped payload bytes] [4-byte EOF marker] [random tail]
//
// EOF marker: four 0xAA bytes (10101010 × 4). Distinctive, doesn't bias
// dict picks alphabetically (half the bits set).
// Escape rule (PPP-style): 0xAA in payload → 0x55 0x8A; 0x55 in payload → 0x55 0x75.
// So in the wire stream, neither 0xAA nor 0x55 appears as a literal payload
// byte: only 0x55 followed by an escaped value, or the four 0xAA bytes
// of the marker. Decoder is unambiguous.
//
// Why streamable: no length prefix. Encoder can pump payload bytes through
// as they arrive; decoder stops when it sees the marker. Future async I/O
// can wrap a generator.
//
// Browser-safe ESM. No Node deps.

import { BitReader, BitWriter, AsyncBitReader } from './bitstream.js';

const MARKER_BYTE = 0xAA;
const ESCAPE_BYTE = 0x55;
const XOR_MASK    = 0x20;

export const EOF_MARKER_BYTES = new Uint8Array([
  MARKER_BYTE, MARKER_BYTE, MARKER_BYTE, MARKER_BYTE,
]);

export function escapeBytes(payload) {
  const out = [];
  for (const b of payload) {
    if (b === MARKER_BYTE || b === ESCAPE_BYTE) {
      out.push(ESCAPE_BYTE);
      out.push(b ^ XOR_MASK);
    } else {
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

export function unescapeBytes(escaped) {
  const out = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === ESCAPE_BYTE) {
      i++;
      if (i >= escaped.length) {
        throw new Error('stream: truncated escape sequence');
      }
      out.push(escaped[i] ^ XOR_MASK);
    } else {
      out.push(escaped[i]);
    }
  }
  return new Uint8Array(out);
}

// streamWrap: ReadableStream<Uint8Array> input -> AsyncBitReader yielding
// [escaped input chunks] [4-byte EOF marker] [random tail].
//
// Each input chunk is escaped on the fly (PPP-style: 0xAA -> 0x55 0x8A,
// 0x55 -> 0x55 0x75) and handed to the bit reader. When the input
// stream closes, the marker bytes are yielded once, then the source
// signals done; the reader switches to randomBits() per byte so the
// encode loop can keep running until its current sentence model
// finishes (engine checks reader.exhausted && tailBitsRead >= minExtraBits).
//
// The reader's lock on the input stream is released on EOF or on
// caller-side cancel of the input.
export function streamWrap(inputReadable, { randomBits = null } = {}) {
  const reader = inputReadable.getReader();
  let inputDone = false;
  let markerYielded = false;

  async function nextChunk() {
    if (!inputDone) {
      const { value, done } = await reader.read();
      if (!done) {
        if (!value || value.length === 0) return new Uint8Array(0);
        return escapeBytes(value);
      }
      inputDone = true;
      try { reader.releaseLock(); } catch {}
    }
    if (!markerYielded) {
      markerYielded = true;
      return EOF_MARKER_BYTES;
    }
    return null;
  }

  return new AsyncBitReader(nextChunk, { randomBits });
}

// streamUnwrap: cover-decoded bytes → recovered payload (everything before
// the EOF marker, with escapes removed).
//
// Decoding is "best-effort": if the input doesn't look like real NiceText
// (binary file, ciphertext, truncated cover, wrong dictionary used), we
// return whatever payload bytes we managed to recover and stop, no throw,
// no infinite loop. NiceText decoding is not a reliable compression: any
// input produces SOME bytes; only valid input produces meaningful bytes.
//
// Stop conditions, in order:
//   1. Saw the full 4-byte EOF marker → return.
//   2. Real end of input (no marker found) → return.
//   3. Saw 0xAA but the next 3 bytes weren't all 0xAA → return (the bytes
//      we consumed trying to validate are lost; for valid NiceText this
//      never happens because 0xAA is escaped in payload).
//   4. Saw 0x55 (escape) at the very end with no follow-up byte → return.
// Streaming partner to streamUnwrap. Push bytes one at a time; the
// machine emits payload bytes via drain() and flips done when the
// 4-byte EOF marker is seen, the marker run is broken (mid-payload
// 0xAA without 3 more 0xAA after), or finish() is called for EOF /
// truncated-escape cases. Mirrors streamUnwrap's "best-effort, return
// what we have" semantics.
export class IncrementalUnwrap {
  constructor() {
    this._markerSeen = 0;
    this._escapePending = false;
    this._done = false;
    this._out = [];
  }

  pushByte(byte) {
    if (this._done) return;

    if (this._escapePending) {
      this._escapePending = false;
      this._out.push(byte ^ XOR_MASK);
      return;
    }

    if (this._markerSeen > 0) {
      if (byte === MARKER_BYTE) {
        this._markerSeen++;
        if (this._markerSeen === EOF_MARKER_BYTES.length) {
          this._done = true;
        }
        return;
      }
      // Marker run broken. Per streamUnwrap semantics, the bytes we
      // consumed validating the marker are lost; return what we have.
      this._done = true;
      return;
    }

    if (byte === MARKER_BYTE) {
      this._markerSeen = 1;
      return;
    }

    if (byte === ESCAPE_BYTE) {
      this._escapePending = true;
      return;
    }

    this._out.push(byte);
  }

  // Returns and clears any payload bytes emitted since the last drain.
  drain() {
    if (this._out.length === 0) return new Uint8Array(0);
    const out = Uint8Array.from(this._out);
    this._out.length = 0;
    return out;
  }

  // Called when the input bit / byte source ends without a clean marker.
  // Sets done and returns whatever bytes are still buffered.
  finish() {
    this._done = true;
    return this.drain();
  }

  get done() { return this._done; }
}

export function streamUnwrap(bytes) {
  const reader = new BitReader(bytes);
  const writer = new BitWriter();

  // Read one byte; return -1 if no real bytes are left in the input.
  // (We never opt the reader into a random-tail RNG here, so once
  // bytesRemaining hits 0, there are no more real bytes.)
  const readByteOrEOF = () => reader.bytesRemaining === 0 ? -1 : reader.readBits(8);

  for (;;) {
    const byte = readByteOrEOF();
    if (byte === -1) return writer.finish();

    if (byte === MARKER_BYTE) {
      // Validate rest of marker. Bail (return what we have) on EOF or mismatch.
      let valid = true;
      for (let i = 1; i < EOF_MARKER_BYTES.length; i++) {
        const next = readByteOrEOF();
        if (next !== MARKER_BYTE) { valid = false; break; }
      }
      // valid: real EOF marker, return as designed.
      // !valid: either ran out of bytes, or random 0xAA in the input
      // wasn't actually a marker. Either way, return what we have so the
      // user sees a (probably-garbage) recovery instead of an exception.
      return writer.finish();
    }

    if (byte === ESCAPE_BYTE) {
      const next = readByteOrEOF();
      if (next === -1) return writer.finish(); // truncated mid-escape
      writer.writeBits(next ^ XOR_MASK, 8);
      continue;
    }

    writer.writeBits(byte, 8);
  }
}
