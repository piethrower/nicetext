// envelopes.js
//
// Envelope wrappers for the cover-text post-processing pipeline. Each
// envelope is a valid file in its declared format that, when opened in
// the natural viewer, renders the cover text as visible content. v1 set:
// HTML, PDF, EML, Markdown, LaTeX.
//
// All envelopes expose:
//   <envelope>ApplyTransform({ filename, subject }) -> TransformStream
//   <envelope>StripTransform() -> TransformStream
//
// Apply runs streaming where the format allows (HTML, EML, Markdown,
// LaTeX); PDF buffers the cover so it can compute object byte offsets
// for the xref table at the end. Strip parses just enough to find the
// content region, extracts cover bytes, and reverses any per-envelope
// escape (HTML entities, PDF string escapes).

// TEXT_DECODER is stateful under {stream: true}; a module-level shared
// instance leaks partial-multi-byte state across unrelated covers
// (audit 2026-05-17 Finding 3). Each factory now owns its own.
const TEXT_ENCODER = new TextEncoder();

// Streaming primitives, every apply/strip in this module is a thin
// wrapper around these. See js/src/cover-streaming.js for the engine.
import {
  streamingStripSimple,
  streamingStripComposed,
  streamingApplySimple,
  streamingApplyComposed,
  streamingReplacer,
  base64EncoderStream,
  base64DecoderStream,
} from './cover-streaming.js';

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------- HTML ----------
//
// <!DOCTYPE html>
// <html lang="en"><head><meta charset="utf-8"><title>{subject}</title></head>
// <body><h1>{subject}</h1><pre>{cover-entity-escaped}</pre></body></html>

function htmlEscapeChar(ch) {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

function htmlEscape(str) {
  return str.replace(/[<>&]/g, htmlEscapeChar);
}

function htmlUnescape(str) {
  // Order matters: replace &amp; LAST so we don't re-decode any &lt; / &gt;
  // that the original cover legitimately wrote in escaped form.
  return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function htmlApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  const safeSubject = htmlEscape(String(subject));
  const head =
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${safeSubject}</title></head>\n<body><h1>${safeSubject}</h1><pre>`;
  return streamingApplySimple({
    prefixBytes: TEXT_ENCODER.encode(head),
    suffixBytes: TEXT_ENCODER.encode('</pre></body></html>\n'),
    escapeFn: htmlEscape,
    // htmlEscape replaces single chars; no boundary carry needed.
  });
}

// HTML strip handles BOTH variants:
//   - "html" (plain): cover sits visibly in <pre>...</pre>, entity-escaped.
//   - "html-active": cover is gzip+base64 inside `const b64 = "...";`.
// Dispatcher peeks the first ~500 bytes after `<!DOCTYPE html>` to
// decide which strip shape to dispatch to. Both sub-paths are
// streaming primitives.
export function htmlStripTransform() {
  const PEEK_BYTES = 512;
  let peekBuf = new Uint8Array(0);
  let dispatched = false;
  let inner = null;       // the dispatched-to TransformStream
  let innerWriter = null; // its writer
  let innerDrain = null;  // promise draining its readable to our controller
  let outerController = null;
  const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

  function dispatchInner() {
    const text = TEXT_DECODER.decode(peekBuf);
    if (/const b64 = "/.test(text)) {
      // html-active: extract base64 between `const b64 = "` and `"`,
      // pipe through base64-decode → gunzip.
      inner = streamingStripComposed({
        headPattern: 'const b64 = "',
        tailPattern: '"',
        bodyTransforms: [
          () => base64DecoderStream(),
          () => new DecompressionStream('gzip'),
        ],
      });
    } else {
      // html plain: body in <pre>...</pre>, entity-unescape via the
      // generic streaming replacer (single-pass: avoids the
      // `&amp;lt;` → `<` trap that multi-pass `.replace` chains have).
      inner = streamingStripComposed({
        headPattern: /<pre>/i,
        tailPattern: '</pre>',
        bodyTransforms: [
          () => streamingReplacer([
            ['&lt;', '<'],
            ['&gt;', '>'],
            ['&amp;', '&'],
          ]),
        ],
      });
    }
    innerWriter = inner.writable.getWriter();
    const reader = inner.readable.getReader();
    innerDrain = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && outerController) outerController.enqueue(value);
        }
      } catch (e) {
        if (outerController) outerController.error(e);
      }
    })();
  }

  function concatBuf(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  return new TransformStream({
    async transform(chunk, controller) {
      outerController = controller;
      if (!dispatched) {
        peekBuf = concatBuf(peekBuf, chunk);
        if (peekBuf.length < PEEK_BYTES) return;
        dispatchInner();
        await innerWriter.write(peekBuf);
        peekBuf = new Uint8Array(0);
        dispatched = true;
        return;
      }
      await innerWriter.write(chunk);
    },
    async flush(controller) {
      outerController = controller;
      if (!dispatched) {
        dispatchInner();
        if (peekBuf.length > 0) await innerWriter.write(peekBuf);
        peekBuf = new Uint8Array(0);
        dispatched = true;
      }
      await innerWriter.close();
      await innerDrain;
    },
  });
}

// ---------- EML (RFC 822) ----------
//
// From: anon@example.com
// To: anon@example.com
// Subject: {subject}
// Date: Thu, 01 Jan 1970 00:00:00 +0000
// MIME-Version: 1.0
// Content-Type: text/plain; charset=utf-8
//
// {cover}

const EML_FROM = 'anon@example.com';
const EML_TO = 'anon@example.com';
const EML_DATE = 'Thu, 01 Jan 1970 00:00:00 +0000';

export function emlApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  // RFC 822 disallows newlines in header values. Sanitize: replace any
  // newline / CR in subject with a single space.
  const safeSubject = String(subject).replace(/[\r\n]+/g, ' ');
  const header =
    `From: ${EML_FROM}\r\n` +
    `To: ${EML_TO}\r\n` +
    `Subject: ${safeSubject}\r\n` +
    `Date: ${EML_DATE}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n`;
  return streamingApplySimple({
    prefixBytes: TEXT_ENCODER.encode(header),
    // Body is the cover text, raw, no escape; no suffix.
  });
}

export function emlStripTransform() {
  // Body starts after the first empty line (\r\n\r\n or \n\n), extends
  // to EOF, no terminator, no body unescape.
  return streamingStripSimple({
    headPattern: /\r?\n\r?\n/,
    tailPattern: null,
  });
}

// ---------- Markdown ----------
//
// # {subject}
//
// {cover}

export function markdownApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  const safeSubject = String(subject).replace(/[\r\n]+/g, ' ');
  return streamingApplySimple({
    prefixBytes: TEXT_ENCODER.encode(`# ${safeSubject}\n\n`),
  });
}

