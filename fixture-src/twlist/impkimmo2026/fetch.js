#!/usr/bin/env node
// fetch.js: produce impkimmo2026.twlist.gz alongside this script by
// running every word in fixture-src/wlist/master.wlist.gz through PC-KIMMO
// loaded with ENGLEX, then folding each parse's category + feature
// bundle into a canonical type string in the same shape that OG
// NiceText's import/src/impkimmo.l emitted.
//
// External PC-KIMMO + ENGLEX are NOT redistributed in this repo. They
// must be installed by the developer at ../../../../pckimmo2026/
// (sibling to the nicetext repo). Concretely:
//
//   /home/<you>/software/nicetext/                        ← this repo
//   /home/<you>/software/pckimmo2026/CarlaLegacy/         ← sibling
//   /home/<you>/software/pckimmo2026/englex/eng/          ← sibling
//
// One-time setup (do once on the build machine):
//
//   mkdir -p ../../../../pckimmo2026 && cd ../../../../pckimmo2026
//   git clone --depth 1 https://github.com/sillsdev/CarlaLegacy.git
//   cd CarlaLegacy/pc-parse
//   ./configure
//   make    # pcpatr will error on missing libample.a; ignore, the
//           # pckimmo + ktext binaries we need are already built
//   cd ../../
//   mkdir -p downloads && cd downloads
//   curl -fsSL -O https://downloads.sil.org/legacy/pc-kimmo/engl20b5.zip
//   cd .. && unzip -q downloads/engl20b5.zip -d englex
//
// Licenses (NOT redistributed; download from canonical sources above):
//
//   PC-KIMMO source (CarlaLegacy): dual GPLv2 OR CPL-0.5 per
//     License/SIL_open_source_license.htm in the CarlaLegacy repo.
//   ENGLEX 2.0b5 (1995):
//     "Copyright (C) 1991-1995, Summer Institute of Linguistics, Inc.
//      Use, copying, modification, and distribution permitted."
//     (from englex/eng/README and english.lex header)
//
// Our use of the engine to emit a derived word list and ship only that
// list is well within both licenses; we do not redistribute the engine
// or the bundled lexicons themselves.
//
// Pipeline:
//
//   master.wlist.gz       (this repo, ~6M lowercase WORD-tokens)
//        │ gunzip + line-stream
//        ▼
//   pckimmo stdin         "recognize <word>\n" per line, prefixed by
//        │                a small take-file header that loads ENGLEX
//        ▼
//   pckimmo stdout        PC-KIMMO interactive output with rich
//        │                PATR feature blocks per parse
//        ▼
//   parser (this script)  state machine that tracks the current
//        │                word and accumulates feature flags per
//        │                Word: block, mirroring OG impkimmo.l
//        ▼
//   sort -u | gzip -9     external sort -u (LC_ALL=C) for dedup,
//        │                gzip for the final on-disk format
//        ▼
//   impkimmo2026.twlist.gz  same line format as the OG impkimmo
//                            twlist: "<TYPE> <WORD>" per line.

