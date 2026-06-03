#!/usr/bin/env node
// build-freq-fixtures.js -- read raw freq sources from
// fixture-src/freq/<source>/raw/, cook them to
// fixture-src/freq/<source>/cooked/<source>.freq.tsv.gz (committed
// to git), and pack the cooked artifact into the runtime SAB at
// fixtures/<source>.freq.sab.gz. Each cooked file carries # title:,
// # attribution:, # source:, and # note: header lines, then
// alphabetically-sorted `word\tcount` rows.
//
// Vocab pool = union of every word appearing in
// fixtures/*.dict.sab.gz (walked via listDictWords) and
// fixtures/*.wlist.sab.gz (walked via wrapPackedStrings.iterate).
// Wlists subsume the old per-twlist-source word set (each shipped
// twlist has a sibling wlist fixture produced by
// tools/build-twlist-wlist.js) and add per-corpus wordlists from
// build-corpus-wlist.js: strictly wider coverage. Pruning to this
// vocab keeps fixtures small and matches the intended downstream
// use: re-weighting Huffman trees over the same word set the
// dictionaries already cover.
//
// Cache hierarchy per source:
//   raw → cooked → SAB
// shouldReprocess() compares mtimes: raw vs cooked drives the
// reprocess step; cooked vs SAB drives the repack step. Each step
// is a no-op when its target is already current.
//
// REQUIRED for gutenberg: gutenberg processes ~37K books and the
// per-word counts map grows large enough to exhaust Node's default
// 4 GB V8 heap. Invoke with --max-old-space-size=8192 (or higher)
// when running gutenberg as a one-shot or as part of "all":
//
//   node --max-old-space-size=8192 tools/build-freq-fixtures.js gutenberg
//   node --max-old-space-size=8192 tools/build-freq-fixtures.js
//
// norvig and google-books fit comfortably in the default heap. The
// orchestrator (tools/build-all-fixtures.js) already passes the
// flag through to this script for the same reason; ad-hoc CLI use
// must supply it.
//
// Usage:
//   node tools/build-freq-fixtures.js                # all sources
//   node tools/build-freq-fixtures.js norvig         # one source
//   node tools/build-freq-fixtures.js norvig google  # multiple
//
// Sources skip silently if their raw input AND cooked cache are
// both missing.

import {
  copyFileSync, createReadStream, existsSync, mkdirSync,
  readdirSync, readFileSync, rmdirSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { tokenize, TOKEN } from '../js/src/lexer.js';
import { wrapDictionaryFromSAB, listDictWords } from '../js/src/dictionary.js';
import { wrapPackedStrings } from '../js/src/eve/packed-strings-sab.js';
import { loadSABfromFile, saveSABtoFile } from '../js/src/sab.js';
import { packFreqToSAB } from '../js/src/builder/freq-pack.js';
import { parseFreqLines } from '../js/src/builder/frequencies.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURES = join(ROOT, 'fixtures');
const FREQ = join(ROOT, 'fixture-src', 'freq');

async function buildVocab() {
  const vocab = new Set();
  for (const f of readdirSync(FIXTURES)) {
    const path = join(FIXTURES, f);
    if (f.endsWith('.dict.sab.gz')) {
      // Per-card dictionaries: load + walk via listDictWords. Covers
      // every word a shipped card's codebook addresses (incl. aug-
      // generated forms not present in any raw source).
      const sab = await loadSABfromFile(path);
      const dict = wrapDictionaryFromSAB(sab);
      for (const w of listDictWords(dict)) vocab.add(w);
    } else if (f.endsWith('.wlist.sab.gz')) {
      // Per-source / per-corpus wlists: NTPS packed-strings SAB.
      // Walk via wrapPackedStrings.iterate. Subsumes the old
      // per-twlist-source vocab path (each twlist has a wlist
      // sibling); adds per-corpus wlists from build-corpus-wlist.js.
      const sab = await loadSABfromFile(path);
      for (const w of wrapPackedStrings(sab).iterate()) vocab.add(w);
    }
  }
  return vocab;
}

// Cooked-cache convention. Each freq source has:
//   - raw input: file or directory under fixture-src/freq/<source>/
//     that fetch.js populates. Sometimes huge (gutenberg ~50GB,
//     google-books a few GB) and gitignored.
//   - cooked cache: fixture-src/freq/<source>/cooked/<source>.freq.tsv.gz
//    : the processed-but-pre-SAB result of the most recent raw run.
//     Committed to git so a clean clone or `rm -rf fixtures/` rebuild
//     does NOT need to re-download or re-tokenize.
//   - runtime fixture: fixtures/<source>.freq.tsv.gz (written here,
//     SAB-packed in a later step). Always rewritten on every build.
//
// Per-source decision tree:
//   - raw exists and is newer than cooked → reprocess from raw,
//     update cooked, write fixture
//   - cooked exists (raw missing or older) → copy cooked → fixture
//   - neither → skip
//
// Mtime comparison uses the file or directory's own mtime. For raw
// directories (google-books, gutenberg) this catches "new files
// added" but NOT "individual files modified in place"; sources are
// always APPENDED-to in our pipeline so this is fine.
//
// Caveat: cooked is filtered against the vocab union of all current
// dict + wlist fixtures (see buildVocab). If you change the card set
// or any dict, the cached cooked counts may miss new vocab words.
// Force a refresh by deleting fixture-src/freq/<source>/cooked/.

// Source-id → source-dir map for sources whose directory name
// doesn't match the canonical SAB id. Most match (norvig, gutenberg);
// google-books is the historical exception (id 'google' kept because
// the SAB output is fixtures/google.freq.sab.gz and the runtime
// loader resolves by id, not dir).
const SOURCE_DIRS = {
  norvig:    'norvig',
  google:    'google-books',
  gutenberg: 'gutenberg',
};

function cookedPath(source) {
  const dir = SOURCE_DIRS[source] ?? source;
  return join(FREQ, dir, 'cooked', `${source}.freq.tsv.gz`);
}

function ageOf(path) {
  try { return statSync(path).mtimeMs; }
  catch { return -1; }
}

// Walk a directory tree once and return the max file mtime found.
// For directory-based raw sources (google-books, gutenberg) the dir's
// own mtime only updates on entry add/remove, missing in-place file
// modifications (e.g., rsync re-pulling a changed book). Walking once
// at start-of-build catches those. Returns -1 if the dir doesn't
// exist or contains no files.
function findMaxMTime(dirPath) {
  let max = -1;
  const stack = [dirPath];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const sub = join(cur, e.name);
      if (e.isDirectory()) { stack.push(sub); continue; }
      if (!e.isFile()) continue;
      try {
        const m = statSync(sub).mtimeMs;
        if (m > max) max = m;
      } catch { /* skip */ }
    }
  }
  return max;
}