export function markdownStripTransform() {
  return streamingStripSimple({
    headPattern: /^# [^\r\n]{0,128}\r?\n\r?\n/,
    tailPattern: null,
  });
}

// (LaTeX envelope was hard-dropped 2026-05-17 as part of the marker-
// registry consolidation. Verbatim was the only envelope whose body
// couldn't be self-escaped by its apply transform, forcing a cover-
// side suffix escape that didn't fit the new prefix-only escape model.
// Pre-release, no field deployments to worry about. The share UI
// dropped the option in the same change; tests dropped the latex
// round-trip cases.)

// ---------- PDF ----------
//
// Minimal multi-page PDF (auto-paginated). Object plan:
//   1 = font (Times-Roman, base-14, no embedding)
//   2 = pages parent (emitted LAST, references all page object IDs)
//   3 = catalog (emitted LAST, references pages parent)
//   4..N = content streams and page objects, interleaved
//
// Cover lines are written via the Tj operator inside BT/ET blocks. Lines
// are not wrapped horizontally (PDF will render whatever fits; the rest
// extends past the page edge but the bytes are still in the content
// stream and recoverable by strip).
//
// PDF strings need the (, ), \ chars escaped on apply; strip reverses.

const PDF_PAGE_WIDTH = 612;        // letter, points (72 dpi)
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 72;             // 1 inch
const PDF_FONT_SIZE = 12;
const PDF_LINE_HEIGHT = 14;
const PDF_LINES_PER_PAGE = Math.floor((PDF_PAGE_HEIGHT - 2 * PDF_MARGIN) / PDF_LINE_HEIGHT);
const PDF_FIRST_LINE_Y = PDF_PAGE_HEIGHT - PDF_MARGIN;

