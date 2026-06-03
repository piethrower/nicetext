// Build a TR39 confusables map filtered to entries useful for NiceText.
//
// Input:  fixture-src/confusables/raw/confusables.txt
//           (gitignored, ephemeral; download with fixture-src/confusables/fetch.js)
// Output: fixture-src/confusables/cooked/confusables-data.js
//           (committed, authoritative; do not hand-edit)
//
// Staleness: this is a no-op unless raw/ is newer than cooked/. raw/
// is absent on a normal checkout (gitignored), so nothing rebuilds;
// the committed cooked/ is the source of truth. Only fetch.js (a
// Unicode-version bump) makes raw/ newer and triggers a rebuild.
// build-all-fixtures.js then copies cooked/ -> fixtures/confusables-data.js.
//
// Filter:
//   - SOURCE code point must NOT already be a WORD_CHAR
//     (`[\p{Script=Latin}0-9&#@$%*+]`). If it's already in WORD_CHAR,
//     the lexer accepts it, so no fold needed.
//   - SOURCE must be in a real non-Latin script (Cyrillic, Greek,
//     Cherokee, Armenian, etc.). We deliberately exclude
//     Script=Common and Script=Inherited so visually-confusable
//     punctuation like `|` → `l` and `×` → `x` doesn't fold into
//     word chars, those code points commonly appear intentionally
//     (separators, multiplication, dimensions) and folding them
//     would merge tokens that weren't supposed to be merged. The
//     point of the rule is to fix Cyrillic-`а`-in-"paper"-style
//     mixed-script splits, not to canonicalize ASCII punctuation.
//   - TARGET (one or more code points) must be entirely WORD_CHAR.
//     A target that isn't lex-friendly wouldn't help the round-trip.
//
// Run with: node tools/build-confusables-map.js
// Re-run after fetch.js pulls a newer Unicode release into raw/.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SRC = join(REPO, 'fixture-src', 'confusables', 'raw', 'confusables.txt');
const OUT = join(REPO, 'fixture-src', 'confusables', 'cooked', 'confusables-data.js');

// Staleness gate. raw/ is gitignored and ephemeral; if it's absent or
// no newer than the committed cooked/, there is nothing to rebuild.
if (!existsSync(SRC)) {
  process.stderr.write(
    `raw confusables source absent (${SRC}); cooked/ is authoritative, nothing to do.\n` +
    `Run fixture-src/confusables/fetch.js first to refresh from Unicode.\n`,
  );
  process.exit(0);
}
if (existsSync(OUT) && statSync(SRC).mtimeMs <= statSync(OUT).mtimeMs) {
  process.stderr.write(`cooked/ is up to date with raw/; nothing to do.\n`);
  process.exit(0);
}

const WORD_CHAR_RE = /^[\p{Script=Latin}0-9&#@$%*+]$/u;
const COMMON_OR_INHERITED_RE = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
function isWordChar(cp) {
  return WORD_CHAR_RE.test(String.fromCodePoint(cp));
}
function isCommonOrInherited(cp) {
  return COMMON_OR_INHERITED_RE.test(String.fromCodePoint(cp));
}
function targetIsAllWordChars(s) {
  for (const ch of s) {
    if (!isWordChar(ch.codePointAt(0))) return false;
  }
  return s.length > 0;
}

const raw = readFileSync(SRC, 'utf8');
const lines = raw.split('\n');

const entries = [];
let skippedSourceLatin = 0;
let skippedSourceCommon = 0;
let skippedTargetNonLatin = 0;
let skippedMalformed = 0;
let unicodeVersion = 'unknown';

for (const rawLine of lines) {
  // Pull `Version: X.Y.Z` from the header comments for traceability.
  const verMatch = /^# Version:\s*(\S+)/.exec(rawLine);
  if (verMatch) unicodeVersion = verMatch[1];

  // Strip comments + trim.
  const hashIdx = rawLine.indexOf('#');
  const body = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
  if (!body) continue;

  const parts = body.split(';').map(s => s.trim());
  if (parts.length < 2) { skippedMalformed++; continue; }
  const [srcHex, tgtHex] = parts;
  if (!srcHex || !tgtHex) { skippedMalformed++; continue; }

  const srcCp = parseInt(srcHex, 16);
  if (!Number.isFinite(srcCp)) { skippedMalformed++; continue; }

  const tgtCps = tgtHex.split(/\s+/).filter(Boolean).map(h => parseInt(h, 16));
  if (tgtCps.length === 0 || tgtCps.some(cp => !Number.isFinite(cp))) {
    skippedMalformed++;
    continue;
  }
  const tgtStr = String.fromCodePoint(...tgtCps);

  if (isWordChar(srcCp)) { skippedSourceLatin++; continue; }
  if (isCommonOrInherited(srcCp)) { skippedSourceCommon++; continue; }
  if (!targetIsAllWordChars(tgtStr)) { skippedTargetNonLatin++; continue; }

  entries.push([srcCp, tgtStr]);
}

// Stable order by source code point for diffability.
entries.sort((a, b) => a[0] - b[0]);

// Emit. Hex-format the source for readability; quote the target string.
function escapeChar(c) {
  const cp = c.codePointAt(0);
  if (cp < 0x20 || cp === 0x27 || cp === 0x5C) {
    return '\\u{' + cp.toString(16).toUpperCase() + '}';
  }
  return c;
}
function quoteTarget(s) {
  return "'" + [...s].map(escapeChar).join('') + "'";
}

const lines_out = [];
lines_out.push('// AUTO-GENERATED. Do not edit by hand.');
lines_out.push('// Regenerate with: node tools/build-confusables-map.js');
lines_out.push(`// Source: fixture-src/confusables/raw/confusables.txt (Unicode TR39 v${unicodeVersion})`);
lines_out.push(`// Filter: source not in WORD_CHAR, target entirely in WORD_CHAR.`);
lines_out.push(`// Entries: ${entries.length}`);
lines_out.push('');
lines_out.push('export const CONFUSABLES = new Map([');
for (const [cp, tgt] of entries) {
  lines_out.push(`  [0x${cp.toString(16).toUpperCase().padStart(4, '0')}, ${quoteTarget(tgt)}],`);
}
lines_out.push(']);');
lines_out.push('');

writeFileSync(OUT, lines_out.join('\n'));

process.stderr.write(
  `Wrote ${OUT}\n` +
  `  unicode version: ${unicodeVersion}\n` +
  `  entries kept: ${entries.length}\n` +
  `  skipped (source already WORD_CHAR): ${skippedSourceLatin}\n` +
  `  skipped (source in Common/Inherited): ${skippedSourceCommon}\n` +
  `  skipped (target not all WORD_CHAR): ${skippedTargetNonLatin}\n` +
  `  skipped (malformed): ${skippedMalformed}\n`
);
