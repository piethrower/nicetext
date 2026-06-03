#!/usr/bin/env node
// build-master-wlist.js: produce fixture-src/wlist/master.wlist.gz from every
// word-bearing source in the repo. One lowercase WORD-token per line,
// lexicographically sorted, deduplicated, gzipped.
//
// Output is the input pool for tools/build-impkimmo2026-twlist.js
// (which pipes it through an out-of-repo PC-KIMMO + ENGLEX install
// at ../pckimmo2026/ to produce fixture-src/twlist/impkimmo2026/...).
//
// Source families (each shown with its per-source unique-add delta
// in the per-stage log):
//   1. TWLISTs             : fixture-src/twlist/{impkimmo,rhyme,impf2p,
//                              claude2026,proglang-keywords,cfg-words,
//                              emoji-curated-phrases-16}/...
//   2. Single-column word  : fixture-src/twlist/{mitlist,numeric}/*
//      files
//   3. WordNet index files : fixture-src/twlist/wordnet/index.*.gz
//   4. Moby POS / thesaurus, fixture-src/twlist/moby-{pos,thesaurus}/*.gz
//   5. Corpus texts (lexed), fixture-src/texts/*.txt
//   6. Gutenberg corpus    : fixture-src/freq/gutenberg/raw/**/*.txt
//      (per english-paths.txt; preclean + lex; skipBoilerplate)
//   7. Norvig 1-gram freq  : fixture-src/freq/norvig/count_1w.txt.gz
//   8. Google Books 1-gram : fixture-src/freq/google-books/raw/*.gz
//   9. ENGLEX-generated    : fixture-src/wlist/englex.wlist.gz (output of
//      surface forms          tools/build-englex-wlist.js; out-of-repo
//                            PC-KIMMO + ENGLEX driven, all surface
//                            forms ENGLEX can `generate`)
//
// For every candidate string we run the project lexer (lexer.js) and
// keep only WORD tokens lowercased. This guarantees every output line
// is something the encode/decode pipeline could itself lex as one WORD,
// which is exactly what PC-KIMMO will be fed in step 2.

import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

import { tokenize, TOKEN } from '../js/src/lexer.js';
import { precleanCorpus } from '../js/src/builder/precleanCorpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const OUT  = join(REPO, 'fixture-src', 'wlist', 'master.wlist.gz');

// Pipeline: this process writes one candidate per line to `sort -u`'s
// stdin; `sort` spills to disk under LC_ALL=C with a 1 GiB buffer and
// emits unique-sorted lines to its stdout; that feeds `gzip -9 -c`,
// whose stdout is redirected to the output file. So peak in-process
// memory stays bounded regardless of input volume, earlier in-memory
// Set<string> at ~6 M unique entries OOM'd the V8 default heap.
const sortProc = spawn('sort',
  ['-u', '-S', '1G'],
  { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'inherit'] });
const gzipProc = spawn('gzip',
  ['-9', '-c'],
  { stdio: ['pipe', 'pipe', 'inherit'] });
sortProc.stdout.pipe(gzipProc.stdin);
const outFile = (await import('node:fs')).createWriteStream(OUT);
gzipProc.stdout.pipe(outFile);
const sortIn = sortProc.stdin;

let totalEmitted = 0;

// Batch outgoing lines into a chunk buffer so each child-stdin write
// is a sizeable chunk rather than one syscall per word. The flush
// honors sort -u's backpressure: when sortIn.write() returns false
// (its high-water mark exceeded), await `drain` before sending more.
// An earlier version of this script wrote one line at a time AND
// ignored the false-return, which let the producer queue ~1 B
// unprocessed strings during google-books and OOM'd V8 at ~4 GB.
let chunkBuf = '';
const CHUNK_FLUSH_BYTES = 1 << 20; // 1 MiB

async function flushChunk() {
  if (!chunkBuf) return;
  const data = chunkBuf;
  chunkBuf = '';
  if (!sortIn.write(data)) {
    await new Promise(res => sortIn.once('drain', res));
  }
}

async function addWord(s) {
  if (!s) return;
  if (s.length > 256) return;
  chunkBuf += s.toLowerCase() + '\n';
  totalEmitted++;
  if (chunkBuf.length >= CHUNK_FLUSH_BYTES) await flushChunk();
}

async function lexAndAdd(s) {
  if (!s) return;
  for (const tok of tokenize(s)) {
    if (tok.type === TOKEN.WORD) await addWord(tok.value);
  }
}

