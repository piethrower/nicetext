#!/usr/bin/env node
// build-all-fixtures.js: single-shot rebuild of everything under fixtures/.
// Drives the per-fixture builds from tools/byos/*.byos.json files. Each
// byos.json's `name` field plus `version` produce the canonical id (via
// js/src/byos.js getBYOSID); that id becomes the basename for the
// emitted dict and model files. Cards.json is emitted FIRST so the
// per-card build children can resolve their canonical id by reading it.
//
// Inputs (already in the repo, no network):
//   fixture-src/twlist/...           TWLIST sources (master uses these via fixtures)
//   fixture-src/texts/...            Corpus .txt files
//   tools/byos/*.byos.json       Canonical card specs
//
// Outputs (all gzipped at level 9):
//   fixtures/*.twlist.tsv.gz                 per-source TWLIST fixtures
//   fixtures/*.txt.gz                        canonical corpus texts
//   fixtures/cards.json                      card index (emitted FIRST)
//   fixtures/{getBYOSID}.dict.sab.gz         per-card dictionaries (sab-packed)
//   fixtures/{getBYOSID}.model.sab.gz        per-card sentence models (sab-packed)
//
// Usage:  node tools/build-all-fixtures.js

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import {
  generateBYOSID, validate as validateByos,
  FIXTURES_PREFIX, getCorpusFile,
} from '../js/src/byos.js';
import { cardsFsPath, repoPath } from './byos-build-helpers.js';
import { loadCorpusText } from './load-corpus.js';
import { assertNoFixturesViolations } from './sab-fixtures-guard.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOLS = join(ROOT, 'tools');
const BYOS_DIR = join(TOOLS, 'byos');
const FIXTURES = repoPath(FIXTURES_PREFIX);
const NODE = process.execPath;
const GZ_LEVEL = { level: zlibConstants.Z_BEST_COMPRESSION };

if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });

let producedCount = 0;

function gzipBuffer(buf, dstGzPath, srcLabel) {
  const gz = gzipSync(buf, GZ_LEVEL);
  writeFileSync(dstGzPath, gz);
  producedCount++;
  process.stderr.write(`  ${basename(dstGzPath)}  ${gz.length.toLocaleString()} bytes (from ${buf.length.toLocaleString()} ${srcLabel})\n`);
}

