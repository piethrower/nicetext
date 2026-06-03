// SCRAMBLE: recover cover text to bits. Streaming surface, streaming internals.
//
// decode(input, output, dict, opts) reads cover-text bytes from a
// ReadableStream<Uint8Array> via TextDecoderStream, tokenizes the
// resulting text chunks with a 256-char carry-over buffer (so a WORD
// cannot split across a chunk boundary), looks each WORD up in the
// dict for its huffman code, accumulates bits into a BitWriter, and
// drives those bits through an IncrementalUnwrap state machine that
// emits recovered payload bytes to the output WritableStream as they
// form. No drainInputToBytes, no whole-cover tokenize.
//
// Browser-safe ESM. No Node deps.

import { tokenizeStream, phraseFuseAsync, TOKEN } from './lexer.js';
import { BitWriter } from './bitstream.js';
import { IncrementalUnwrap } from './stream.js';
import { lookupWord } from './dictionary.js';

const YIELD_EVERY = 64;

export async function decode(input, output, dict, opts = {}) {
  const { onProgress = null } = opts;
  const writer = output.getWriter();

  // textStream is hoisted so the `finally` can cancel it. When decode
  // exits early (saw the EOF marker, `unwrap.done` becomes true), the
  // for-await break causes tokenizeStream's generator to release its
  // lock on textStream, but `releaseLock` is not `cancel`. The
  // upstream TransformStream (used by encode's validator branch in
  // _encodeWithDecode) would then sit unread and any further producer
  // write would block on backpressure forever. Explicitly cancelling
  // textStream propagates "no more bytes" all the way up so pending
  // writes reject promptly, which the validator-fanout swallows.
  let textStream = null;
  try {
    textStream = input.pipeThrough(new TextDecoderStream());
    const rawTokens = tokenizeStream(textStream, { maxWordLength: dict.maxWordLength + 8 });
    // Step 4 phrase fusion: when the dict has multi-word entries, wrap
    // the raw token stream so cover-side phrases (`a la carte`,
    // `de facto`, etc.) fuse into single WORD tokens before lookup.
    // Passes through unchanged when `dict.phraseIndex` is empty (the
    // common case before any source ships phrases).
    const tokens = phraseFuseAsync(rawTokens, dict.phraseIndex, dict.maxPhraseLen);

    const bw = new BitWriter();
    const unwrap = new IncrementalUnwrap();
    let wordsProcessed = 0;
    let bytesEmitted = 0; // running total of recovered secret bytes

    // Pull complete bytes off the BitWriter, push them through the
    // unwrap machine, and flush any recovered payload bytes to output.
    async function pumpUnwrappedBytes() {
      const completeBytes = bw.drainCompleteBytes();
      for (const b of completeBytes) {
        unwrap.pushByte(b);
        if (unwrap.done) break;
      }
      const out = unwrap.drain();
      if (out.length > 0) {
        bytesEmitted += out.length;
        await writer.write(out);
      }
    }

    for await (const tok of tokens) {
      if (unwrap.done) break;
      if (tok.type !== TOKEN.WORD) continue;
      const w = tok.value.toLowerCase();
      const entry = lookupWord(dict, w);
      if (entry && entry.bits !== 0) bw.writeBits(entry.code, entry.bits);
      // Unknown words and single-word-type words contribute nothing but
      // still count as progress for cadence accounting.
      wordsProcessed++;
      if (wordsProcessed % YIELD_EVERY === 0) {
        await pumpUnwrappedBytes();
        if (unwrap.done) break;
        if (onProgress) {
          try { await onProgress({ wordsProcessed, bytesEmitted }); } catch {}
        }
        // Macrotask yield so port-backed cancel messages can be delivered
        // to a worker running this loop.
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (!unwrap.done) {
      // Drain remaining complete bytes.
      await pumpUnwrappedBytes();
    }
    if (!unwrap.done) {
      // Push the trailing partial byte (zero-padded by finish()) to
      // mirror the original pipe's behavior of feeding writer.finish()
      // into streamUnwrap.
      const tail = bw.finish();
      for (const b of tail) {
        unwrap.pushByte(b);
        if (unwrap.done) break;
      }
    }
    const out = unwrap.finish();
    if (out.length > 0) {
      bytesEmitted += out.length;
      await writer.write(out);
    }

    await writer.close();
  } catch (err) {
    try { await writer.abort(err); } catch {}
    throw err;
  } finally {
    try { writer.releaseLock(); } catch {}
    if (textStream) { try { await textStream.cancel(); } catch {} }
  }
}