// True if the source's cooked output is missing or older than its
// raw input. Uses file mtime for file inputs, max-of-walk for
// directory inputs.
function shouldReprocess(rawPath, source) {
  let rawAge;
  try {
    const st = statSync(rawPath);
    rawAge = st.isDirectory() ? findMaxMTime(rawPath) : st.mtimeMs;
  } catch { return false; }
  if (rawAge < 0) return false;            // no raw available
  const cookedAge = ageOf(cookedPath(source));
  return rawAge > cookedAge;               // raw newer (cookedAge=-1 when missing)
}

function sabPath(source) {
  return join(FIXTURES, `${source}.freq.sab.gz`);
}

// Pack cooked → fixtures/<source>.freq.sab.gz directly. No
// intermediate .tsv.gz native is ever written into /fixtures,
// /fixtures stays SAB-only per the discipline guard. Skipped when
// the SAB is already newer than cooked.
async function packCookedToSABIfNeeded(source) {
  const cookedAge = ageOf(cookedPath(source));
  if (cookedAge < 0) return;
  const sabAge = ageOf(sabPath(source));
  if (sabAge >= cookedAge) {
    process.stderr.write(`  ${source}: SAB up-to-date (${sabPath(source).replace(ROOT + '/', '')}); no repack needed\n`);
    return;
  }
  const compressed = readFileSync(cookedPath(source));
  const text = gunzipSync(compressed).toString('utf8');
  const sab = packFreqToSAB(parseFreqLines(text));
  await saveSABtoFile(sab, sabPath(source));
  process.stderr.write(`  ${source}: packed cooked → ${sabPath(source).replace(ROOT + '/', '')} (${sab.byteLength.toLocaleString()} bytes)\n`);
}

function writeCooked(name, headers, counts) {
  const out = [];
  for (const [k, v] of headers) out.push(`# ${k}: ${v}`);
  const sorted = [...counts.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  );
  for (const [w, c] of sorted) out.push(`${w}\t${c}`);
  const buf = gzipSync(Buffer.from(out.join('\n') + '\n', 'utf8'), { level: 9 });
  const cooked = cookedPath(name);
  mkdirSync(dirname(cooked), { recursive: true });
  writeFileSync(cooked, buf);
  process.stderr.write(`wrote ${cooked.replace(ROOT + '/', '')} (${sorted.length} rows, ${buf.length} bytes)\n`);
}

function lineReader(path) {
  const stream = path.endsWith('.gz')
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  return createInterface({ input: stream, crlfDelay: Infinity });
}

