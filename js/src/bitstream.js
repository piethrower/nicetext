// Bit-level streams over Uint8Array. MSB-first within each byte.
// Browser-safe ESM. No Node deps.

export class BitWriter {
  constructor() {
    this._bytes = [];
    this._buffer = 0;
    this._bits = 0;
  }

  writeBits(value, n) {
    // Codes from Huffman trees can exceed 32 bits with skewed distributions
    // on large vocabularies; allow up to 53 bits (JS safe-integer range).
    // For n > 32 we extract bits via division/modulo to avoid the 32-bit
    // signed shift gotcha.
    if (n < 0 || n > 53) throw new RangeError(`writeBits n must be 0..53, got ${n}`);
    for (let i = n - 1; i >= 0; i--) {
      const bit = i < 31 ? ((value >>> i) & 1) : (Math.floor(value / Math.pow(2, i)) & 1);
      this._buffer = ((this._buffer << 1) | bit) & 0xff;
      this._bits++;
      if (this._bits === 8) {
        this._bytes.push(this._buffer);
        this._buffer = 0;
        this._bits = 0;
      }
    }
  }

  finish() {
    if (this._bits > 0) {
      this._bytes.push((this._buffer << (8 - this._bits)) & 0xff);
      this._buffer = 0;
      this._bits = 0;
    }
    return new Uint8Array(this._bytes);
  }

  // Streaming partner to finish(). Returns whatever complete bytes are
  // currently buffered and clears them; the partial trailing byte (if
  // any) stays so subsequent writeBits keeps appending bit-aligned.
  // Caller drives this on a yield cadence and finalizes with finish()
  // at end-of-stream (which pads + emits the trailing partial byte).
  drainCompleteBytes() {
    if (this._bytes.length === 0) return new Uint8Array(0);
    const out = new Uint8Array(this._bytes);
    this._bytes = [];
    return out;
  }

  get bitsWritten() {
    return this._bytes.length * 8 + this._bits;
  }
}

export class BitReader {
  constructor(bytes, { randomBits = null } = {}) {
    this._bytes = bytes;
    this._byteIndex = 0;
    this._buffer = 0;
    this._bits = 0;
    this._randomBits = randomBits;
    this._exhausted = false;
    this._tailBitsRead = 0;
  }

  readBits(n) {
    if (n < 0 || n > 32) throw new RangeError(`readBits n must be 0..32, got ${n}`);
    let result = 0;
    for (let i = 0; i < n; i++) {
      if (this._bits === 0) this._loadByte();
      const bit = (this._buffer >>> 7) & 1;
      this._buffer = (this._buffer << 1) & 0xff;
      this._bits--;
      result = ((result << 1) | bit) >>> 0;
    }
    return result;
  }

  _loadByte() {
    if (this._byteIndex < this._bytes.length) {
      this._buffer = this._bytes[this._byteIndex++];
      this._bits = 8;
    } else {
      this._exhausted = true;
      // randomBits() must return [0, 1) like Math.random.
      const byte = this._randomBits ? Math.floor(this._randomBits() * 256) & 0xff : 0;
      this._buffer = byte;
      this._bits = 8;
      this._tailBitsRead += 8;
    }
  }

  get exhausted() { return this._exhausted; }
  get bytesRemaining() { return Math.max(0, this._bytes.length - this._byteIndex); }
  get tailBitsRead() { return this._tailBitsRead; }
}

// Streaming companion to BitReader. Reads bits from an async byte
// source instead of a fixed Uint8Array. Source contract:
//   nextChunk() : Promise<Uint8Array | null>
// Returns the next chunk of source bytes, or null when the finite
// source has run out. After that, the reader serves random bits from
// `randomBits()` (one byte's worth at a time, MSB-first, mirroring
// BitReader's tail behavior) and bumps `tailBitsRead` by 8 per byte.
//
// Hot-path pattern in the engine loop:
//   if (!reader.hasBits(1)) await reader.refill();
//   const bit = reader.readBitsSync(1);
// readBitsSync stays sync as long as the local chunk has bits; only
// the chunk-boundary refill is async.
export class AsyncBitReader {
  constructor(nextChunk, { randomBits = null } = {}) {
    this._next = nextChunk;
    this._chunk = null;
    this._chunkIndex = 0;
    this._bitOffset = 0;
    this._sourceDone = false;
    this._randomBits = randomBits;
    this._tailByte = 0;
    this._tailBitsAvail = 0;
    this._tailBitsRead = 0;
    this._bitsRead = 0;
  }

  // True if at least n bits can be served without an async pull. After
  // the finite source is done, the random tail is unbounded so the
  // answer is always true.
  hasBits(n) {
    if (this._sourceDone) return true;
    if (!this._chunk) return false;
    const avail = (this._chunk.length - this._chunkIndex) * 8 - this._bitOffset;
    return avail >= n;
  }

  async refill() {
    if (this._sourceDone) return;
    while (!this._chunk || this._chunkIndex >= this._chunk.length) {
      const next = await this._next();
      if (next === null) {
        this._sourceDone = true;
        this._chunk = null;
        return;
      }
      if (next.length > 0) {
        this._chunk = next;
        this._chunkIndex = 0;
        this._bitOffset = 0;
      }
    }
  }

  readBitsSync(n) {
    if (n < 0 || n > 32) throw new RangeError(`readBitsSync n must be 0..32, got ${n}`);
    let result = 0;
    for (let i = 0; i < n; i++) {
      let bit;
      if (this._chunk && this._chunkIndex < this._chunk.length) {
        const byte = this._chunk[this._chunkIndex];
        bit = (byte >>> (7 - this._bitOffset)) & 1;
        this._bitOffset++;
        if (this._bitOffset === 8) {
          this._bitOffset = 0;
          this._chunkIndex++;
        }
      } else if (this._sourceDone) {
        if (this._tailBitsAvail === 0) {
          this._tailByte = this._randomBits ? Math.floor(this._randomBits() * 256) & 0xff : 0;
          this._tailBitsAvail = 8;
          this._tailBitsRead += 8;
        }
        bit = (this._tailByte >>> (this._tailBitsAvail - 1)) & 1;
        this._tailBitsAvail--;
      } else {
        throw new Error('AsyncBitReader.readBitsSync: source not ready (call refill first)');
      }
      result = ((result << 1) | bit) >>> 0;
      this._bitsRead++;
    }
    return result;
  }

  get exhausted() { return this._sourceDone; }
  get tailBitsRead() { return this._tailBitsRead; }
  get bitsRead() { return this._bitsRead; }
}
