#!/usr/bin/env node
// list-english.js -- download Project Gutenberg's RDF metadata catalog,
// parse it, and emit english-paths.txt: rsync-relative paths for books
// that are tagged with English as their ONLY language. Multi-language
// books (e.g. English + Latin quotations) are excluded by design.
//
// Output format: one line per book, rsync-relative path to one .txt
// file. Per-book variant choice: prefer the bare `<id>.txt` if PG
// publishes it, else fall back to `<id>-0.txt` (UTF-8). Books that
// have neither (rare) are skipped. The path follows PG's mirror
// layout: digits of the book id, split one-per-directory for all
// but the last, then a folder named after the full id, then the
// file. Examples:
//   id=1     -> 1/1.txt
//   id=12    -> 1/12/12.txt
//   id=12345 -> 1/2/3/4/12345/12345.txt
// Variant suffix lands on the file only:
//   id=12345 (UTF-8 fallback) -> 1/2/3/4/12345/12345-0.txt
//
// The catalog tarball is ~50 MB compressed, contains ~70K RDF files.
// Extraction shells out to `tar` since we have zero npm dependencies.
//
// Run: `node fixture-src/freq/gutenberg/list-english.js`

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2';
const RAW = join(HERE, 'raw');
// All workflow artifacts live inside raw/ so the gitignore on raw/
// is the only exclusion rule needed.
const OUT = join(RAW, 'english-paths.txt');
mkdirSync(RAW, { recursive: true });

function bookPath(id, variant = '') {
  const s = String(id);
  const fname = `${s}${variant}.txt`;
  if (s.length === 1) return `${s}/${fname}`;
  const dirs = s.slice(0, s.length - 1).split('').join('/');
  return `${dirs}/${s}/${fname}`;
}

// Extract every plain-text variant (.txt) URL the RDF lists for this
// book, return the variant suffix string ('' for bare, '-0' for UTF-8,
// '-8' for explicit Latin-1, etc.). PG publishes URLs of the form
// https://www.gutenberg.org/files/<id>/<id>(-N)?.txt — we only care
// about those that match the canonical naming pattern.
function listTxtVariants(text, id) {
  const re = new RegExp(
    `https://www\\.gutenberg\\.org/files/${id}/${id}(-\\d+)?\\.txt`,
    'g'
  );
  const variants = new Set();
  for (const m of text.matchAll(re)) variants.add(m[1] || '');
  return variants;
}

// Each PG RDF doc carries one or more <dcterms:language>...<rdf:value>XX</rdf:value>...
// blocks. We accept a book iff it has exactly one language block AND that
// language is "en". Regex over the well-formed XML is sufficient here;
// PG RDF files are produced by a stable generator and not user-authored.
const LANG_BLOCK_RE = /<dcterms:language>[\s\S]*?<\/dcterms:language>/g;
const LANG_VALUE_RE = /<rdf:value[^>]*>([^<]+)<\/rdf:value>/;

function parseRdfLanguages(text) {
  const blocks = text.match(LANG_BLOCK_RE) || [];
  const langs = [];
  for (const b of blocks) {
    const m = b.match(LANG_VALUE_RE);
    if (m) langs.push(m[1].trim());
  }
  return langs;
}

const work = mkdtempSync(join(tmpdir(), 'nicetext-pg-rdf-'));
const tarPath = join(work, 'rdf-files.tar.bz2');
try {
  process.stderr.write(`fetching ${URL}...\n`);
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tarPath));
  process.stderr.write(`extracting ${tarPath}...\n`);
  const tar = spawnSync('tar', ['-xjf', tarPath, '-C', work], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('tar extraction failed');

  // Tar layout: cache/epub/<id>/pg<id>.rdf
  const root = join(work, 'cache', 'epub');
  let total = 0;
  let englishOnly = 0;
  let multilingual = 0;
  let other = 0;
  let nolang = 0;
  let variantBare = 0;
  let variantUtf8 = 0;
  let variantNone = 0;
  const paths = [];
  for (const idDir of readdirSync(root)) {
    const idPath = join(root, idDir);
    const st = statSync(idPath);
    if (!st.isDirectory()) continue;
    const id = Number(idDir);
    if (!Number.isFinite(id) || id <= 0) continue;
    const rdfFile = join(idPath, `pg${idDir}.rdf`);
    let text;
    try { text = readFileSync(rdfFile, 'utf8'); }
    catch { continue; }
    total++;
    const langs = parseRdfLanguages(text);
    if (langs.length === 0) { nolang++; continue; }
    if (langs.length > 1) { multilingual++; continue; }
    if (langs[0] !== 'en') { other++; continue; }
    englishOnly++;
    const variants = listTxtVariants(text, id);
    let chosen = null;
    if (variants.has('')) { chosen = ''; variantBare++; }
    else if (variants.has('-0')) { chosen = '-0'; variantUtf8++; }
    else { variantNone++; continue; }
    paths.push(bookPath(id, chosen));
  }
  paths.sort();
  writeFileSync(OUT, paths.join('\n') + '\n');
  process.stderr.write(`scanned ${total} books: ${englishOnly} english-only, ${multilingual} multilingual, ${other} other-language, ${nolang} no-language\n`);
  process.stderr.write(`english-only variant pick: ${variantBare} bare, ${variantUtf8} utf-8 (-0), ${variantNone} no-text\n`);
  process.stderr.write(`wrote ${OUT} (${paths.length} paths)\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