import {
  closeSync, createReadStream, createWriteStream,
  openSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const HERE     = dirname(fileURLToPath(import.meta.url));
const REPO     = resolve(HERE, '..', '..', '..');               // .../nicetext
const PCKIMMO_ROOT = resolve(REPO, '..', 'pckimmo2026');         // sibling
const PCKIMMO_BIN  = join(PCKIMMO_ROOT, 'CarlaLegacy', 'pc-parse', 'pckimmo', 'pckimmo');
const ENGLEX_DIR   = join(PCKIMMO_ROOT, 'englex', 'eng');
const MASTER_WLIST = process.env.MASTER_WLIST_PATH
  ? resolve(process.env.MASTER_WLIST_PATH)
  : join(REPO, 'fixture-src', 'wlist', 'master.wlist.gz');
const OUT          = process.env.IMPKIMMO2026_OUT
  ? resolve(process.env.IMPKIMMO2026_OUT)
  : join(HERE, 'impkimmo2026.twlist.gz');

// Variant outputs derived from the SAME recognize pass. Each is an
// independent twlist axis the user may opt into via BYOS, mutually
// orthogonal to the baseline:
//   - cform    : 7-way clitic identity (`+GEN`/`+have`/`+be`/`+will`/
//                `+would`/`+will+have`/`+would+have`), the baseline
//                only flagged `+GEN`.
//   - root     : the morphological root morpheme (one type per root,
//                ~17K distinct values; `cat`, `cats`, `cat's` cluster).
//   - rootpos  : the POS of the morphological root, distinct from the
//                surface POS for derived forms (`happiness` ← AJ,
//                `runner` ← V, `nationalize` ← N, `quickly` ← AJ).
//   - drvstem  : a yes/no flag for "this surface form was built by
//                attaching a derivational suffix to a root".
const OUT_CFORM   = process.env.IMPKIMMO2026_CFORM_OUT
  ? resolve(process.env.IMPKIMMO2026_CFORM_OUT)
  : join(HERE, 'impkimmo2026-cform.twlist.gz');
const OUT_ROOT    = process.env.IMPKIMMO2026_ROOT_OUT
  ? resolve(process.env.IMPKIMMO2026_ROOT_OUT)
  : join(HERE, 'impkimmo2026-root.twlist.gz');
const OUT_ROOTPOS = process.env.IMPKIMMO2026_ROOTPOS_OUT
  ? resolve(process.env.IMPKIMMO2026_ROOTPOS_OUT)
  : join(HERE, 'impkimmo2026-rootpos.twlist.gz');
const OUT_DRVSTEM = process.env.IMPKIMMO2026_DRVSTEM_OUT
  ? resolve(process.env.IMPKIMMO2026_DRVSTEM_OUT)
  : join(HERE, 'impkimmo2026-drvstem.twlist.gz');

async function checkPath(p, label) {
  try { await stat(p); }
  catch {
    process.stderr.write(
      `\nfetch.js: missing ${label}: ${p}\n` +
      `Set up the external PC-KIMMO / ENGLEX workspace per the header of this script.\n`
    );
    process.exit(1);
  }
}

await checkPath(PCKIMMO_BIN, 'pckimmo binary');
await checkPath(ENGLEX_DIR,  'ENGLEX directory');
await checkPath(MASTER_WLIST, 'master wlist (run tools/build-master-wlist.js first)');

// ──────────────────────────────────────────────────────────────────────
// Output pipelines: parser → sort -u → gzip -9 → {OUT, OUT_CFORM,
// OUT_ROOT, OUT_ROOTPOS, OUT_DRVSTEM}. We run five sort/gzip pairs
// concurrently: each variant is a self-contained twlist file. The
// per-sort buffer is sized down to 128 MiB (vs the original 512 MiB)
// because in the 20-way-parallel shard mode there are now 100 sort
// processes running at once.
const fsMod = await import('node:fs');
function makeOutputPipeline(outPath) {
  const sortP = spawn('sort',
    ['-u', '-S', '128M'],
    { env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const gzipP = spawn('gzip',
    ['-9', '-c'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  sortP.stdout.pipe(gzipP.stdin);
  const fileP = fsMod.createWriteStream(outPath);
  gzipP.stdout.pipe(fileP);
  return { sortP, gzipP, fileP };
}
const pipeBaseline = makeOutputPipeline(OUT);
const pipeCform    = makeOutputPipeline(OUT_CFORM);
const pipeRoot     = makeOutputPipeline(OUT_ROOT);
const pipeRootpos  = makeOutputPipeline(OUT_ROOTPOS);
const pipeDrvstem  = makeOutputPipeline(OUT_DRVSTEM);

// Aliases for the baseline pipeline so the rest of the file (which
// already uses `sortProc`/`gzipProc`/`outFile`) keeps working unchanged.
const sortProc = pipeBaseline.sortP;
const gzipProc = pipeBaseline.gzipP;
const outFile  = pipeBaseline.fileP;

let typeWordCount = 0;
function emitTypeWord(type, word) {
  sortProc.stdin.write(`${type} ${word}\n`);
  typeWordCount++;
}
function emitVariant(pipe, type, word) {
  pipe.sortP.stdin.write(`${type} ${word}\n`);
}

// ──────────────────────────────────────────────────────────────────────
// PC-KIMMO child: batched. Each batch spawns a fresh pckimmo, loads
// ENGLEX, runs ~BATCH_SIZE recognize calls, then exits. We restart
// because pckimmo 2.1.14 leaks ~45 KB of internal parse state per
// recognize call. With BATCH_SIZE = 50_000 words (= ~100_000
// recognizes including the title-case pass), per-session peak memory
// stays around 5 GB and throughput stays at the fresh-cache rate.
// Larger batches (e.g. 200_000) hit a throughput cliff partway through
// once the leaked state crosses ~20 GB. Per-batch wall time is
// dominated by recognize work, not by ENGLEX load (~2-3 s startup vs.
// tens of seconds of parsing), so the restart overhead is negligible.
const BATCH_SIZE = 50_000;
// Hard cap on per-batch wall time. Beyond this we SIGKILL pckimmo
// and accept partial coverage for the batch's worst-case inputs.
// A typical 50K-word batch finishes in 5-30 s; the cap is set to
// be ~10× the high-end normal range so we only fire on real
// runaways.
const BATCH_TIMEOUT_MS = 5 * 60 * 1000;
async function runBatch(words) {
  // Architecture: write the batch's `recognize` lines (plus the
  // ENGLEX load header and a trailing `quit`) to a tempfile, then
  // spawn `timeout T pckimmo < tempfile`. The OS-level timeout(1)
  // wrapper gives us a HARD wall-clock kill on pckimmo regardless of
  // any Node-side backpressure or hang. Earlier in-process Node-side
  // timeout approaches were fragile: on inputs that put pckimmo into
  // a parse explosion (51 GB RSS within a single 50K-word batch),
  // pck.stdin.write() blocked on backpressure before the JS
  // setTimeout could fire, and Node-internal stream events stopped
  // firing cleanly after SIGKILL. The tempfile + OS-timeout shape
  // makes each batch a clean self-contained subprocess: we never
  // write to a hung child's stdin, and reading the SIGKILL'd
  // child's stderr to EOF is trivial.
  //
  // PC-KIMMO writes everything to STDERR (prompts, parse blocks,
  // gloss decomps). Its stdout stays empty.
  const tempPath = join(tmpdir(), `pck-batch-${process.pid}-${Date.now()}.take`);
  {
    const lines = [
      'set warnings off',
      'load rules english.rul',
      'load lexicon english.lex',
      'load grammar english.grm',
    ];
    for (const word of words) {
      lines.push(`recognize ${word}`);
      const titled = word.charAt(0).toUpperCase() + word.slice(1);
      if (titled !== word) lines.push(`recognize ${titled}`);
    }
    lines.push('quit');
    writeFileSync(tempPath, lines.join('\n') + '\n');
  }

  const timeoutSecs = Math.max(1, Math.floor(BATCH_TIMEOUT_MS / 1000));
  const inFd = openSync(tempPath, 'r');
  const pck = spawn(
    'timeout',
    ['--kill-after=5', `${timeoutSecs}`, PCKIMMO_BIN],
    {
      cwd: ENGLEX_DIR,
      stdio: [inFd, 'ignore', 'pipe'],
    }
  );
  try { closeSync(inFd); } catch {}
  pck.on('error', (e) => { process.stderr.write(`pckimmo spawn error: ${e}\n`); });
  process.stderr.write(`[pck] spawn pid=${pck.pid} n=${words.length}\n`);

  // Parser. Module-level parser state (currentWord, acc, depth,
  // seenForWord) resets naturally as new `PC-KIMMO>recognize` lines
  // arrive; ENGLEX-load messages from the batch's startup don't match
  // any of the parser's patterns and are ignored.
  const rlOut = readline.createInterface({ input: pck.stderr, crlfDelay: Infinity });
  for await (const line of rlOut) handleStdoutLine(line);

  // `timeout` exits 124 when it killed the child by wall-clock, 137
  // when it had to SIGKILL after SIGTERM didn't take effect, 0 when
  // pckimmo exited cleanly.
  const code = await new Promise(res => pck.on('exit', res));
  try { unlinkSync(tempPath); } catch {}
  if (code === 124 || code === 137) {
    process.stderr.write(`[pck] DROP batch pid=${pck.pid} timed out (exit ${code})\n`);
  } else {
    process.stderr.write(`[pck] exit pid=${pck.pid} code=${code}\n`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// pckimmo stdout parser (state machine, mirrors impkimmo.l field set)
// ──────────────────────────────────────────────────────────────────────
//
// Tokens of interest we see in the stream (case-sensitive):
//
//   PC-KIMMO>recognize <word>     → boundary: new current word
//   Word:                         → start of a feature block (parse)
//   <feature>: <value>            → accumulate into current parse
//   ] (matching the outer [)      → emit (type, current_word)
//   N parse(s) found              → end-of-word marker (we don't need
//                                   this beyond progress logging because
//                                   each `]`-at-depth-1 emits already)
//   *** NONE ***                  → no parses; nothing to emit
//
// Feature concatenation order (from impkimmo.l show()):
//
//   pos · sg3 · person · number · proper · tense · vform · finite ·
//   aform · verbal · case · reflex · wh · reg · modal · neg · clitic ·
//   cform_gen_plus
//
// Output value strings exactly mirror the OG show() mappings:
//
//   pos     ∈ {N, V, AJ, AV, AUX, PP, PR, CJ, DT, IJ, INF}
//   sg3     ∈ {3sg+, 3sg-}
//   person  ∈ {1, 2, 3}
//   number  ∈ {Sg, Pl}
//   proper  ∈ {Prop+, Prop-}
//   tense   ∈ {Pres, Past}
//   vform   ∈ {S, Ed, En, Ing, Base}
//   finite  ∈ {Fin+, Fin-}
//   aform   ∈ {Abs, Comp, Super}
//   verbal  ∈ {Verbal+, Verbal-}
//   case    ∈ {Nom, Acc, Gen, Ind}
//   reflex  ∈ {Reflex+, Reflex-}
//   wh      ∈ {Wh+, Wh-}
//   reg     ∈ {Reg+, Reg-}
//   modal   ∈ {Mod+, Mod-}
//   neg     ∈ {Neg+, Neg-}
//   clitic  ∈ {Cform}
//   cform_gen_plus ∈ {CFormGen+}

const FIELD_ORDER = [
  'pos', 'sg3', 'person', 'number', 'proper', 'tense', 'vform', 'finite',
  'aform', 'verbal', 'case', 'reflex', 'wh', 'reg', 'modal', 'neg',
  'clitic', 'cform_gen_plus',
];

// Per-parse accumulator carries the OG-style FIELD_ORDER values used
// to build the baseline type string AND the four variant-only fields
// (cform_full, root, root_pos, drvstem) that drive the four extra
// twlists. emptyAcc() zeroes all of them.
function emptyAcc() {
  const o = {};
  for (const k of FIELD_ORDER) o[k] = '';
  o.cform_full = '';
  o.root = '';
  o.root_pos = '';
  o.drvstem = '';
  return o;
}

// Whitespace between `field:` and its value is variable in pckimmo's
// pretty-printer (`pos:   N` vs `number:SG` vs `person:1`), so every
// feature regex uses `\s*` rather than `\s+`. The colon is what
// disambiguates the field, the space count is cosmetic padding.
// ──────────────────────────────────────────────────────────────────────
// Field observation (audit-only, no behavior change)
//
// Builds a Map<field-name, Set<value>> of every distinct `<field>:
// <value>` pair that pckimmo emits inside Word: feature blocks during
// this run. Written to FIELDS_OBSERVED_PATH at exit so we can see
// what the OG impkimmo.l field set leaves on the table, `root`,
// `root_pos`, `drvstem`, and all the non-+GEN values of `cform`,
// among others. Does not change the type-derivation output of this
// script; the project decision on whether to add observed fields to
// the type string (or split them into separate variant twlists) is
// deferred to the developer.
const observedFields = new Map();   // field → Set<value>
const FIELDS_OBSERVED_PATH = process.env.FIELDS_OBSERVED_PATH
  ? resolve(process.env.FIELDS_OBSERVED_PATH)
  : join(HERE, 'fetch-fields-seen.tsv');
const GENERIC_FIELD_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*?):\s*(\$\d+\[[^\]]*\]|[^\s\]\[]+(?:\s+[^\s\]\[]+)?)/g;
function observeFieldsInLine(line) {
  // Strip trailing punctuation/brackets from the matched value.
  let m;
  GENERIC_FIELD_RE.lastIndex = 0;
  while ((m = GENERIC_FIELD_RE.exec(line)) !== null) {
    const field = m[1];
    let value = m[2].replace(/[\]\s]+$/, '');
    if (!value) continue;
    let s = observedFields.get(field);
    if (!s) { s = new Set(); observedFields.set(field, s); }
    s.add(value);
  }
}

const POS_RE     = /\bpos:\s*(N|V|AJ|AV|AUX|PP|PR|CJ|DT|IJ|INF)\b/;
const SG3_RE     = /\b3sg:\s*([+-])/;
const PERSON_RE  = /\bperson:\s*([123])\b/;
const NUMBER_RE  = /\bnumber:\s*(SG|PL)\b/;
const PROPER_RE  = /\bproper:\s*([+-])/;
const TENSE_RE   = /\btense:\s*(PRES|PAST)\b/;
const VFORM_RE   = /\bvform:\s*(S|ED|EN|ING|BASE)\b/;
const FINITE_RE  = /\bfinite:\s*([+-])/;
const AFORM_RE   = /\baform:\s*(ABS|COMP|SUPER)\b/;
const VERBAL_RE  = /\bverbal:\s*([+-])/;
const CASE_RE    = /\bcase:\s*(NOM|ACC|GEN|IND)\b/;
const REFLEX_RE  = /\breflex:\s*([+-])/;
const WH_RE      = /\bwh:\s*([+-])/;
const REG_RE     = /\breg:\s*([+-])/;
const MODAL_RE   = /\bmodal:\s*([+-])/;
const NEG_RE     = /\bneg:\s*([+-])/;
const CLITIC_RE  = /\bclitic:\s*cform\b/;
const CFORMGEN_RE = /\bcform:\s*\+GEN\b/;
// Variant-only captures (don't affect baseline type string):
//   cform-full: full value after the colon (`+GEN`, `+have`, `+be`,
//               `+will`, `+would`, `+will+have`, `+would+have`).
//   root      : the morphological root token (e.g. `` `cat ``, `de\`lude``);
//               the backtick is ENGLEX's stress marker, stripped at emit time.
//   root_pos  : the POS of the root.
//   drvstem   : a `+` or `-` flag.
const CFORM_FULL_RE = /\bcform:\s*(\+[A-Za-z+]+)/;
const ROOT_RE       = /^\s*root:\s*(\S+)\s*$/;
const ROOT_POS_RE   = /^\s*root_pos:\s*([A-Z]+)\s*$/;
const DRVSTEM_RE    = /\bdrvstem:\s*([+-])/;
const WORD_RE    = /^PC-KIMMO>recognize\s+(\S+)\s*$/;
const PARSES_RE  = /^\d+\s+parse(?:s)?\s+found\s*$/;

// Capitalize-first-lower-rest, used for several enum mappings.
function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function captureLineFeatures(line, acc) {
  let m;
  if ((m = POS_RE.exec(line)))      acc.pos = m[1];
  if ((m = SG3_RE.exec(line)))      acc.sg3 = `3sg${m[1]}`;
  if ((m = PERSON_RE.exec(line)))   acc.person = m[1];
  if ((m = NUMBER_RE.exec(line)))   acc.number = titleCase(m[1]);
  if ((m = PROPER_RE.exec(line)))   acc.proper = `Prop${m[1]}`;
  if ((m = TENSE_RE.exec(line)))    acc.tense = titleCase(m[1]);
  if ((m = VFORM_RE.exec(line)))    acc.vform = titleCase(m[1]);
  if ((m = FINITE_RE.exec(line)))   acc.finite = `Fin${m[1]}`;
  if ((m = AFORM_RE.exec(line)))    acc.aform = titleCase(m[1]);
  if ((m = VERBAL_RE.exec(line)))   acc.verbal = `Verbal${m[1]}`;
  if ((m = CASE_RE.exec(line)))     acc.case = titleCase(m[1]);
  if ((m = REFLEX_RE.exec(line)))   acc.reflex = `Reflex${m[1]}`;
  if ((m = WH_RE.exec(line)))       acc.wh = `Wh${m[1]}`;
  if ((m = REG_RE.exec(line)))      acc.reg = `Reg${m[1]}`;
  if ((m = MODAL_RE.exec(line)))    acc.modal = `Mod${m[1]}`;
  if ((m = NEG_RE.exec(line)))      acc.neg = `Neg${m[1]}`;
  if (CLITIC_RE.test(line))         acc.clitic = 'Cform';
  if (CFORMGEN_RE.test(line))       acc.cform_gen_plus = 'CFormGen+';
  // Variant fields. Each can appear at most once per parse block.
  if ((m = CFORM_FULL_RE.exec(line))) acc.cform_full = m[1];
  if ((m = ROOT_RE.exec(line)))       acc.root = m[1];
  if ((m = ROOT_POS_RE.exec(line)))   acc.root_pos = m[1];
  if ((m = DRVSTEM_RE.exec(line)))    acc.drvstem = m[1];
}

function buildTypeString(acc) {
  if (!acc.pos) return null;
  let suffix = '';
  for (const k of FIELD_ORDER.slice(1)) suffix += acc[k];
  return suffix ? `${acc.pos}_${suffix}` : acc.pos;
}

// State: currentWord (set on PC-KIMMO>recognize), inBlock (true between
// `Word:` and the closing `]` at depth 0), depth (bracket counter),
// acc (per-block feature accumulator), seenForWord (Set guarding
// against pckimmo emitting the same (type, word) twice from two
// equivalent parses, saves work for the downstream sort).
let currentWord = null;
let inBlock = false;
let depth = 0;
let acc = emptyAcc();
const seenForWord = new Set();
let wordsAnalyzed = 0;
let wordsWithAnyParse = 0;

function finalizeBlock() {
  if (!currentWord) return;
  const type = buildTypeString(acc);
  if (type) {
    const key = type + '\0' + currentWord;
    if (!seenForWord.has(key)) {
      seenForWord.add(key);
      emitTypeWord(type, currentWord);
    }
  }
  // Variant emits. Each variant is its own axis; dedup uses a
  // variant-namespaced key so the baseline dedup is untouched.
  // cform variant: 7 distinct contracted clitic identities.
  if (acc.cform_full) {
    // cform values look like `+GEN`, `+have`, `+would+have`. Normalize
    // to `cform_<value-without-leading-+-and-lowercased>` for the
    // twlist type name. `+would+have` becomes `cform_would_have`.
    const cfTag = 'cform_' + acc.cform_full.replace(/^\+/, '').replace(/\+/g, '_').toLowerCase();
    const cfKey = 'cf\0' + cfTag + '\0' + currentWord;
    if (!seenForWord.has(cfKey)) {
      seenForWord.add(cfKey);
      emitVariant(pipeCform, cfTag, currentWord);
    }
  }
  // root variant: type name = `root_<root>` with ENGLEX's leading
  // stress-marker backtick stripped, plus any internal backticks
  // dropped (e.g. `de\`lude` → `delude`). Roots are lowercased to
  // match the project dict invariant.
  if (acc.root) {
    const r = acc.root.replace(/`/g, '').toLowerCase();
    if (r) {
      const rTag = 'root_' + r;
      const rKey = 'rt\0' + rTag + '\0' + currentWord;
      if (!seenForWord.has(rKey)) {
        seenForWord.add(rKey);
        emitVariant(pipeRoot, rTag, currentWord);
      }
    }
  }
  // root_pos variant: 11 distinct values, type = `rootpos_<value>`.
  if (acc.root_pos) {
    const rpTag = 'rootpos_' + acc.root_pos.toLowerCase();
    const rpKey = 'rp\0' + rpTag + '\0' + currentWord;
    if (!seenForWord.has(rpKey)) {
      seenForWord.add(rpKey);
      emitVariant(pipeRootpos, rpTag, currentWord);
    }
  }
  // drvstem variant: 2 values, type = `drvstem_plus` or `drvstem_minus`.
  if (acc.drvstem) {
    const dvTag = acc.drvstem === '+' ? 'drvstem_plus' : 'drvstem_minus';
    const dvKey = 'dv\0' + dvTag + '\0' + currentWord;
    if (!seenForWord.has(dvKey)) {
      seenForWord.add(dvKey);
      emitVariant(pipeDrvstem, dvTag, currentWord);
    }
  }
  acc = emptyAcc();
}

function handleStdoutLine(line) {
  // Word boundary?
  let m = WORD_RE.exec(line);
  if (m) {
    // The dict invariant ("dicts are lowercase, case lives in the
    // model") means even when we fed pckimmo a Title-Cased form to
    // pick up ENGLEX's proper.lex entries, the emitted word column
    // is always lowercase. Proper-noun POS tags (e.g. `N_3sg+SgProp+`)
    // come through via the type column.
    currentWord = m[1].toLowerCase();
    seenForWord.clear();
    wordsAnalyzed++;
    if (wordsAnalyzed % 50000 === 0) {
      process.stderr.write(
        `[impkimmo2026] analyzed=${wordsAnalyzed}  parsed=${wordsWithAnyParse}` +
        `  emitted-rows=${typeWordCount}\n`
      );
    }
    return;
  }
  if (PARSES_RE.test(line)) {
    if (seenForWord.size > 0) wordsWithAnyParse++;
    return;
  }
  if (line.trim() === 'Word:') {
    inBlock = true;
    depth = 0;
    acc = emptyAcc();
    return;
  }
  if (!inBlock) return;
  for (const ch of line) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  captureLineFeatures(line, acc);
  observeFieldsInLine(line);
  if (depth <= 0) {
    finalizeBlock();
    inBlock = false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Feed words from master.wlist.gz into pckimmo's stdin.
// ──────────────────────────────────────────────────────────────────────

// PC-KIMMO is a CLI that expects bare words on `recognize` lines.
// We pre-filter to single-token forms it has any chance of accepting:
// lowercase Latin letters with optional internal apostrophe / hyphen /
// digit, capped at 30 characters total. A LEADING apostrophe is
// allowed so archaic / dialectal forms (`'tis`, `'twas`, `'cause`,
// `'em`, `'til`) reach ENGLEX, which has real entries for several of
// them (pckimmo recognize 'tis → PR_*).
// Length cap rationale: ENGLEX's longest root is
// `floccinaucinihilipilification` (29 chars); the master wlist carries
// ~2.6M entries ≥50 chars (joined-hyphen phrases like
// `'god-whose-name-may-not-be-spoken-aloud'`, OCR runs, DNA strings
// scraped out of biology Gutenberg texts) that can't possibly analyze
// and would just bloat the pckimmo throughput by ~5x.
// Anything else (emoji clusters, pure numbers like "$100", URLs with
// periods, leading-digit tokens, overlong runs) cannot analyze and is
// dropped here rather than clogging pckimmo with `*** NONE ***` output.
const KIMMO_INPUT_RE = /^'?[a-z]['a-z0-9-]{0,29}$/;

const wlistIn = readline.createInterface({
  input: createReadStream(MASTER_WLIST).pipe(createGunzip()),
  crlfDelay: Infinity,
});

// We feed EACH word twice (once lowercase and once title-case) so
// ENGLEX's case-sensitive lex catches both common-word entries (in
// english.lex / verb.lex / noun.lex etc., all lowercase) AND proper-
// noun entries (proper.lex, all Title-Cased). Without the title-case
// pass we lose ~3.4K OG impkimmo entries (Scot, Albanian, Friday, Ohio,
// philippines, etc., words that ENGLEX 1995 listed only as proper
// nouns). The two recognize calls per word are emitted inside
// runBatch() so they live in the same pckimmo session.
//
// Output word is always lowercase per the project dict invariant;
// capitalization is recoverable from the model.

let fed = 0;
let skipped = 0;
let batch = [];
let batchIndex = 0;
for await (const word of wlistIn) {
  if (!KIMMO_INPUT_RE.test(word)) { skipped++; continue; }
  batch.push(word);
  fed++;
  if (batch.length >= BATCH_SIZE) {
    batchIndex++;
    const t0 = Date.now();
    await runBatch(batch);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(
      `[impkimmo2026] batch ${batchIndex} done in ${dt}s  fed=${fed}  skipped=${skipped}` +
      `  emitted-rows=${typeWordCount}\n`
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
    `[impkimmo2026] batch ${batchIndex} done in ${dt}s  fed=${fed}  skipped=${skipped}` +
    `  emitted-rows=${typeWordCount}\n`
  );
}
process.stderr.write(`[impkimmo2026] EOF wlist: fed=${fed}  skipped=${skipped}\n`);

// Close every output pipeline. Each pipe must drain sort, gzip and
// the on-disk write stream before the next batch begins (because the
// process won't exit until all sub-children close their fds).
async function closePipe(pipe) {
  pipe.sortP.stdin.end();
  await new Promise((res, rej) => {
    pipe.fileP.on('close', res);
    pipe.fileP.on('error', rej);
    pipe.gzipP.on('error', rej);
    pipe.sortP.on('error', rej);
  });
}
await Promise.all([
  closePipe(pipeBaseline),
  closePipe(pipeCform),
  closePipe(pipeRoot),
  closePipe(pipeRootpos),
  closePipe(pipeDrvstem),
]);

process.stderr.write(
  `[impkimmo2026] DONE` +
  `  analyzed=${wordsAnalyzed}` +
  `  parsed=${wordsWithAnyParse}` +
  `  emitted-rows=${typeWordCount}` +
  `  → ${OUT}\n` +
  `  variants: cform=${OUT_CFORM}\n` +
  `            root=${OUT_ROOT}\n` +
  `            rootpos=${OUT_ROOTPOS}\n` +
  `            drvstem=${OUT_DRVSTEM}\n`
);

// Dump observed-field census to its own file. Format: TSV with one row
// per (field, value, sample-count is implicit, we don't count here,
// just record presence). Sort by field name then value for diffability.
{
  const KNOWN = new Set([
    // Fields the type string is built from (handled by FIELD_ORDER).
    'pos', '3sg', 'person', 'number', 'proper', 'tense', 'vform',
    'finite', 'aform', 'verbal', 'case', 'reflex', 'wh', 'reg', 'modal',
    'neg', 'clitic', 'cform',
  ]);
  const rows = [];
  for (const [field, vals] of observedFields) {
    for (const v of vals) {
      rows.push({ field, value: v, known: KNOWN.has(field) });
    }
  }
  rows.sort((a, b) =>
    a.field === b.field
      ? (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
      : (a.field < b.field ? -1 : 1));
  const body = ['field\tvalue\tknown_to_og_impkimmo'];
  for (const r of rows) body.push(`${r.field}\t${r.value}\t${r.known ? 'YES' : 'NO'}`);
  writeFileSync(FIELDS_OBSERVED_PATH, body.join('\n') + '\n');
  const newFields = new Set();
  for (const f of observedFields.keys()) if (!KNOWN.has(f)) newFields.add(f);
  process.stderr.write(
    `[impkimmo2026] fields-observed: ${observedFields.size} distinct fields,` +
    ` ${rows.length} (field,value) pairs` +
    ` (new beyond OG: ${[...newFields].join(',') || '(none)'})` +
    ` → ${FIELDS_OBSERVED_PATH}\n`
  );
}
