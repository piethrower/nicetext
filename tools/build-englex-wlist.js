#!/usr/bin/env node
// build-englex-wlist.js: enumerate every surface form that ENGLEX +
// PC-KIMMO can `generate`, write the lowercased deduped set to
// fixture-src/wlist/englex.wlist.gz. Intended as another input source for
// tools/build-master-wlist.js, so that words ENGLEX knows but our
// raw corpora missed (e.g. `'tis` and the long tail of inflected
// proper nouns) reach master.wlist and downstream impkimmo2026.
//
// Why not embed type derivation here? `pckimmo generate` only outputs
// the surface form, not the Word: PATR feature block. The features
// come back when fetch.js runs `recognize` on the master.wlist, so
// keeping this script wlist-only (no types) is the clean factoring:
// englex-generation feeds master.wlist, then the existing recognize
// pipeline labels everything uniformly.
//
// Enumeration strategy:
//   1. Parse every *.lex file in ENGLEX (noun, verb, adjectiv, adverb,
//      minor, proper, abbrev, technica, natural, foreign). For each
//      `\lf <form>` line, record the lex-form. Prefix lex-forms end
//      in `+` (e.g. `un+`); suffix lex-forms begin with `+` (e.g.
//      `+s`). Everything else is a root.
//   2. For every root, emit `generate <root>` and
//      `generate <root>+<suffix>` for every common suffix observed
//      in affix.lex.
//   3. For a curated set of productive prefixes (un, re, pre, dis,
//      mis, non, in, anti, post, sub, super, over, under, ...) also
//      emit `generate <prefix>+<root>` and
//      `generate <prefix>+<root>+<suffix>`.
//   4. Drive pckimmo with this take file in OS-`timeout`-wrapped
//      batches (same shape as fixture-src/twlist/impkimmo2026/fetch.js).
//   5. Parse stderr for `PC-KIMMO>generate <lex>` echoes and the
//      following surface line; non-empty surfaces (not `*** NONE ***`)
//      go to the output set lowercased.
//
// Output: fixture-src/wlist/englex.wlist.gz, one lowercase WORD per line,
// LC_ALL=C-sorted, deduplicated by sort -u.

import {
  closeSync, createReadStream, createWriteStream,
  openSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const PCKIMMO_ROOT = resolve(REPO, '..', 'pckimmo2026');
const PCKIMMO_BIN  = join(PCKIMMO_ROOT, 'CarlaLegacy', 'pc-parse', 'pckimmo', 'pckimmo');
const ENGLEX_DIR   = join(PCKIMMO_ROOT, 'englex', 'eng');
const OUT          = join(REPO, 'fixture-src', 'wlist', 'englex.wlist.gz');

async function checkPath(p, label) {
  try { await stat(p); }
  catch {
    process.stderr.write(`build-englex-wlist: missing ${label}: ${p}\n`);
    process.exit(1);
  }
}
await checkPath(PCKIMMO_BIN, 'pckimmo binary');
await checkPath(ENGLEX_DIR,  'ENGLEX directory');

// ──────────────────────────────────────────────────────────────────────
// Parse the ENGLEX lex files
// ──────────────────────────────────────────────────────────────────────
const ROOT_LEX_FILES = [
  'noun.lex', 'verb.lex', 'adjectiv.lex', 'adverb.lex', 'minor.lex',
  'proper.lex', 'abbrev.lex', 'technica.lex', 'natural.lex', 'foreign.lex',
];
const AFFIX_LEX_FILES = ['affix.lex'];

function parseLexFile(path) {
  const out = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const raw of lines) {
    const m = /^\\lf\s+(.+?)\s*$/.exec(raw);
    if (m) out.push(m[1]);
  }
  return out;
}

const roots = new Set();
for (const f of ROOT_LEX_FILES) {
  for (const lf of parseLexFile(join(ENGLEX_DIR, f))) {
    if (lf.endsWith('+')) continue;        // prefix entry
    if (lf.startsWith('+')) continue;      // suffix entry
    roots.add(lf);
  }
}
const suffixes = new Set();
const prefixes = new Set();
for (const f of AFFIX_LEX_FILES) {
  for (const lf of parseLexFile(join(ENGLEX_DIR, f))) {
    if (lf.endsWith('+')) prefixes.add(lf);
    else if (lf.startsWith('+')) suffixes.add(lf);
  }
}
process.stderr.write(
  `[englex] parsed: ${roots.size} roots, ${prefixes.size} prefixes,` +
  ` ${suffixes.size} suffixes\n`
);