function pdfEscapeString(s) {
  // Only these three byte-level escapes are needed for a Times-Roman
  // literal-string drawing op.
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pdfBuildContentStream(lines) {
  let s = 'BT\n/F1 ' + PDF_FONT_SIZE + ' Tf\n' + PDF_MARGIN + ' ' + PDF_FIRST_LINE_Y + ' Td\n';
  for (let i = 0; i < lines.length; i++) {
    s += '(' + pdfEscapeString(lines[i]) + ') Tj\n';
    if (i < lines.length - 1) s += '0 -' + PDF_LINE_HEIGHT + ' Td\n';
  }
  s += 'ET\n';
  return TEXT_ENCODER.encode(s);
}

function pdfPad10(n) {
  const s = String(n);
  return '0'.repeat(10 - s.length) + s;
}

// Streaming PDF apply: emit each page object as soon as a page's worth
// of lines arrives. Memory cost is O(one-page lines + offsets array +
// page-id array), bounded per page, not per cover. The xref table at
// the very end is computed from the in-memory offsets map (one entry
// per object; ~16 bytes × 2 × num-pages).
export function pdfApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let textBuf = '';
  let lineBuffer = [];
  let pos = 0;
  let controller;
  let firstChunk = true;
  // The original (non-streaming) apply did `cover.split('\n')`, which
  // preserves a trailing empty element if the cover ends with `\n`. The
  // streaming loop here drops it, so track the last cover-char to
  // restore the trailing "" at flush.
  let coverEndsWithNewline = false;
  const offsets = new Map();
  const pageObjIds = [];
  let nextId = 4;

  function pushBytes(bytes) { controller.enqueue(bytes); pos += bytes.length; }
  function pushStr(s) { pushBytes(TEXT_ENCODER.encode(s)); }
  function startObj(id) { offsets.set(id, pos); pushStr(`${id} 0 obj\n`); }
  function endObj() { pushStr(`\nendobj\n`); }

  function emitPage(lines) {
    const contentId = nextId++;
    const pageId = nextId++;
    const body = pdfBuildContentStream(lines);
    startObj(contentId);
    pushStr(`<</Length ${body.length}>>\nstream\n`);
    pushBytes(body);
    pushStr(`endstream`);
    endObj();
    startObj(pageId);
    pushStr(`<</Type/Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources <</Font <</F1 1 0 R>>>> /Contents ${contentId} 0 R>>`);
    endObj();
    pageObjIds.push(pageId);
  }

  function emitHeader() {
    pushStr('%PDF-1.4\n');
    pushBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    startObj(1);
    pushStr('<</Type/Font /Subtype/Type1 /BaseFont/Times-Roman>>');
    endObj();
  }

  return new TransformStream({
    start(c) {
      controller = c;
      emitHeader();
    },
    transform(chunk, c) {
      controller = c;
      let incoming = decoder.decode(chunk, { stream: true });
      if (incoming.length > 0) coverEndsWithNewline = incoming[incoming.length - 1] === '\n';
      if (firstChunk) {
        // Prepend subject + blank line so they render at the top of page 1.
        textBuf = String(subject) + '\n\n';
        firstChunk = false;
      }
      textBuf += incoming;
      let nl;
      while ((nl = textBuf.indexOf('\n')) >= 0) {
        lineBuffer.push(textBuf.slice(0, nl));
        textBuf = textBuf.slice(nl + 1);
        if (lineBuffer.length === PDF_LINES_PER_PAGE) {
          emitPage(lineBuffer);
          lineBuffer = [];
        }
      }
    },
    flush(c) {
      controller = c;
      // Drain any held bytes/text.
      const tail = decoder.decode(new Uint8Array(0), { stream: false });
      if (firstChunk) {
        textBuf = String(subject) + '\n\n' + tail;
        firstChunk = false;
      } else {
        textBuf += tail;
      }
      if (textBuf.length > 0) {
        // Final possibly-partial line + any unwritten trailing newlines.
        const parts = textBuf.split('\n');
        for (const line of parts) lineBuffer.push(line);
        textBuf = '';
      } else if (coverEndsWithNewline && lineBuffer.length > 0) {
        // Cover ended with \n; preserve the trailing empty line that
        // `cover.split('\n')` would have produced.
        lineBuffer.push('');
      }
      while (lineBuffer.length > 0) {
        const pageLines = lineBuffer.splice(0, PDF_LINES_PER_PAGE);
        emitPage(pageLines);
      }
      if (pageObjIds.length === 0) {
        // Degenerate: zero-byte cover; emit a one-page PDF with just subject.
        emitPage([String(subject)]);
      }
      // Pages-parent (object 2) and catalog (object 3): references resolve
      // by ID at parse time, so emitting them AFTER all pages is fine.
      startObj(2);
      const kidsList = pageObjIds.map(id => `${id} 0 R`).join(' ');
      pushStr(`<</Type/Pages /Kids [${kidsList}] /Count ${pageObjIds.length}>>`);
      endObj();
      startObj(3);
      pushStr(`<</Type/Catalog /Pages 2 0 R>>`);
      endObj();
      const xrefOffset = pos;
      const totalObjs = nextId;
      pushStr(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
      for (let id = 1; id < totalObjs; id++) {
        const off = offsets.get(id) ?? 0;
        pushStr(`${pdfPad10(off)} 00000 n \n`);
      }
      pushStr(`trailer\n<</Size ${totalObjs} /Root 3 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    },
  });
}

// Streaming PDF strip: state machine that scans for `stream\n` openers,
// then within each stream body extracts `(...) Tj` literals. Memory is
// O(longest line), one literal accumulator per active `(...)`. The
// scan buffer is a small sliding window (~10 chars) for marker detection.
export function pdfStripTransform() {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let state = 'outside';      // outside | in_stream | in_literal | after_paren
  let scanBuf = '';           // sliding window for marker detection
  let literal = '';           // contents of current (...)
  let afterParen = '';        // chars after `)` awaiting " Tj" confirmation
  let escaped = false;        // last char inside literal was `\`
  const TARGET_DROP = 2;      // subject + blank line we prepended on apply
  let linesDropped = 0;
  let emittedAny = false;
  const MAX_OPEN = 'stream\r\n'.length;
  const MAX_CLOSE = '\r\nendstream'.length;

  function emitLine(line, controller) {
    if (linesDropped < TARGET_DROP) { linesDropped++; return; }
    const prefix = emittedAny ? '\n' : '';
    controller.enqueue(TEXT_ENCODER.encode(prefix + line));
    emittedAny = true;
  }

  function processChar(c, controller) {
    if (state === 'outside') {
      scanBuf += c;
      if (scanBuf.endsWith('stream\n') || scanBuf.endsWith('stream\r\n')) {
        state = 'in_stream';
        scanBuf = '';
      } else if (scanBuf.length > MAX_OPEN) {
        scanBuf = scanBuf.slice(-MAX_OPEN);
      }
      return;
    }
    if (state === 'in_stream') {
      if (c === '(') {
        state = 'in_literal';
        literal = '';
        scanBuf = '';
        return;
      }
      scanBuf += c;
      if (scanBuf.endsWith('\nendstream') || scanBuf.endsWith('\r\nendstream')) {
        state = 'outside';
        scanBuf = '';
        return;
      }
      if (scanBuf.length > MAX_CLOSE) scanBuf = scanBuf.slice(-MAX_CLOSE);
      return;
    }
    if (state === 'in_literal') {
      if (escaped) { literal += c; escaped = false; return; }
      if (c === '\\') { escaped = true; return; }
      if (c === ')') { state = 'after_paren'; afterParen = ''; return; }
      literal += c;
      return;
    }
    if (state === 'after_paren') {
      afterParen += c;
      if (afterParen === ' Tj') {
        emitLine(literal, controller);
        literal = '';
        state = 'in_stream';
        afterParen = '';
        return;
      }
      if (afterParen.length === 3) {
        // Not " Tj", discard literal, replay afterParen through in_stream.
        literal = '';
        state = 'in_stream';
        const replay = afterParen;
        afterParen = '';
        for (let i = 0; i < replay.length; i++) processChar(replay[i], controller);
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (let i = 0; i < text.length; i++) processChar(text[i], controller);
    },
    flush(controller) {
      const tail = decoder.decode(new Uint8Array(0), { stream: false });
      for (let i = 0; i < tail.length; i++) processChar(tail[i], controller);
    },
  });
}

// ---------- Program / active envelope plumbing ----------
//
// Each "program" envelope (Python, JS, Java, etc.) carries the cover as
// a gzip-then-base64 string embedded in source code. All apply/strip
// pipelines use streamingApplyComposed / streamingStripComposed with
// CompressionStream + base64EncoderStream (apply side) and
// base64DecoderStream + DecompressionStream (strip side). No buffering;
// O(stream-chunk) memory regardless of cover size.

// Build a "program envelope" apply TransformStream: stream the cover
// through gzip → base64, then wrap with language-specific source code
// as fixed prefix/suffix. Uses streamingApplyComposed so memory is
// O(stream-chunk-size) regardless of cover size.
//
// prefixFn is called eagerly (subject/filename are known up front) and
// receives an empty b64 string, the source-code shape must split into
// `[before-base64][BASE64][after-base64]`. We synthesize the prefix by
// calling prefixFn('') and splitting at the `b64-marker` substring the
// caller passes alongside (see usage below).
function makeProgramApplyTransform(prefixBefore, prefixAfter) {
  // prefixBefore = source code that comes BEFORE the base64 literal.
  // prefixAfter  = source code that comes AFTER the base64 literal.
  // Caller is responsible for constructing both with subject baked in
  // via a factory closure if needed.
  return ({ filename = 'message', subject = 'Note' } = {}) => {
    return streamingApplyComposed({
      prefixBytes: TEXT_ENCODER.encode(prefixBefore({ filename, subject })),
      suffixBytes: TEXT_ENCODER.encode(prefixAfter({ filename, subject })),
      bodyTransforms: [
        () => new CompressionStream('gzip'),
        () => base64EncoderStream(),
      ],
    });
  };
}

function makeProgramStripTransform(openMarker, closeMarker) {
  return () => {
    return streamingStripComposed({
      headPattern: openMarker,
      tailPattern: closeMarker,
      bodyTransforms: [
        () => base64DecoderStream(),
        () => new DecompressionStream('gzip'),
      ],
    });
  };
}

// Same shape but without gzip, for envelopes where the recipient
// doesn't have a stdlib gzip (C++).
function makeBase64OnlyApplyTransform(prefixBefore, prefixAfter) {
  return ({ filename = 'message', subject = 'Note' } = {}) => {
    return streamingApplyComposed({
      prefixBytes: TEXT_ENCODER.encode(prefixBefore({ filename, subject })),
      suffixBytes: TEXT_ENCODER.encode(prefixAfter({ filename, subject })),
      bodyTransforms: [
        () => base64EncoderStream(),
      ],
    });
  };
}

function makeBase64OnlyStripTransform(openMarker, closeMarker) {
  return () => {
    return streamingStripComposed({
      headPattern: openMarker,
      tailPattern: closeMarker,
      bodyTransforms: [
        () => base64DecoderStream(),
      ],
    });
  };
}

// ---------- HTML (active script variant) ----------

export const htmlActiveApplyTransform = makeProgramApplyTransform(
  ({ subject }) => {
    const safe = htmlEscape(String(subject));
    return (
      `<!DOCTYPE html>\n` +
      `<html lang="en"><head><meta charset="utf-8"><title>${safe}</title></head>\n` +
      `<body><h1>${safe}</h1><pre id="cover"></pre>\n` +
      `<script>\n` +
      `(async () => {\n` +
      `  const b64 = "`
    );
  },
  () =>
    `";\n` +
    `  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));\n` +
    `  const stream = new Response(bin).body.pipeThrough(new DecompressionStream("gzip"));\n` +
    `  document.getElementById("cover").textContent = await new Response(stream).text();\n` +
    `})();\n` +
    `</script></body></html>\n`,
);

// htmlStripTransform (above) handles both plain and active variants.

// ---------- nroff / man page ----------
//
// .TH "{subject}" 7 "1970-01-01" "" ""
// .SH NAME
// {subject} \- a note
// .SH DESCRIPTION
// {cover-roff-escaped}

// Position-agnostic (symmetric) escape: every \ → \\, every . → \&.,
// every ' → \&'. The leading-only escape would be cleaner output but
// not chunk-safe (a leading-position check at chunk boundary requires
// state); symmetric is per-char so streaming with no carry.
//
// Wrapped nroff has slightly more `\&` insertions than minimally
// required, but `\&` is zero-width when rendered by `man`, so the
// rendered cover is identical. Round-trip is preserved.
function nroffEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/\./g, '\\&.').replace(/'/g, "\\&'");
}

function nroffQuoteHeader(s) {
  return `"${String(s).replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')}"`;
}

export function nroffApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  const head =
    `.TH ${nroffQuoteHeader(subject)} 7 "1970-01-01" "" ""\n` +
    `.SH NAME\n` +
    `${nroffEscape(String(subject))} \\- a note\n` +
    `.SH DESCRIPTION\n`;
  return streamingApplySimple({
    prefixBytes: TEXT_ENCODER.encode(head),
    escapeFn: nroffEscape,
    // escapeFn is per-char (no cross-char dependency); no boundary carry needed.
  });
}

export function nroffStripTransform() {
  return streamingStripComposed({
    headPattern: /\.SH DESCRIPTION\n/,
    tailPattern: null,
    bodyTransforms: [
      // Order: longer patterns first (\&. and \&' are 3 chars; \\ is 2).
      // Critical for single-pass correctness, see streamingReplacer.
      () => streamingReplacer([
        ['\\&.', '.'],
        ["\\&'", "'"],
        ['\\\\', '\\'],
      ]),
    ],
  });
}

// ---------- XML ----------
//
// <?xml version="1.0" encoding="UTF-8"?>
// <note>
// <subject>{subject-entity-escaped}</subject>
// <body><![CDATA[
// {cover with `]]>` → `]]]]><![CDATA[>` escape
// ]]></body>
// </note>

function xmlAttrEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function xmlApplyTransform({ filename = 'message', subject = 'Note' } = {}) {
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<note>\n` +
    `<subject>${xmlAttrEscape(subject)}</subject>\n` +
    `<body><![CDATA[\n`;
  const tail = `\n]]></body>\n</note>\n`;
  return streamingApplyComposed({
    prefixBytes: TEXT_ENCODER.encode(head),
    suffixBytes: TEXT_ENCODER.encode(tail),
    // CDATA escape: `]]>` → `]]]]><![CDATA[>` (close one CDATA, open
    // another; net content is `]]>`). 3-char input pattern handled
    // chunk-safely by streamingReplacer.
    bodyTransforms: [
      () => streamingReplacer([
        [']]>', ']]]]><![CDATA[>'],
      ]),
    ],
  });
}

export function xmlStripTransform() {
  return streamingStripComposed({
    headPattern: /<!\[CDATA\[\n/,
    tailPattern: '\n]]></body>',
    bodyTransforms: [
      () => streamingReplacer([
        [']]]]><![CDATA[>', ']]>'],
      ]),
    ],
  });
}

// ---------- Python ----------
//
// import base64
// import gzip
// import sys
// sys.stdout.write(gzip.decompress(base64.b64decode("<b64>")).decode("utf-8"))

const PYTHON_OPEN = `base64.b64decode("`;
const PYTHON_CLOSE = `"))`;
export const pythonApplyTransform = makeProgramApplyTransform(
  () =>
    `import base64\n` +
    `import gzip\n` +
    `import sys\n` +
    `sys.stdout.write(gzip.decompress(${PYTHON_OPEN}`,
  () => `${PYTHON_CLOSE}.decode("utf-8"))\n`,
);
export const pythonStripTransform = makeProgramStripTransform(PYTHON_OPEN, PYTHON_CLOSE);

// ---------- JavaScript (Node) ----------

const JS_OPEN = `Buffer.from("`;
const JS_CLOSE = `", "base64")`;
export const javascriptApplyTransform = makeProgramApplyTransform(
  () => `process.stdout.write(require("zlib").gunzipSync(${JS_OPEN}`,
  () => `${JS_CLOSE}));\n`,
);
export const javascriptStripTransform = makeProgramStripTransform(JS_OPEN, JS_CLOSE);

// ---------- C++ (base64 only, no stdlib gzip) ----------

const CPP_OPEN = `static const char enc[] = "`;
const CPP_CLOSE = `";`;
export const cppApplyTransform = makeBase64OnlyApplyTransform(
  () =>
    `#include <iostream>\n` +
    `#include <string>\n` +
    `int main() {\n` +
    `    ${CPP_OPEN}`,
  () =>
    `${CPP_CLOSE}\n` +
    `    std::string out;\n` +
    `    int val = 0, valb = -8;\n` +
    `    for (char c : enc) {\n` +
    `        if (c == '=' || c == 0) break;\n` +
    `        int d;\n` +
    `        if (c >= 'A' && c <= 'Z') d = c - 'A';\n` +
    `        else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;\n` +
    `        else if (c >= '0' && c <= '9') d = c - '0' + 52;\n` +
    `        else if (c == '+') d = 62;\n` +
    `        else if (c == '/') d = 63;\n` +
    `        else continue;\n` +
    `        val = (val << 6) + d;\n` +
    `        valb += 6;\n` +
    `        if (valb >= 0) { out.push_back(char((val >> valb) & 0xFF)); valb -= 8; }\n` +
    `    }\n` +
    `    std::cout << out;\n` +
    `}\n`,
);
export const cppStripTransform = makeBase64OnlyStripTransform(CPP_OPEN, CPP_CLOSE);

// ---------- Java ----------

const JAVA_OPEN = `String b64 = "`;
const JAVA_CLOSE = `";`;
export const javaApplyTransform = makeProgramApplyTransform(
  () =>
    `import java.util.Base64;\n` +
    `import java.io.*;\n` +
    `import java.util.zip.*;\n` +
    `class Note {\n` +
    `    public static void main(String[] args) throws Exception {\n` +
    `        ${JAVA_OPEN}`,
  () =>
    `${JAVA_CLOSE}\n` +
    `        byte[] gz = Base64.getDecoder().decode(b64);\n` +
    `        ByteArrayOutputStream out = new ByteArrayOutputStream();\n` +
    `        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz))) {\n` +
    `            in.transferTo(out);\n` +
    `        }\n` +
    `        System.out.write(out.toByteArray());\n` +
    `    }\n` +
    `}\n`,
);
export const javaStripTransform = makeProgramStripTransform(JAVA_OPEN, JAVA_CLOSE);

// ---------- Perl ----------

const PERL_OPEN = `decode_base64("`;
const PERL_CLOSE = `");`;
export const perlApplyTransform = makeProgramApplyTransform(
  () =>
    `#!/usr/bin/perl\n` +
    `use MIME::Base64;\n` +
    `use IO::Uncompress::Gunzip qw(gunzip);\n` +
    `my $bin = ${PERL_OPEN}`,
  () =>
    `${PERL_CLOSE}\n` +
    `gunzip(\\$bin => \\my $out);\n` +
    `print $out;\n`,
);
export const perlStripTransform = makeProgramStripTransform(PERL_OPEN, PERL_CLOSE);

// ---------- PHP ----------

const PHP_OPEN = `base64_decode("`;
const PHP_CLOSE = `"))`;
export const phpApplyTransform = makeProgramApplyTransform(
  () =>
    `<?php\n` +
    `echo gzdecode(${PHP_OPEN}`,
  () => `${PHP_CLOSE};\n`,
);
export const phpStripTransform = makeProgramStripTransform(PHP_OPEN, PHP_CLOSE);

// ---------- Ruby ----------

const RUBY_OPEN = `Base64.decode64("`;
const RUBY_CLOSE = `")`;
export const rubyApplyTransform = makeProgramApplyTransform(
  () =>
    `require 'base64'\n` +
    `require 'zlib'\n` +
    `require 'stringio'\n` +
    `print Zlib::GzipReader.new(StringIO.new(${RUBY_OPEN}`,
  () => `${RUBY_CLOSE})).read\n`,
);
export const rubyStripTransform = makeProgramStripTransform(RUBY_OPEN, RUBY_CLOSE);

// ---------- Bash ----------
//
// Heredoc-carried payload piped through `base64 -d | gunzip -c`.

const BASH_OPEN = `base64 -d <<EOF | gunzip -c\n`;
const BASH_CLOSE = `\nEOF`;
export const bashApplyTransform = makeProgramApplyTransform(
  () => `#!/bin/bash\n${BASH_OPEN}`,
  () => `${BASH_CLOSE}\n`,
);
export const bashStripTransform = makeProgramStripTransform(BASH_OPEN, BASH_CLOSE);

// ---------- Go ----------

const GO_OPEN = `b64 := "`;
const GO_CLOSE = `"`;
export const goApplyTransform = makeProgramApplyTransform(
  () =>
    `package main\n` +
    `import (\n` +
    `    "bytes"\n` +
    `    "compress/gzip"\n` +
    `    "encoding/base64"\n` +
    `    "io"\n` +
    `    "os"\n` +
    `)\n` +
    `func main() {\n` +
    `    ${GO_OPEN}`,
  () =>
    `${GO_CLOSE}\n` +
    `    gz, _ := base64.StdEncoding.DecodeString(b64)\n` +
    `    r, _ := gzip.NewReader(bytes.NewReader(gz))\n` +
    `    io.Copy(os.Stdout, r)\n` +
    `}\n`,
);
export const goStripTransform = makeProgramStripTransform(GO_OPEN, GO_CLOSE);