async function processNorvig(vocab) {
  const path = join(FREQ, 'norvig', 'raw', 'count_1w.txt.gz');
  if (!shouldReprocess(path, 'norvig')) {
    if (!existsSync(cookedPath('norvig'))) {
      process.stderr.write(`skip norvig: raw missing and no cooked cache\n`);
      return;
    }
    await packCookedToSABIfNeeded('norvig');
    return;
  }
  process.stderr.write(`norvig: reading ${path}\n`);
  const counts = new Map();
  const rl = lineReader(path);
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const w = line.slice(0, tab);
    if (!vocab.has(w)) continue;
    const n = Number(line.slice(tab + 1));
    if (Number.isFinite(n) && n > 0) counts.set(w, (counts.get(w) || 0) + n);
  }
  writeCooked('norvig', [
    ['title', 'Norvig unigram counts (count_1w.txt)'],
    ['attribution', 'Peter Norvig, derived from a 1-trillion-word web corpus'],
    ['source', 'https://norvig.com/ngrams/count_1w.txt'],
    ['note', "curated subset: only words present in this build's base dictionaries"],
  ], counts);
  await packCookedToSABIfNeeded('norvig');
}

async function processGoogle(vocab) {
  const dir = join(FREQ, 'google-books', 'raw');
  if (!shouldReprocess(dir, 'google')) {
    if (!existsSync(cookedPath('google'))) {
      process.stderr.write(`skip google: raw missing and no cooked cache\n`);
      return;
    }
    await packCookedToSABIfNeeded('google');
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.gz')).sort();
  if (files.length === 0) {
    process.stderr.write(`skip google-books: no .gz files in ${dir} and no cooked cache\n`);
    return;
  }
  const counts = new Map();
  for (const f of files) {
    process.stderr.write(`google-books: ${f}\n`);
    const rl = lineReader(join(dir, f));
    let lines = 0;
    for await (const line of rl) {
      lines++;
      // ngram TAB year TAB match_count TAB volume_count
      const parts = line.split('\t');
      if (parts.length !== 4) continue;
      const ngram = parts[0];
      if (ngram.indexOf('_') >= 0) continue;  // POS-tagged
      if (!vocab.has(ngram)) continue;
      const m = Number(parts[2]);
      if (Number.isFinite(m) && m > 0) counts.set(ngram, (counts.get(ngram) || 0) + m);
    }
    process.stderr.write(`  ${lines} lines; running vocab hits: ${counts.size}\n`);
  }
  writeCooked('google', [
    ['title', 'Google Books English 1-grams (20120701)'],
    ['attribution', 'Google Books Ngram Corpus, version 20120701, English'],
    ['source', 'http://storage.googleapis.com/books/ngrams/books/datasetsv2.html'],
    ['note', "curated subset: only words present in this build's base dictionaries; counts summed across years"],
  ], counts);
  await packCookedToSABIfNeeded('google');
}

function processGutenbergBook(path, vocab, counts) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { return false; }
  for (const tok of tokenize(text, { skipBoilerplate: true })) {
    if (tok.type !== TOKEN.WORD) continue;
    const w = tok.value;
    if (!vocab.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return true;
}

// Per-book PG file selection: PG mirrors typically place each book's
// text file(s) under a leaf directory named after the book id, with
// variants like 12345.txt (legacy ASCII / Latin-1) and 12345-0.txt
// (UTF-8). Some books also have 12345-8.txt (explicit Latin-1).
// Counting all of them double-counts the same book. Per directory,
// group .txt files by their numeric stem and pick one variant in
// preference order: -0 (UTF-8) > bare > -8 > anything else.
function chooseVariants(filenames) {
  const byStem = new Map();
  for (const name of filenames) {
    const m = name.match(/^(.+?)(?:-(\d+))?\.txt$/);
    if (!m) continue;
    const stem = m[1];
    const variant = m[2] !== undefined ? Number(m[2]) : null;
    const arr = byStem.get(stem) || [];
    arr.push({ name, variant });
    byStem.set(stem, arr);
  }
  const chosen = [];
  for (const variants of byStem.values()) {
    const pick =
      variants.find(v => v.variant === 0)
      || variants.find(v => v.variant === null)
      || variants.find(v => v.variant === 8)
      || variants[0];
    chosen.push(pick.name);
  }
  return chosen;
}

// Per-batch flush size for gutenberg. Walking 37 K books in one in-
// memory pass exhausts even a 16 GB V8 heap (V8 string interning
// across millions of unique tokens fragments the heap faster than
// the GC can compact). Instead we process in batches, serialize
// each batch's counts to a temp file, reset the in-memory Map, and
// merge all temp files into the final cooked output at the end.
// 2000 books / batch keeps peak resident under ~1 GB.
const GUTENBERG_BATCH_BOOKS = 2000;

function flushBatch(counts, batchIdx, batchDir) {
  if (counts.size === 0) return null;
  const path = join(batchDir, `batch-${String(batchIdx).padStart(4, '0')}.tsv.gz`);
  const lines = [];
  for (const [w, c] of counts) lines.push(`${w}\t${c}`);
  const buf = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { level: 6 });
  writeFileSync(path, buf);
  return path;
}

function mergeBatchFiles(batchFiles) {
  const merged = new Map();
  for (const f of batchFiles) {
    const text = gunzipSync(readFileSync(f)).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const w = line.slice(0, tab);
      const n = Number(line.slice(tab + 1));
      if (Number.isFinite(n) && n > 0) merged.set(w, (merged.get(w) || 0) + n);
    }
  }
  return merged;
}