// ──────────────────────────────────────────────────────────────────────
// Build enumeration of lex forms to try
// ──────────────────────────────────────────────────────────────────────
// Strategy: emit
//   - bare root
//   - root + each suffix
//   - root + suffix1 + suffix2 for clitic suffixes (e.g. +s+'s)
//   - prefix + root  (no suffix or with each suffix)
//
// We do NOT try every prefix × every root × every suffix because the
// combinatorial volume is dominated by impossible combinations (e.g.
// `co+abate+ness`) which pckimmo will *** NONE *** but still cost
// time. The single-prefix and single-suffix forms cover the bulk of
// what ENGLEX can produce; double-suffix covers the genitive clitics.
//
// The clitic suffixes worth chaining: +'s, +'d, +'ve, +'ll, +'re,
// +'m, +'t, +n't (these can stack after inflectional +s/+ed).

const CLITICS = new Set(["+'s", "+'d", "+'ve", "+'ll", "+'re", "+'m", "+'t", "+n't", "+'d've"]);
const INFL_SUFFIXES = new Set(['+s', '+ed', '+ing', '+en', '+er', '+est', '+d', "+'", "+'s"]);

function* enumerateLexForms() {
  // Optional ENGLEX_LIMIT env var to truncate the enumeration during
  // smoke tests.
  const limit = process.env.ENGLEX_LIMIT ? Number(process.env.ENGLEX_LIMIT) : Infinity;
  let emitted = 0;
  function* yieldUpToLimit(s) {
    if (emitted >= limit) return;
    emitted++;
    yield s;
  }
  // Per-root: bare + every single suffix + inflection-then-clitic
  // chains (`+s+'s`, `+ed+'ve`, etc., to cover the common stacking
  // patterns).
  for (const root of roots) {
    if (emitted >= limit) return;
    yield* yieldUpToLimit(root);
    for (const sfx of suffixes) {
      if (emitted >= limit) return;
      yield* yieldUpToLimit(`${root}${sfx}`);
    }
    for (const infl of INFL_SUFFIXES) {
      for (const cli of CLITICS) {
        if (emitted >= limit) return;
        yield* yieldUpToLimit(`${root}${infl}${cli}`);
      }
    }
  }
  // Per-prefix: prefix+root (no further suffix). We deliberately do
  // NOT generate prefix×root×suffix combinations, the cartesian
  // explosion would add hundreds of millions of failed `generate`
  // calls for tiny coverage gain (e.g. `co+abate+ness` is implausible
  // in real text). Productive prefix+suffix forms are typically also
  // listed as their own root entries in ENGLEX's lex files.
  for (const pre of prefixes) {
    for (const root of roots) {
      if (emitted >= limit) return;
      yield* yieldUpToLimit(`${pre}${root}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Output pipeline: lines → sort -u → gzip -9 → englex.wlist.gz
// ──────────────────────────────────────────────────────────────────────
const sortProc = spawn('sort',
  ['-u', '-S', '512M'],
  { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'inherit'] });
const gzipProc = spawn('gzip',
  ['-9', '-c'],
  { stdio: ['pipe', 'pipe', 'inherit'] });
sortProc.stdout.pipe(gzipProc.stdin);
const outFile = createWriteStream(OUT);
gzipProc.stdout.pipe(outFile);

// Output stages: stream candidate surface lines into sort with a
// modest line buffer; sort -u dedupes across all batches.
let outBuf = '';
const FLUSH_BYTES = 1 << 20;
async function emitSurface(s) {
  outBuf += s.toLowerCase() + '\n';
  if (outBuf.length >= FLUSH_BYTES) {
    const data = outBuf; outBuf = '';
    if (!sortProc.stdin.write(data)) {
      await new Promise(res => sortProc.stdin.once('drain', res));
    }
  }
}
async function flushOutBuf() {
  if (outBuf) {
    const data = outBuf; outBuf = '';
    if (!sortProc.stdin.write(data)) {
      await new Promise(res => sortProc.stdin.once('drain', res));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Batched pckimmo `generate` runner
// ──────────────────────────────────────────────────────────────────────
const BATCH_SIZE = 50_000;          // generate calls per pckimmo session
const BATCH_TIMEOUT_MS = 5 * 60 * 1000;

// Output shape pckimmo emits per generate:
//   PC-KIMMO>generate <lex_form>
//   <surface>           (or empty line for failures pre-printout)
//   <blank>
// On failure: an `ERROR ...` block and/or `*** NONE ***`.
//
// We capture each `<surface>` that follows a `PC-KIMMO>generate` line
// IF it doesn't start with `***` or `ERROR`. The surface may contain
// digits/punct mixed in if the affix used uppercase tags
// (e.g. `+PL` literal-leaked the `PL`). We filter those at the
// final lex-line gate: surface must be lowercase Latin / apostrophe /
// hyphen / digits, no spaces. (The generate may also emit boundary
// markers like `^` or `0`; those are dropped by the same filter.)

const GENERATE_ECHO_RE = /^PC-KIMMO>generate\s+(.+)$/;
// Accept surfaces that look like real English words: optional leading
// apostrophe, then a Latin letter, then up to 30 chars of letters /
// apostrophes / hyphens. Reject double-apostrophe artifacts
// (`archipelago''d`) and trailing-apostrophe artifacts
// (`cat'`) that come from stacking the morpheme boundary `+` with a
// literal apostrophe-bearing affix. Real English clitic chains use a
// single apostrophe even at stack depth ≥ 2 (e.g. `cats'`); pckimmo
// emitting `cats''` indicates a synthetic combination we don't want
// in the wlist.
const SURFACE_OK_RE    = /^'?[a-z][a-z0-9'-]{0,30}$/;
const HAS_BAD_APOS_RE  = /''|^[''-]$|[''-]$/;

let surfacesEmitted = 0;
let generateCalls = 0;
let acceptedSurfaces = 0;
let pendingInputForSurface = null;

function handleGenerateLine(line) {
  const m = GENERATE_ECHO_RE.exec(line);
  if (m) {
    pendingInputForSurface = m[1];
    generateCalls++;
    return;
  }
  if (pendingInputForSurface === null) return;
  if (!line.trim() || line.startsWith('***') || line.startsWith('ERROR')) {
    pendingInputForSurface = null;
    return;
  }
  // First non-blank, non-error line after `generate` is the surface.
  const surface = line.trim();
  pendingInputForSurface = null;
  const lc = surface.toLowerCase();
  if (SURFACE_OK_RE.test(lc) && !HAS_BAD_APOS_RE.test(lc)) {
    acceptedSurfaces++;
    // emitSurface returns a promise but we don't await per-line:
    // the upstream sort drains via the writable backpressure path.
    emitSurface(surface);
  }
}

async function runBatch(lexForms) {
  const tempPath = join(tmpdir(), `pck-gen-${process.pid}-${Date.now()}.take`);
  {
    const lines = [
      'set warnings off',
      'load rules english.rul',
      'load lexicon english.lex',
      'load grammar english.grm',
    ];
    for (const lf of lexForms) lines.push(`generate ${lf}`);
    lines.push('quit');
    writeFileSync(tempPath, lines.join('\n') + '\n');
  }

  const timeoutSecs = Math.max(1, Math.floor(BATCH_TIMEOUT_MS / 1000));
  const inFd = openSync(tempPath, 'r');
  const pck = spawn(
    'timeout',
    ['--kill-after=5', `${timeoutSecs}`, PCKIMMO_BIN],
    { cwd: ENGLEX_DIR, stdio: [inFd, 'ignore', 'pipe'] }
  );
  try { closeSync(inFd); } catch {}
  pck.on('error', (e) => { process.stderr.write(`pckimmo spawn error: ${e}\n`); });

  const rl = readline.createInterface({ input: pck.stderr, crlfDelay: Infinity });
  for await (const line of rl) handleGenerateLine(line);
  const code = await new Promise(res => pck.on('exit', res));
  try { unlinkSync(tempPath); } catch {}

  if (code === 124 || code === 137) {
    process.stderr.write(`[englex] DROP batch (timeout, exit ${code})\n`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Main: iterate enumerateLexForms() in BATCH_SIZE chunks
// ──────────────────────────────────────────────────────────────────────
let batch = [];
let batchIndex = 0;
const t0Total = Date.now();
for (const lf of enumerateLexForms()) {
  batch.push(lf);
  if (batch.length >= BATCH_SIZE) {
    batchIndex++;
    const t0 = Date.now();
    await runBatch(batch);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(
      `[englex] batch ${batchIndex} done in ${dt}s` +
      `  gen=${generateCalls}  accepted=${acceptedSurfaces}\n`
    );
    batch = [];
  }
}
if (batch.length) {
  batchIndex++;
  const t0 = Date.now();
  await runBatch(batch);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(
    `[englex] batch ${batchIndex} done in ${dt}s` +
    `  gen=${generateCalls}  accepted=${acceptedSurfaces}\n`
  );
}

await flushOutBuf();
sortProc.stdin.end();
await new Promise((res, rej) => {
  outFile.on('close', res);
  outFile.on('error', rej);
  gzipProc.on('error', rej);
  sortProc.on('error', rej);
});

const totalSecs = ((Date.now() - t0Total) / 1000).toFixed(1);
process.stderr.write(
  `[englex] DONE in ${totalSecs}s  generate-calls=${generateCalls}` +
  `  accepted-surfaces=${acceptedSurfaces}  → ${OUT}\n`
);
