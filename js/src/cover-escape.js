// cover-escape.js
//
// Head-only escape filter for cover text. Accumulates the first
// HEAD_PEEK_BYTES of the stream, checks them against the shared
// HEAD_MARKERS registry (cover-markers.js), and prepends the
// disambiguator ` ! ` to the stream if any marker would fire.
// Everything beyond the head streams through unchanged.
//
// Why head-only (audit 2026-05-17 redesign): autoStrip's detector
// only looks at the head of the stream. Each apply transform handles
// its own body safety internally (entity-escape, CDATA-escape,
// gzip+base64 inside, etc.), so cover body lines that resemble a
// strip's terminator are already neutralized by the apply. The
// LaTeX envelope was the lone exception (verbatim couldn't self-
// escape `\\end{verbatim}`) and was dropped 2026-05-17, removing
// the last justification for cover-side body-line escape.
//
// The disambiguator ` ! ` (space-bang-space) is read by the lexer
// as WHITESPACE-PUNCT-WHITESPACE, all of which contribute 0 bits to
// the recovered payload. So the bit stream is identical with or
// without escape; the only effect is three extra visible characters
// at the start of the recovered cover textarea when the head matched.

import { matchHead, HEAD_PEEK_BYTES } from './cover-markers.js';

const TEXT_ENCODER = new TextEncoder();
const DISAMBIGUATOR = ' ! ';

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function escapeTransform() {
  let headBuf = new Uint8Array(0);
  let headDecided = false;

  function emitHead(controller) {
    if (matchHead(headBuf) !== null) {
      controller.enqueue(TEXT_ENCODER.encode(DISAMBIGUATOR));
    }
    if (headBuf.length > 0) controller.enqueue(headBuf);
    headBuf = new Uint8Array(0);
    headDecided = true;
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (headDecided) {
        controller.enqueue(chunk);
        return;
      }
      headBuf = concat(headBuf, chunk);
      if (headBuf.length >= HEAD_PEEK_BYTES) {
        emitHead(controller);
      }
    },
    flush(controller) {
      if (!headDecided) emitHead(controller);
    },
  });
}