// Per-card model + dict builds (build-corpus-dict.js, build-model-table.js)
// and a few of the larger SAB packers grew past V8's default 4 GB old
// heap, surfacing as `Fatal error in , line 0: Check failed: (location_)
// != nullptr.` on fresh builds. Default every child to --max-old-space-
// size=8192; the build-freq-fixtures.js call site that already passes
// 8192 explicitly is now redundant but harmless. Callers can override
// by passing their own nodeFlags array.
const DEFAULT_NODE_FLAGS = ['--max-old-space-size=8192'];
function runTool(scriptPath, args = [], nodeFlags = DEFAULT_NODE_FLAGS) {
  const r = spawnSync(NODE, [...nodeFlags, scriptPath, ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${basename(scriptPath)} exited ${r.status}`);
}

// 0a. Discover canonical byos cards and emit fixtures/cards.data.js.
//     Done FIRST because tools/sab.js imports cards.data.js at module
//     load time (its packers resolve per-card filenames via the card
//     registry); the redacted-wlist SAB pack below depends on sab.js
//     and would fail on a fresh build with no cards.data.js present.
//     Each child build script also rebuilds this same array from the
//     byos source files via byos-build-helpers.loadCardsRegistry, so
//     the runtime artifact and the build-time data agree by
//     construction.
process.stderr.write('--- 0a. Discover byos cards + emit cards.data.js ---\n');
const byosFiles = readdirSync(BYOS_DIR).filter(f => f.endsWith('.byos.json')).sort();
const cards = [];
const cardsIndex = [];
for (const f of byosFiles) {
  const path = join(BYOS_DIR, f);
  const byos = JSON.parse(readFileSync(path, 'utf8'));
  validateByos(byos);
  cards.push({ file: f, path, byos });
  // Public spec carries the full byos including `build`, so the runtime
  // (js/src/builder/session.js) can derive the corpus fixture filename
  // for any card without a hand-maintained map. Adds ~30 bytes per card.
  cardsIndex.push({ ...byos, byosID: generateBYOSID(byos) });
  process.stderr.write(`  ${f}  →  byosID=${generateBYOSID(byos)}\n`);
}
const cardsPath = cardsFsPath();
const cardsHeader = `// AUTO-GENERATED. Do not edit by hand.
//
// Source of truth: tools/byos/*.byos.json
// Regenerate with: node tools/build-all-fixtures.js
//
// Each entry is the public spec of one canonical byos card with the
// long-form byosID precomputed. js/src/byos.js getBYOSID consumes this
// array to resolve nicknames; tests and js/app.js import it
// synchronously as the single runtime source of truth for the card
// registry.\n`;
const cardsBody = `export default ${JSON.stringify(cardsIndex, null, 2)};\n`;
writeFileSync(cardsPath, cardsHeader + cardsBody);
process.stderr.write(`  wrote ${cardsPath.replace(ROOT + '/', '')} (${cardsIndex.length} cards)\n`);

// 0b. Confusables fold map. precleanCorpus.js (wired into genmodel.js
//     and listword.js) imports fixtures/confusables-data.js, so it must
//     exist before any corpus/dict/model build. The committed
//     fixture-src/confusables/cooked/ artifact is the source of truth;
//     build-confusables-map.js is a no-op unless fetch.js refreshed the
//     gitignored raw/. Copy the cooked artifact into /fixtures.
process.stderr.write('\n--- 0b. Confusables fold map (cooked → fixtures) ---\n');
runTool(join(TOOLS, 'build-confusables-map.js'));
const confusablesCooked = join(ROOT, 'fixture-src', 'confusables', 'cooked', 'confusables-data.js');
const confusablesOut = join(FIXTURES, 'confusables-data.js');
copyFileSync(confusablesCooked, confusablesOut);
process.stderr.write(`  wrote ${confusablesOut.replace(ROOT + '/', '')}\n`);

// 0c. Fonts. The third-party font ships under fixture-src/font/cooked/;
//     build-font.js is a no-op unless a manual refresh placed a newer
//     file in the gitignored raw/. Copy the cooked font into
//     fixtures/font/ (the path css/nicetext.css @font-face loads). It
//     doesn't gate other builds, but sits next to confusables as the
//     other cooked → fixtures static-asset deploy.
process.stderr.write('\n--- 0c. Fonts (cooked → fixtures) ---\n');
runTool(join(TOOLS, 'build-font.js'));
const fontFile = 'AppleIiScreenTypeface-2aP3.ttf';
const fontCooked = join(ROOT, 'fixture-src', 'font', 'cooked', fontFile);
const fontDir = join(FIXTURES, 'font');
if (!existsSync(fontDir)) mkdirSync(fontDir, { recursive: true });
copyFileSync(fontCooked, join(fontDir, fontFile));
process.stderr.write(`  wrote ${join(fontDir, fontFile).replace(ROOT + '/', '')}\n`);

// 0d. Redacted wlist + SAB. Every downstream gendict/genmodel/listword/
//     sortDict call invokes getRedactedSingles() / getRedactedMatcher()
//     via loadResource, which reads fixtures/redacted.wlist.sab.gz.
//     Build the native + pack the SAB now so the rest of the pipeline
//     can resolve it.
process.stderr.write('\n--- 0d. Redacted wlist (native + SAB) ---\n');
runTool(join(TOOLS, 'build-redacted-wlist.js'));
runTool(join(TOOLS, 'sab.js'), ['pack', 'wlist']);

// 1. TWLIST fixtures: build-twlist-fixtures.js writes .gz directly.
process.stderr.write('\n--- 1. TWLIST fixtures ---\n');
runTool(join(TOOLS, 'build-twlist-fixtures.js'));

// 3. Materialize a runtime-fetchable corpus-text fixture per unique
//    byos.build.corpus. Multiple cards may share a corpus, so dedupe by
//    destination filename. loadCorpusText handles both single-file and
//    glob sources (texting-teen*.txt → concatenated + EOS-substituted).
process.stderr.write('\n--- 3. Corpus texts (runtime fixtures) ---\n');
const corpusJobs = new Map();
for (const card of cards) {
  const dst = getCorpusFile(card.byos);
  if (!dst) continue;
  if (!corpusJobs.has(dst)) corpusJobs.set(dst, card.byos.build.corpus);
}
for (const [dst, srcRel] of corpusJobs) {
  const srcPath = repoPath(srcRel);
  const text = loadCorpusText(srcPath);
  gzipBuffer(Buffer.from(text, 'utf8'), join(FIXTURES, dst), `chars from ${srcRel}`);
}

// 4. Per-card builds. Dispatch on whether the byos has a base block (with
//    no story or story.style='flat') or a non-flat story.
process.stderr.write('\n--- 4. Per-card dict + model builds ---\n');
for (const card of cards) {
  const { file, path, byos } = card;
  const isFlat = !byos.story || byos.story.style === 'flat';
  if (isFlat) {
    process.stderr.write(`\n[${file}] base-dict build\n`);
    runTool(join(TOOLS, 'build-base-dict.js'), [path]);
  } else {
    process.stderr.write(`\n[${file}] corpus-dict + model build\n`);
    runTool(join(TOOLS, 'build-corpus-dict.js'), [path]);
    runTool(join(TOOLS, 'build-model-table.js'), [path]);
  }
}

// 5. Wlist natives. One .wlist.txt.gz per unique corpus stem (from
//    its corpus text) plus one per twlist source (projection of the
//    .twlist.tsv.gz word column). These are the native intermediates
//    that step 6's `sab pack wlist` compiles into the canonical
//    .wlist.sab.gz runtime fixtures. Eve consumes these directly
//    (corpus-vocab AND per-twlist-source word-membership); BYOS does
//    not: BYOS reads the typed twlist via `loadResource(_, 'twlist')`,
//    which is the entries-SAB form.
process.stderr.write('\n--- 5. wlist natives (corpus + twlist projections) ---\n');
runTool(join(TOOLS, 'build-corpus-wlist.js'));
runTool(join(TOOLS, 'build-twlist-wlist.js'));

// 5a. Freq fixtures. Reads fixture-src/freq/<source>/ raw data and
//     writes fixtures/<source>.freq.tsv.gz natives. Sources skip
//     silently if their raw input is missing. `sab pack freq` later
//     compiles each native into the canonical .freq.sab.gz.
process.stderr.write('\n--- 5a. freq natives ---\n');
// Gutenberg's per-word counts map exhausts the default 4 GB V8 heap;
// see the REQUIRED note at the top of build-freq-fixtures.js. Pass
// --max-old-space-size=8192 so the orchestrator works on a fresh
// clone with raw gutenberg present.
runTool(join(TOOLS, 'build-freq-fixtures.js'), [], ['--max-old-space-size=8192']);

// 5b. Rewriter fixtures (cover-transforms; docs/cover-transforms.md).
//     Bakes fixtures/<rewriter>.data.js for rewriters under the SAB
//     storage threshold (~1K entries). Today only xanax has source
//     data; build-rewriter-fixtures.js is the categorical entry
//     point so future rewriters fold in without touching this script.
process.stderr.write('\n--- 5b. rewriter fixtures (baked JS) ---\n');
runTool(join(TOOLS, 'build-rewriter-fixtures.js'));

// 6. SAB pack the converted fixture types. Builders in step 4/5 emit
//    native intermediates (.dict.json.gz, .model.json.gz, .wlist.txt.gz
//    today; twlist/freq/emoji-* as their sab-conversion commits land);
//    `sab pack <type>` compiles each into the canonical .sab.gz runtime
//    fixture and deletes the native. The rule is "/fixtures is
//    zero-parse SAB only", this is the step that enforces it for the
//    converted types.
//
//    All six resource categories are now wired: dict, model, wlist,
//    twlist, freq, emoji-cldr. twlist runs AFTER wlist natives are
//    produced (step 5), because `sab pack twlist` deletes the
//    .twlist.tsv.gz natives and build-twlist-wlist.js reads those
//    natives to produce wlist natives.
process.stderr.write('\n--- 6. sab pack converted categories ---\n');
runTool(join(TOOLS, 'sab.js'), ['pack', 'dict']);
runTool(join(TOOLS, 'sab.js'), ['pack', 'model']);
runTool(join(TOOLS, 'sab.js'), ['pack', 'wlist']);
runTool(join(TOOLS, 'sab.js'), ['pack', 'twlist']);
// Freq SAB is packed directly from cooked by build-freq-fixtures.js
// (step 5a). No .freq.tsv.gz native ever lands in /fixtures, so
// nothing here for sab.js to pick up.
runTool(join(TOOLS, 'sab.js'), ['pack', 'emoji-cldr']);
runTool(join(TOOLS, 'sab.js'), ['pack', 'rewriter']);

// 7. Eve precomputes. Per-corpus monotyped-model fixture cached as
//    fixtures/<stem>.monotyped-model.sab.gz so the Eavesdropper tab
//    and the node CLI skip the genmodel pass on every session start.
//    Driven from cards.data.js (emitted in step 2), so the precompute
//    set stays in sync with the runtime corpus set. Runs after step 3
//    (corpus-text fixtures) so the in-process builder sees the same
//    shipped corpora the runtime sees. corpus-vocab is no longer
//    produced here, it lives at /fixtures/<stem>.wlist.sab.gz post
//    step 6.
process.stderr.write('\n--- 7. Eve precomputes (monotyped-model) ---\n');
runTool(join(TOOLS, 'build-monotyped-models.js'));

// 8. Discipline guard. Final assertion that /fixtures contains only
//    SAB fixtures + corpora + the three allowlisted runtime metadata
//    files. Any stray non-SAB fixture fails the build loudly here,
//    so a regression (e.g., a builder accidentally writing a .json
//    intermediate that doesn't get cleaned up) can't slip in
//    unnoticed. The same check runs as a node test
//    (tests/node/sab-fixtures-guard.test.js) so CI catches it too.
//    See tools/sab-fixtures-guard.js.
process.stderr.write('\n--- 8. sab-fixtures-guard ---\n');
assertNoFixturesViolations(repoPath('fixtures'));
process.stderr.write('  guard: /fixtures is clean (sab.gz + allowlist only)\n');

process.stderr.write(`\n--- done ---\n`);
process.stderr.write(`fixtures/ rebuilt; ${producedCount} corpus-text artifacts gzipped above (TWLIST + dict + model + eve artifacts logged by their own tools).\n`);