async function processGutenberg(vocab) {
  const root = join(FREQ, 'gutenberg', 'raw');
  if (!shouldReprocess(root, 'gutenberg')) {
    if (!existsSync(cookedPath('gutenberg'))) {
      process.stderr.write(`skip gutenberg: raw missing and no cooked cache\n`);
      return;
    }
    await packCookedToSABIfNeeded('gutenberg');
    return;
  }
  // Temp batch dir lives under cooked/ but gets cleaned up at the
  // end so only the final cooked file remains.
  const batchDir = join(FREQ, 'gutenberg', 'cooked', '.batches');
  mkdirSync(batchDir, { recursive: true });
  // Clear any stragglers from a prior failed run before starting.
  for (const f of readdirSync(batchDir).filter(n => n.startsWith('batch-') && n.endsWith('.tsv.gz'))) {
    try { unlinkSync(join(batchDir, f)); } catch {}
  }
  let counts = new Map();
  const batchFiles = [];
  let batchIdx = 0;
  let bookCount = 0;
  let fileCount = 0;
  let processed = 0;
  const stack = [root];
  process.stderr.write(`gutenberg: walking ${root} (batch size ${GUTENBERG_BATCH_BOOKS} books)\n`);
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    const txts = [];
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.txt')) txts.push(e.name);
    }
    if (txts.length === 0) continue;
    fileCount += txts.length;
    const chosen = chooseVariants(txts);
    for (const name of chosen) {
      const ok = processGutenbergBook(join(dir, name), vocab, counts);
      if (ok) processed++;
      bookCount++;
      if (bookCount % 1000 === 0) {
        process.stderr.write(`  gutenberg: ${bookCount} books seen, ${processed} processed, ${counts.size} vocab hits in current batch\n`);
      }
      if (bookCount % GUTENBERG_BATCH_BOOKS === 0) {
        const path = flushBatch(counts, batchIdx, batchDir);
        if (path) {
          batchFiles.push(path);
          process.stderr.write(`  gutenberg: flushed batch ${batchIdx} (${counts.size} entries) → ${path.replace(ROOT + '/', '')}\n`);
        }
        counts = new Map();
        batchIdx++;
      }
    }
  }
  // Final partial batch.
  const lastPath = flushBatch(counts, batchIdx, batchDir);
  if (lastPath) {
    batchFiles.push(lastPath);
    process.stderr.write(`  gutenberg: flushed final batch ${batchIdx} (${counts.size} entries)\n`);
  }
  counts = null;
  process.stderr.write(`  gutenberg: walked ${fileCount} .txt files; chose ${bookCount} per-book variants; ${processed} processed; merging ${batchFiles.length} batch files\n`);
  const merged = mergeBatchFiles(batchFiles);
  process.stderr.write(`  gutenberg: merged ${merged.size} unique vocab hits across ${bookCount} books\n`);
  writeCooked('gutenberg', [
    ['title', 'Project Gutenberg English plain-text corpus'],
    ['attribution', "Project Gutenberg (public-domain texts); tokenized with NiceText's engine lexer"],
    ['source', 'rsync://aleph.gutenberg.org/gutenberg'],
    ['note', "curated subset: only words present in this build's base dictionaries; PG header / footer boilerplate stripped"],
  ], merged);
  // Clean up batch files; only the final cooked output remains.
  for (const f of batchFiles) {
    try { unlinkSync(f); } catch {}
  }
  try { rmdirSync(batchDir); } catch {}
  await packCookedToSABIfNeeded('gutenberg');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const all = args.size === 0 || args.has('all');
  process.stderr.write('building vocab pool from fixtures/...\n');
  const vocab = await buildVocab();
  process.stderr.write(`  vocab: ${vocab.size} unique words\n`);
  if (all || args.has('norvig')) await processNorvig(vocab);
  if (all || args.has('google')) await processGoogle(vocab);
  if (all || args.has('gutenberg')) await processGutenberg(vocab);
}

main().catch(e => { console.error(e); process.exit(1); });