// Lex a full corpus body (after precleanCorpus). skipBoilerplate strips
// Project Gutenberg legal headers/footers in the modern + legacy shapes.
async function lexCorpusBody(text) {
  const clean = precleanCorpus(text);
  for (const tok of tokenize(clean, { skipBoilerplate: true })) {
    if (tok.type === TOKEN.WORD) await addWord(tok.value);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Stage helpers
// ──────────────────────────────────────────────────────────────────────

function logStage(name) {
  const before = totalEmitted;
  return (note = '') => {
    const after = totalEmitted;
    const delta = after - before;
    process.stderr.write(
      `[wlist] ${name.padEnd(28)} +${String(delta).padStart(10)} emitted` +
      `  total=${String(after).padStart(11)}` +
      (note ? `  ${note}` : '') + '\n'
    );
  };
}

async function* gunzipLines(path) {
  const rl = readline.createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

async function* plainLines(path) {
  const rl = readline.createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

// ──────────────────────────────────────────────────────────────────────
// Source loaders
// ──────────────────────────────────────────────────────────────────────

// 1+2. TWLIST and single-column files.
async function loadTwlistFile(path, gz = false) {
  const lines = gz ? gunzipLines(path) : plainLines(path);
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    // OG TWLIST shape: TYPE WORD (one whitespace run separates). Single-
    // column files (mitlist, numeric, num_*, mit-names) match the
    // single-token branch.
    const m = /^(\S+)(?:\s+(.+))?$/.exec(line);
    if (!m) continue;
    const valueColumn = m[2] ?? m[1];
    await lexAndAdd(valueColumn);
  }
}

// 3. WordNet index files: lemma is column 0 (whitespace-separated).
async function loadWordNetIndex(path) {
  for await (const raw of gunzipLines(path)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith(' ')) continue; // license header lines start with space
    const lemma = line.split(/\s+/, 1)[0];
    // WordNet uses '_' to join multi-word lemmas (e.g. "abdominal_cavity").
    // Split on '_' so each word is independent.
    for (const part of lemma.split('_')) await lexAndAdd(part);
  }
}

// 4a. Moby POS: `word\POS` (backslash-separated).
async function loadMobyPos(path) {
  for await (const raw of gunzipLines(path)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const head = line.split('\\', 1)[0];
    await lexAndAdd(head);
  }
}

// 4b. Moby Thesaurus: rows are CSV (no quoting). Every cell is a word
// or phrase candidate.
async function loadMobyThesaurus(path) {
  for await (const raw of gunzipLines(path)) {
    const line = raw.trimEnd();
    if (!line) continue;
    for (const cell of line.split(',')) await lexAndAdd(cell);
  }
}

// 5. Plain corpus texts: lex the whole body.
async function loadCorpusText(path) {
  const text = await readFile(path, 'utf8');
  await lexCorpusBody(text);
}

// 6. Gutenberg: english-paths.txt enumerates the English subset.
async function loadGutenberg() {
  const root = join(REPO, 'fixture-src', 'freq', 'gutenberg');
  const paths = (await readFile(join(root, 'english-paths.txt'), 'utf8'))
    .split('\n').map(s => s.trim()).filter(Boolean);
  let n = 0;
  for (const rel of paths) {
    const p = join(root, 'raw', rel);
    try {
      const text = await readFile(p, 'utf8');
      await lexCorpusBody(text);
    } catch {
      // Missing file (rsync filter mismatch), skip silently.
    }
    n++;
    if (n % 2000 === 0) {
      process.stderr.write(`[wlist]   gutenberg ${n}/${paths.length}  emitted=${totalEmitted}\n`);
    }
  }
}

// 7. Norvig 1-gram: `word\tcount`.
async function loadNorvig(path) {
  for await (const raw of gunzipLines(path)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const tab = line.indexOf('\t');
    const word = tab > 0 ? line.slice(0, tab) : line;
    await lexAndAdd(word);
  }
}

// 8. Google Books 1-gram: `word_POS\tyear\tmatch\tvolume`.
// _POS is one of NOUN, VERB, ADJ, ADV, PRON, DET, ADP, NUM, CONJ, PRT, ., X.
// Some entries have no _POS suffix; strip the trailing _UPPERCASETAG if
// present, then lex (which also handles internal _ → split because '_'
// is PUNCT in our lexer).
const GBOOK_POS_TAIL_RE = /_(NOUN|VERB|ADJ|ADV|PRON|DET|ADP|NUM|CONJ|PRT|X)$/;

async function loadGoogleBooks(path) {
  let n = 0;
  const before = totalEmitted;
  for await (const raw of gunzipLines(path)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const tab = line.indexOf('\t');
    let token = tab > 0 ? line.slice(0, tab) : line;
    token = token.replace(GBOOK_POS_TAIL_RE, '');
    await lexAndAdd(token);
    n++;
  }
  process.stderr.write(
    `[wlist]   ${path.split('/').pop().padEnd(50)} lines=${n}` +
    `  +${totalEmitted - before} emitted\n`
  );
}

// ──────────────────────────────────────────────────────────────────────
// Directory walkers (used by stages that batch-load a whole subtree)
// ──────────────────────────────────────────────────────────────────────

async function listFiles(dir, filterFn) {
  const ents = await readdir(dir, { withFileTypes: true });
  return ents
    .filter(e => e.isFile() && (!filterFn || filterFn(e.name)))
    .map(e => join(dir, e.name))
    .sort();
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main() {
  const twlistRoot = join(REPO, 'fixture-src', 'twlist');

  // Stage 1: TWLISTs (TYPE WORD) and single-column lists.
  {
    const done = logStage('twlist: impkimmo');
    await loadTwlistFile(join(twlistRoot, 'impkimmo', 'kimmo.twlist.gz'), true);
    done();
  }
  {
    const done = logStage('twlist: rhyme');
    await loadTwlistFile(join(twlistRoot, 'rhyme', 'rhyme.twlist.gz'), true);
    done();
  }
  {
    const done = logStage('twlist: impf2p');
    await loadTwlistFile(join(twlistRoot, 'impf2p', 'f2p.twlist.gz'), true);
    done();
  }
  for (const sub of ['claude2026', 'proglang-keywords', 'cfg-words', 'emoji-curated-phrases-16']) {
    const done = logStage(`twlist: ${sub}`);
    for (const f of await listFiles(join(twlistRoot, sub), n => n.endsWith('.twlist'))) {
      await loadTwlistFile(f, false);
    }
    done();
  }
  for (const sub of ['mitlist', 'numeric']) {
    const done = logStage(`twlist: ${sub}`);
    for (const f of await listFiles(join(twlistRoot, sub), () => true)) {
      await loadTwlistFile(f, false);
    }
    done();
  }

  // Stage 2: WordNet index files (one per POS).
  {
    const done = logStage('wordnet index');
    for (const pos of ['noun', 'verb', 'adj', 'adv']) {
      await loadWordNetIndex(join(twlistRoot, 'wordnet', `index.${pos}.gz`));
    }
    done();
  }

  // Stage 3: Moby.
  {
    const done = logStage('moby-pos');
    await loadMobyPos(join(twlistRoot, 'moby-pos', 'mobypos.txt.gz'));
    done();
  }
  {
    const done = logStage('moby-thesaurus');
    await loadMobyThesaurus(join(twlistRoot, 'moby-thesaurus', 'mthesaur.txt.gz'));
    done();
  }

  // Stage 4: fixture-src/texts/*.txt.
  {
    const done = logStage('fixture-src/texts');
    const files = await listFiles(join(REPO, 'fixture-src', 'texts'), n => n.endsWith('.txt'));
    for (const f of files) await loadCorpusText(f);
    done(`(${files.length} files)`);
  }

  // Stage 5: Norvig 1-gram.
  {
    const done = logStage('freq: norvig');
    await loadNorvig(join(REPO, 'fixture-src', 'freq', 'norvig', 'count_1w.txt.gz'));
    done();
  }

  // Stage 5.5: ENGLEX-generated surface forms. Single-column gzipped
  // wordlist (one lowercase WORD per line, already sort -u'd) produced
  // by tools/build-englex-wlist.js from an out-of-repo PC-KIMMO +
  // ENGLEX install. Skipped silently if the file doesn't exist yet
  // (so this stage is no-op until a generate-driven build has been
  // run).
  {
    const done = logStage('wlist: englex (generated)');
    const englexPath = join(REPO, 'fixture-src', 'wlist', 'englex.wlist.gz');
    if ((await import('node:fs')).existsSync(englexPath)) {
      for await (const raw of gunzipLines(englexPath)) {
        const w = raw.trimEnd();
        if (w) await addWord(w);
      }
      done();
    } else {
      done('(file not present, run tools/build-englex-wlist.js first)');
    }
  }

  if (process.env.WLIST_SKIP_HEAVY !== '1') {
    // Stage 6: Google Books 1-gram (per-file logging is built in).
    {
      const done = logStage('freq: google-books');
      const dir = join(REPO, 'fixture-src', 'freq', 'google-books', 'raw');
      const files = await listFiles(dir, n => n.endsWith('.gz'));
      for (const f of files) await loadGoogleBooks(f);
      done(`(${files.length} files)`);
    }

    // Stage 7: Gutenberg corpus (per english-paths.txt). Slow.
    {
      const done = logStage('freq: gutenberg');
      await loadGutenberg();
      done();
    }
  } else {
    process.stderr.write('[wlist] WLIST_SKIP_HEAVY=1, skipping google-books + gutenberg.\n');
  }

  process.stderr.write(`[wlist] closing pipeline (sort -u | gzip -9 > ${OUT})...\n`);
  await flushChunk();
  sortIn.end();
  await new Promise((res, rej) => {
    outFile.on('close', res);
    outFile.on('error', rej);
    gzipProc.on('error', rej);
    sortProc.on('error', rej);
  });
  process.stderr.write(`[wlist] done. ${totalEmitted} candidates emitted (deduped on disk).\n`);
}

main().catch(e => {
  process.stderr.write(`[wlist] FAILED: ${e.stack || e.message}\n`);
  process.exit(1);
});
