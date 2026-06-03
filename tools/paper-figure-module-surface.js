// Renders the §7 module-surface paper figure: OG C++ headers (left
// column) vs the js/src/ ESM exports (right column), grouped by
// source-tree section. No measurement, the figure is a static map
// of how the C++ subsystems collapse onto the JS modules.
//
// Output is a self-contained SVG on stdout, suitable for inline
// embedding in whats-new.html §7.
//
// Usage:  node tools/paper-figure-module-surface.js > tmp/module-surface.svg
//         OG_PATH=../OG-NiceText-C++/nicetext-1.0 node tools/...
//
// The OG C++ repo is a sibling checkout by default (../OG-NiceText-
// C++/nicetext-1.0 from this repo's root). Override via OG_PATH if
// the layout differs.

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OG_PATH = process.env.OG_PATH
  ? resolve(process.cwd(), process.env.OG_PATH)
  : resolve(REPO_ROOT, '..', 'OG-NiceText-C++', 'nicetext-1.0');

function walkExt(root, ext) {
  const out = [];
  function visit(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = resolve(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) visit(p);
      else if (s.isFile() && name.endsWith(ext)) out.push(p);
    }
  }
  visit(root);
  return out;
}

// ---- collect C++ headers, group by top-level subsystem ----
const cppHeaders = walkExt(OG_PATH, '.h');
const cppGroups = new Map(); // subdir → [filenames]
for (const p of cppHeaders) {
  const rel = p.slice(OG_PATH.length + 1);
  const subdir = rel.split('/')[0];
  if (!cppGroups.has(subdir)) cppGroups.set(subdir, []);
  cppGroups.get(subdir).push(basename(p));
}

// ---- collect JS modules, group by directory ----
const jsRoot = resolve(REPO_ROOT, 'js', 'src');
const jsFiles = walkExt(jsRoot, '.js');
const jsGroups = new Map(); // 'root' / 'builder' / 'worker' / 'grammar' → [filenames]
for (const p of jsFiles) {
  const rel = p.slice(jsRoot.length + 1);
  const parts = rel.split('/');
  const key = parts.length === 1 ? 'engine' : parts[0];
  if (!jsGroups.has(key)) jsGroups.set(key, []);
  jsGroups.get(key).push(basename(p));
}

// ---- ordered display rows, with cross-side mapping ----
// Each row is one band in the SVG. The C++ subsystem on the left maps
// to one or more JS groups on the right; we render a faint connector
// line so the eye can trace which side absorbed which.
const ROWS = [
  {
    cpp: { key: 'babble',  label: 'babble/',  blurb: 'encode + decode (txt2bits, bits2txt, grammar)' },
    js:  { key: 'engine',  label: 'engine (top-level js/src/)', blurb: 'encode.js, decode.js, lexer.js, dictionary.js, modeltable.js, ...' },
  },
  {
    cpp: { key: 'gendict', label: 'gendict/', blurb: 'dictionary builder (typearec, dictarec, sentmdl, scanword, sorttwl)' },
    js:  { key: 'builder', label: 'js/src/builder/', blurb: 'sortdct, dct2mstr, genmodel, sab-pack, huffman, typehash, ...' },
  },
  {
    cpp: { key: 'mtc++',   label: 'mtc++/',   blurb: 'shared utilities (bitstream, RBT, BST, heap, list, string, codemk)' },
    js:  { key: 'shared',  label: 'engine + builder',           blurb: 'bitstream.js, fingerprint.js, random.js; plus V8 / DOM provide string, list, map' },
  },
  {
    cpp: { key: 'gnu',     label: 'gnu/',     blurb: 'third-party shims (dlmalloc, FlexLexer, getopt)' },
    js:  { key: '__none__',label: '(runtime / browser)',        blurb: 'replaced by V8 GC, native regex / streams, process.argv' },
  },
  {
    cpp: { key: 'nttpd',   label: 'nttpd/',   blurb: 'HTTP server daemon (postdata)' },
    js:  { key: '__none__',label: '(browser)',                  blurb: 'the page IS the front-end; no server-side endpoint' },
  },
  {
    cpp: { key: '__none__',label: '(no C++ analogue)', blurb: '' },
    js:  { key: 'worker',  label: 'js/src/worker/',  blurb: 'engine-worker, build-session-worker, parent-port, spawn (cross-runtime shim)' },
  },
  {
    cpp: { key: '__none__',label: '(folded into babble grammar)', blurb: '' },
    js:  { key: 'grammar', label: 'js/src/grammar/',  blurb: 'parser, expand, expgram, format' },
  },
];

