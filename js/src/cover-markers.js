// cover-markers.js: single source of truth for "what bytes at the head
// of a stream identify this wrapper."
//
// Both autoStrip's detector (cover-pipeline.js / detectWrapper) and the
// cover-side escape pass (cover-escape.js / escapeTransform) consume
// this registry. Keeping the patterns in one place eliminates the
// detector-vs-escape disagreement that caused audit-2026-05-17
// Findings 1 and 2.
//
// Design (audit 2026-05-17):
//   - Detector and escape must agree. If detector fires on a head shape,
//     escape must defang it (so a bare cover that happens to match a
//     head pattern doesn't get spuriously unwrapped on Reveal).
//   - For "ours-only" wrappers (program envelopes, html-active), the
//     pattern is the FULL apply prefix, long enough that natural prose
//     essentially never matches.
//   - For "standards-conforming" wrappers (html, eml, markdown, etc.),
//     the pattern is the standards opening; cover lines that legitimately
//     start with the same opening get the ` ! ` disambiguator (the
//     accepted project trade-off for accepting EML / HTML / Markdown
//     wrappers produced by external tools).
//   - Suffix patterns are NOT in this registry. Each apply transform
//     handles its own body safety internally (entity-escape, CDATA-
//     escape, gzip+base64, etc.). The latex envelope was the lone
//     exception and was dropped 2026-05-17.
//
// Browser-safe ESM. No deps.

import { isBase64LeadingLine } from './wrappers.js';

// Each entry:
//   stripName: the key returned by matchHead(); used by autoStrip to
//     pick the strip transform (cover-pipeline.js / stripFactoryFor).
//   binary:    optional, array of leading byte values that must match
//     exactly. If present, pattern is ignored.
//   pattern:   optional, regex tested against the head bytes decoded as
//     UTF-8 with replacement chars. Anchored with ^.
//
// Order matters. Distinctive literal prefixes go FIRST so they don't
// shadow looser patterns. Bare base64 detection is structural, runs
// last as a fallback, and is hard-coded in matchHead.
export const HEAD_MARKERS = [
  // Format layers.
  { stripName: 'gzip',     binary: [0x1F, 0x8B] },
  { stripName: 'uuencode', pattern: /^begin \d{3} [^\n]{1,128}/ },

  // Document envelopes. html and html-active share the same opener;
  // the html strip disambiguates internally by content-sniffing for
  // `const b64 = "…"` (active) vs <pre>…</pre> (plain).
  { stripName: 'html',     pattern: /^<!DOCTYPE html>/i },
  { stripName: 'pdf',      pattern: /^%PDF-1\.\d/ },
  { stripName: 'eml',      pattern: /^From: / },
  { stripName: 'markdown', pattern: /^# [^\r\n]{0,128}\r?\n\r?\n/ },
  { stripName: 'nroff',    pattern: /^\.TH / },
  { stripName: 'xml',      pattern: /^<\?xml/ },

  // Program envelopes. FULL apply prefix. Each match commits the
  // stream to that envelope's strip. Prose starting with `<?php` /
  // `import base64` / `package main` / etc. won't satisfy the rest of
  // the prefix and so won't false-trigger (audit Finding 1).
  { stripName: 'php',        pattern: /^<\?php\necho gzdecode\(base64_decode\("/ },
  { stripName: 'python',     pattern: /^import base64\nimport gzip\nimport sys\nsys\.stdout\.write\(gzip\.decompress\(base64\.b64decode\("/ },
  { stripName: 'javascript', pattern: /^process\.stdout\.write\(require\("zlib"\)\.gunzipSync\(Buffer\.from\("/ },
  { stripName: 'java',       pattern: /^import java\.util\.Base64;\nimport java\.io\.\*;\nimport java\.util\.zip\.\*;\nclass Note \{/ },
  { stripName: 'perl',       pattern: /^#!\/usr\/bin\/perl\nuse MIME::Base64;\nuse IO::Uncompress::Gunzip qw\(gunzip\);/ },
  { stripName: 'ruby',       pattern: /^require 'base64'\nrequire 'zlib'\nrequire 'stringio'\nprint Zlib::GzipReader\.new\(StringIO\.new\(Base64\.decode64\("/ },
  { stripName: 'bash',       pattern: /^#!\/bin\/bash\nbase64 -d <<EOF \| gunzip -c\n/ },
  { stripName: 'cpp',        pattern: /^#include <iostream>\n#include <string>\nint main\(\) \{\n    static const char enc\[\] = "/ },
  { stripName: 'go',         pattern: /^package main\nimport \(\n    "bytes"\n    "compress\/gzip"/ },
];

// Longest prefix the registry can match against. Escape peeks at least
// this many bytes before deciding whether to prepend the disambiguator;
// autoStrip peeks at least this many bytes before calling matchHead.
// Padded for headroom, exact computation isn't worth the brittleness.
export const HEAD_PEEK_BYTES = 256;

// Returns the stripName of the matching marker, or null if no marker
// fires. Used by both detectWrapper (which dispatches to a strip) and
// escapeTransform (which uses the boolean form: matchHead(head) !==
// null → prepend ` ! `).
export function matchHead(bytes) {
  if (!bytes || bytes.length === 0) return null;

  // Binary checks first. Don't bother decoding bytes that obviously
  // aren't UTF-8 (e.g., gzip magic).
  for (const m of HEAD_MARKERS) {
    if (!m.binary) continue;
    if (bytes.length < m.binary.length) continue;
    let ok = true;
    for (let i = 0; i < m.binary.length; i++) {
      if (bytes[i] !== m.binary[i]) { ok = false; break; }
    }
    if (ok) return m.stripName;
  }

  // Text-pattern checks. One decoder per call (no shared state, audit
  // 2026-05-17 Finding 3).
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  for (const m of HEAD_MARKERS) {
    if (!m.pattern) continue;
    if (m.pattern.test(text)) return m.stripName;
  }

  // Bare base64 fallback. Structural check on the first line; must come
  // AFTER all literal prefixes above since base64 alphabet overlaps
  // with the leading bytes of many of them. isBase64LeadingLine now
  // strips trailing \r and requires length-mod-4 or trailing `=`
  // (audit Finding 2), so a short single-alphanumeric-word line no
  // longer trips this.
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl >= 0 ? text.slice(0, firstNl) : text;
  if (isBase64LeadingLine(firstLine)) return 'base64';

  return null;
}