function countFor(side, key) {
  if (key === '__none__') return 0;
  const groups = side === 'cpp' ? cppGroups : jsGroups;
  return groups.get(key)?.length || 0;
}

// ---- SVG layout ----
const W = 720;
const PADX = 16;
const COL_W = (W - PADX * 3) / 2;
const HEADER_H = 30;
const ROW_H = 64;
const ROW_GAP = 8;
const H = HEADER_H + 24 + ROWS.length * (ROW_H + ROW_GAP) + 20;
const LEFT_X = PADX;
const RIGHT_X = PADX + COL_W + PADX;

function escape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function boxText(x, y, label, count, blurb, isPlaceholder) {
  const fill = isPlaceholder
    ? 'rgba(128,128,128,0.04)'
    : 'rgba(128,128,128,0.08)';
  const stroke = isPlaceholder
    ? 'currentColor" stroke-opacity="0.20" stroke-dasharray="3 3'
    : 'currentColor" stroke-opacity="0.45';
  const labelFill = isPlaceholder ? 'currentColor" opacity="0.55' : 'currentColor';
  const countStr = count > 0 ? `${count} file${count === 1 ? '' : 's'}` : '';
  const out = [];
  out.push(`<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" rx="4" fill="${fill}" stroke="${stroke}"/>`);
  out.push(`<text x="${x + 10}" y="${y + 18}" font-size="12" font-weight="600" fill="${labelFill}">${escape(label)}</text>`);
  if (countStr) {
    out.push(`<text x="${x + COL_W - 10}" y="${y + 18}" font-size="11" text-anchor="end" fill="currentColor" opacity="0.55">${countStr}</text>`);
  }
  if (blurb) {
    out.push(`<text x="${x + 10}" y="${y + 40}" font-size="10.5" fill="currentColor" opacity="0.75">${escape(blurb)}</text>`);
  }
  return out.join('\n');
}

// ---- render ----
const parts = [];
parts.push(`<svg class="paper-figure" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="C++ module surface vs JS module surface, side by side.">`);
// column headers
parts.push(`<text x="${LEFT_X + COL_W / 2}" y="${HEADER_H - 6}" font-size="13" font-weight="600" text-anchor="middle" fill="currentColor">OG C++ (1995–2001)</text>`);
parts.push(`<text x="${RIGHT_X + COL_W / 2}" y="${HEADER_H - 6}" font-size="13" font-weight="600" text-anchor="middle" fill="var(--accent, #2b6cb0)">JS port (2026)</text>`);
// subhead counts (totals)
const cppTotal = cppHeaders.length;
const jsTotal = jsFiles.length;
parts.push(`<text x="${LEFT_X + COL_W / 2}" y="${HEADER_H + 10}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.6">${cppTotal} header files</text>`);
parts.push(`<text x="${RIGHT_X + COL_W / 2}" y="${HEADER_H + 10}" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.6">${jsTotal} ESM modules</text>`);

let y = HEADER_H + 24;
for (const row of ROWS) {
  const cppCount = countFor('cpp', row.cpp.key);
  const jsCount = countFor('js', row.js.key);
  const cppPlaceholder = row.cpp.key === '__none__';
  const jsPlaceholder = row.js.key === '__none__';
  parts.push(boxText(LEFT_X, y, row.cpp.label, cppCount, row.cpp.blurb, cppPlaceholder));
  parts.push(boxText(RIGHT_X, y, row.js.label, jsCount, row.js.blurb, jsPlaceholder));
  // connector line, faint and centered
  if (!cppPlaceholder || !jsPlaceholder) {
    const cy = y + ROW_H / 2;
    parts.push(`<line x1="${LEFT_X + COL_W}" y1="${cy}" x2="${RIGHT_X}" y2="${cy}" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="2 3"/>`);
  }
  y += ROW_H + ROW_GAP;
}

parts.push('</svg>');
process.stdout.write(parts.join('\n') + '\n');

process.stderr.write(`C++: ${cppTotal} headers across ${cppGroups.size} subdirs.\n`);
process.stderr.write(`JS:  ${jsTotal} modules across ${jsGroups.size} groups.\n`);
