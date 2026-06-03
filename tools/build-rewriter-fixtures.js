#!/usr/bin/env node
// tools/build-rewriter-fixtures.js: production build for the
// cover-transforms rewriter fixtures (docs/cover-transforms.md).
//
// Each rewriter ships two SAB fixtures under fixtures/:
//
//   fixtures/rewriter-<name>.twlist.sab.gz
//       The unique-twlist SAB (NTEN format), packed at build time
//       from the rewriter module's exported type-name constants. Every
//       rewriter has one of these; sortdct loads it through the
//       standard twlist resource path when byos.rewriter.<name>
//       intensity > 0 (see js/src/worker/build-session-worker.js).
//
//   fixtures/<name>.rewriter.sab.gz  (NTRW)
//       Rewriter-private apply-time lookup data, never injected into
//       the dict, only consulted by the module's apply(). Universal
//       on-disk shape Map<string, Set<string>>; each rewriter
//       interprets keys and value-sets per its semantics (xanax:
//       next-word -> {correct-article}; typos: canonical -> {variants};
//       british: US -> {UK}; filler: position -> {fillers}; ...).
//
//   Build pipeline: this script writes the NTRW native form
//   (`fixtures/<name>.rewriter.json.gz`); `tools/sab.js pack rewriter`
//   then packs each native into the canonical .sab.gz and deletes the
//   native. The twlist SAB is emitted directly here (no native
//   intermediate) because the input is tiny constants, not corpus-
//   derived TSV.
//
// All four rewriters (xanax, british, typos, voice) ship source
// data and runtime fixtures. Each rewriter's build entry below
// reads its own fixture-src/ subtree and writes the corresponding
// fixtures/<name>.rewriter.* files.
//
// Inputs (already in the repo, no network):
//   fixture-src/pron/cmu/cmudict.dict.gz
//   fixture-src/rewriters/xanax/lib.js  (classifier primitives)
//
// Outputs:
//   fixtures/rewriter-xanax.twlist.sab.gz  (NTEN: xanax_a/a + xanax_an/an)
//   fixtures/xanax.rewriter.json.gz        (NTRW native: 689 CMU
//     exceptions reshaped as next-word -> [correct-article])
//
// Run after fetch.js artifacts exist; before sab pack steps in
// build-all-fixtures.js. Zero deps; Node built-ins only.

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadCmuMap, VOWEL_PHONEMES,
} from '../fixture-src/rewriters/xanax/lib.js';
import { packEntries } from '../js/src/builder/entries-sab.js';
import { saveSABtoFile } from '../js/src/sab.js';
import {
  XANAX_TYPE_A, XANAX_TYPE_AN,
} from '../js/src/rewriter/xanax.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CMU_PATH                = join(ROOT, 'fixture-src', 'pron', 'cmu', 'cmudict.dict.gz');
const XANAX_TWLIST_FIXTURE    = join(ROOT, 'fixtures', 'rewriter-xanax.twlist.sab.gz');
const XANAX_REWRITER_NATIVE   = join(ROOT, 'fixtures', 'xanax.rewriter.json.gz');

const TYPOS_PAIRS_PATH               = join(ROOT, 'fixture-src', 'rewriters', 'typos', 'pairs.tsv.gz');
const TYPOS_TWLIST_FIXTURE           = join(ROOT, 'fixtures', 'rewriter-typos.twlist.sab.gz');
const TYPOS_FORWARD_REWRITER_NATIVE  = join(ROOT, 'fixtures', 'typos-forward.rewriter.json.gz');
const TYPOS_REVERSE_REWRITER_NATIVE  = join(ROOT, 'fixtures', 'typos-reverse.rewriter.json.gz');

const BRITISH_PAIRS_PATH             = join(ROOT, 'fixture-src', 'rewriters', 'british', 'pairs.tsv.gz');
const BRITISH_TWLIST_FIXTURE         = join(ROOT, 'fixtures', 'rewriter-british.twlist.sab.gz');
const BRITISH_USUK_REWRITER_NATIVE   = join(ROOT, 'fixtures', 'british-us-uk.rewriter.json.gz');
const BRITISH_UKUS_REWRITER_NATIVE   = join(ROOT, 'fixtures', 'british-uk-us.rewriter.json.gz');

const VOICE_SOURCE_DIR               = join(ROOT, 'fixture-src', 'reformatters', 'voice');
const VOICE_FIXTURES_PREFIX          = join(ROOT, 'fixtures', 'reformatter-voice-');
// Voice modes that ship today. Each must have a matching
// fixture-src/reformatters/voice/<mode>.twlist.gz file. The runtime
// schema (byos.js REFORMATTER_MODES.voice) gates which modes a byos
// can request.
const SHIPPED_VOICE_MODES = [
  'pirate', 'valleygirl', 'surfer', 'flapper', 'cockney',
  'brooklynese', 'neutral', 'cat', 'dog',
];

const VOICE_REWRITER_SOURCE_DIR      = join(ROOT, 'fixture-src', 'rewriters', 'voice');
// Voice rewriter modes that ship today. Each must have a matching
// fixture-src/rewriters/voice/<mode>/pairs.tsv.gz file. Independent
// from SHIPPED_VOICE_MODES above: voice.rewriter and voice.reformatter
// are separate transforms with separate source files; a mode may ship
// on one side and not the other (byos.js REWRITER_MODES.voice gates).
const SHIPPED_VOICE_REWRITER_MODES = [
  'pirate', 'valleygirl', 'surfer', 'flapper', 'cockney',
  'brooklynese', 'neutral', 'cat', 'dog',
];

// ---- xanax apply-time lookup (NTRW native) -------------------------

// Walk the CMU dict, classify each word's first phoneme as
// vowel-onset or consonant-onset, and emit the universal NTRW shape:
//
//   Map<next-word, Set<correct-article>>
//
// Two flavors of entry land in the map:
//
//   - next-word's leading letter is in [aeiou] but its phonological
//     onset is consonant -> value set {"a"}. Examples: "united"
//     (Y-onset), "one" (W-onset), "European" (Y-onset).
//
//   - next-word's leading letter is NOT in [aeiou] but its
//     phonological onset is a vowel -> value set {"an"}. Almost all
//     such entries start with a silent h: "hour", "honest", "honor",
//     "heir".
//
// xanax's apply() reads this map keyed by the next word; a hit
// overrides the strict-orthographic fallback. "Do not truncate
// anything", the full set ships, ~689 entries combined.
function deriveXanaxExceptionMap(cmu) {
  const map = new Map();
  for (const [word, firstPh] of cmu) {
    if (!word) continue;
    const leading = word[0];
    const orthoSaysAn              = 'aeiou'.includes(leading);
    const phonologicallyVowelOnset = VOWEL_PHONEMES.has(firstPh);
    if (orthoSaysAn && !phonologicallyVowelOnset) {
      map.set(word, new Set(['a']));
    } else if (!orthoSaysAn && phonologicallyVowelOnset) {
      map.set(word, new Set(['an']));
    }
  }
  return map;
}

function buildXanaxLookupNative() {
  process.stderr.write('--- xanax rewriter lookup (NTRW native) ---\n');
  process.stderr.write(`  loading CMU dict from ${CMU_PATH}...\n`);
  const cmu = loadCmuMap(CMU_PATH);
  process.stderr.write(`  classified ${cmu.size.toLocaleString()} CMU entries\n`);
  const map = deriveXanaxExceptionMap(cmu);
  let aCount = 0, anCount = 0;
  for (const set of map.values()) {
    if (set.has('a'))  aCount++;
    if (set.has('an')) anCount++;
  }
  process.stderr.write(`  next-word -> {a}:   ${aCount} entries\n`);
  process.stderr.write(`  next-word -> {an}:  ${anCount} entries\n`);

  // Serialize as JSON object {key: [value, ...]}. Keys sorted for
  // deterministic native output; values are size-1 sets (single
  // article) so no sort needed inside.
  const obj = Object.create(null);
  for (const key of [...map.keys()].sort()) {
    obj[key] = [...map.get(key)];
  }
  const json     = JSON.stringify(obj);
  const gz       = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  writeFileSync(XANAX_REWRITER_NATIVE, gz);
  process.stderr.write(
    `  wrote ${XANAX_REWRITER_NATIVE.replace(ROOT + '/', '')} ` +
    `(${map.size} entries, ${gz.length.toLocaleString()} bytes gz native)\n`);
  process.stderr.write(
    `  packed into xanax.rewriter.sab.gz by 'sab.js pack rewriter' downstream\n`);
}

// ---- xanax unique twlist (NTEN SAB, packed directly) --------------

// Pack the two xanax singletons (xanax_a/a and xanax_an/an) into a
// standard NTEN twlist SAB so sortdct loads them through the same
// resource path as every other base-dict twlist source. Tiny enough
// that going through a native + sab pack would be silly; direct
// pack-and-save is fine.
async function buildXanaxTwlist() {
  process.stderr.write('--- xanax unique twlist (NTEN SAB) ---\n');
  const entries = [
    { type: XANAX_TYPE_A,  word: 'a'  },
    { type: XANAX_TYPE_AN, word: 'an' },
  ];
  const { sab } = packEntries(entries);
  await saveSABtoFile(sab, XANAX_TWLIST_FIXTURE);
  process.stderr.write(
    `  wrote ${XANAX_TWLIST_FIXTURE.replace(ROOT + '/', '')} ` +
    `(${entries.length} entries, ${sab.byteLength.toLocaleString()} bytes raw SAB)\n`);
}

// ---- typos rewriter (forward + reverse NTRW natives + shared twlist) ---

// Parse pairs.tsv.gz. Each line: <typo>\t<canonical>. Drops the
// handful of multi-word / hyphenated pairs (5 of 28,047 today) so the
// twlist stays single-token-safe under the lexer's WORD/PUNCT split.
function loadTyposPairs() {
  const raw = readFileSync(TYPOS_PAIRS_PATH);
  const text = gunzipSync(raw).toString('utf8');
  const pairs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [typo, canonical] = line.split('\t');
    if (!typo || !canonical) continue;
    if (/[\s-]/.test(typo) || /[\s-]/.test(canonical)) continue;
    pairs.push([typo.toLowerCase(), canonical.toLowerCase()]);
  }
  return pairs;
}

// Derive the three artifacts the runtime needs from the pair list:
//   - forward: Map<canonical, Set<typos>>   (introduce typos)
//   - reverse: Map<typo,      {canonical}>  (correct typos)
//   - words:   Set<string> covering every WORD that appears in either
//              side of any pair, the twlist's singleton vocabulary.
function deriveTyposMaps(pairs) {
  const forward = new Map();
  const reverse = new Map();
  const words   = new Set();
  for (const [typo, canonical] of pairs) {
    words.add(typo);
    words.add(canonical);
    if (!forward.has(canonical)) forward.set(canonical, new Set());
    forward.get(canonical).add(typo);
    // Reverse direction: a typo CAN collide on different canonicals
    // in the source (rare but possible). Keep a Set per typo and let
    // apply() pick uniformly when the source is ambiguous.
    if (!reverse.has(typo)) reverse.set(typo, new Set());
    reverse.get(typo).add(canonical);
  }
  return { forward, reverse, words };
}

function writeRewriterMapNative(map, path, label) {
  const obj = Object.create(null);
  for (const key of [...map.keys()].sort()) {
    obj[key] = [...map.get(key)].sort();
  }
  const json = JSON.stringify(obj);
  const gz   = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  writeFileSync(path, gz);
  process.stderr.write(
    `  wrote ${path.replace(ROOT + '/', '')} ` +
    `(${map.size.toLocaleString()} ${label}, ${gz.length.toLocaleString()} bytes gz native)\n`);
}

async function buildTypos() {
  process.stderr.write('--- typos rewriter (NTRW natives + shared twlist) ---\n');
  process.stderr.write(`  loading pairs from ${TYPOS_PAIRS_PATH.replace(ROOT + '/', '')}...\n`);
  const pairs = loadTyposPairs();
  process.stderr.write(`  loaded ${pairs.length.toLocaleString()} (typo, canonical) pairs\n`);

  const { forward, reverse, words } = deriveTyposMaps(pairs);

  // Two NTRW natives, one per mode. `sab.js pack rewriter`
  // (called downstream by build-all-fixtures.js) compiles each into
  // its canonical .sab.gz form, keyed by the id returned from the
  // rewriter enumerator in tools/sab.js.
  writeRewriterMapNative(forward, TYPOS_FORWARD_REWRITER_NATIVE, 'canonical keys');
  writeRewriterMapNative(reverse, TYPOS_REVERSE_REWRITER_NATIVE, 'typo keys');

  // Shared twlist: one singleton per unique word across the pair
  // universe. Type per word is `typos_w_<word>` (no two distinct
  // words share a type), so sortdct's source-set merge keeps every
  // word in its own singleton even when other twlist sources also
  // contribute the same word under different type names.
  const entries = [...words].sort().map(word => ({ type: `typos_w_${word}`, word }));
  const { sab } = packEntries(entries);
  await saveSABtoFile(sab, TYPOS_TWLIST_FIXTURE);
  process.stderr.write(
    `  wrote ${TYPOS_TWLIST_FIXTURE.replace(ROOT + '/', '')} ` +
    `(${entries.length.toLocaleString()} singletons, ${sab.byteLength.toLocaleString()} bytes raw SAB)\n`);
}

// ---- british rewriter (us-uk + uk-us NTRW natives + shared twlist) ---

// Parse pairs.tsv.gz. Each line: <source>\t<target>\t<direction>.
// The third column is the source-list tag (`american` rows live in
// DictAmerican: source=UK, target=US, used by uk-us Americanize;
// `british` rows live in DictBritish: source=US, target=UK, used by
// us-uk Britishize). Drops the rare multi-word / hyphenated rows so
// the twlist stays single-token-safe under the lexer's WORD/PUNCT
// split.
function loadBritishPairs() {
  const raw  = readFileSync(BRITISH_PAIRS_PATH);
  const text = gunzipSync(raw).toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [source, target, direction] = line.split('\t');
    if (!source || !target || !direction) continue;
    if (/[\s-]/.test(source) || /[\s-]/.test(target)) continue;
    if (direction !== 'american' && direction !== 'british') continue;
    rows.push([source.toLowerCase(), target.toLowerCase(), direction]);
  }
  return rows;
}

// Split rows into the two per-mode maps and collect the shared word
// universe for the twlist. `us-uk` (Britishize) consumes `british`-
// tagged rows; `uk-us` (Americanize) consumes `american`-tagged rows.
function deriveBritishMaps(rows) {
  const usuk  = new Map(); // source=US -> Set<UK>
  const ukus  = new Map(); // source=UK -> Set<US>
  const words = new Set();
  for (const [source, target, direction] of rows) {
    words.add(source);
    words.add(target);
    const map = direction === 'british' ? usuk : ukus;
    if (!map.has(source)) map.set(source, new Set());
    map.get(source).add(target);
  }
  return { usuk, ukus, words };
}

// ---- voice reformatter (per-mode singletons twlist + categories NTRW) ---

// Parse a per-mode voice source file. Each non-blank, non-`#` line is
// `<category>\t<word>` (or whitespace-separated). Returns
// { categoryWords: Map<category, string[]> } with insertion order
// preserved so the build is deterministic.
function loadVoiceSource(mode) {
  const path = join(VOICE_SOURCE_DIR, `${mode}.twlist.gz`);
  const raw  = readFileSync(path);
  const text = gunzipSync(raw).toString('utf8');
  const categoryWords = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // Tolerate any whitespace separator (tab or runs of spaces).
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const category = parts[0];
    const word     = parts.slice(1).join(' ').toLowerCase();
    if (!word) continue;
    if (/[\s]/.test(word)) continue;  // single-token-safe
    if (!categoryWords.has(category)) categoryWords.set(category, []);
    categoryWords.get(category).push(word);
  }
  return { mode, path, categoryWords };
}

async function buildVoice() {
  process.stderr.write('--- voice reformatter (per-mode twlist + categories NTRW) ---\n');
  for (const mode of SHIPPED_VOICE_MODES) {
    const { categoryWords, path } = loadVoiceSource(mode);
    let totalWords = 0;
    for (const ws of categoryWords.values()) totalWords += ws.length;
    process.stderr.write(
      `  ${mode}: loaded ${totalWords.toLocaleString()} words across ${categoryWords.size} categories ` +
      `(from ${path.replace(ROOT + '/', '')})\n`);

    // Singletons twlist. Each word becomes a 0-bit unique-type entry.
    // Type names embed mode + category + index so no two words share
    // a type (sortdct's source-set merge keeps every word singleton).
    // sortdct may hash the merged type name (the default for session
    // dicts), so the runtime can't look up the inserted slot by
    // pre-hash type name. Instead the categories fixture stores
    // WORDS, and the voice enhancer resolves word -> typeIndex via
    // the dict at enhance() time.
    const entries = [];
    const categoryToWords = new Map();
    for (const [category, words] of categoryWords) {
      const wordSet = new Set();
      words.forEach((word, idx) => {
        const type = `reformatter_voice_${mode}_${category}_${idx}`;
        entries.push({ type, word });
        wordSet.add(word);
      });
      categoryToWords.set(category, wordSet);
    }

    const twlistPath = `${VOICE_FIXTURES_PREFIX}${mode}.twlist.sab.gz`;
    const { sab } = packEntries(entries);
    await saveSABtoFile(sab, twlistPath);
    process.stderr.write(
      `  wrote ${twlistPath.replace(ROOT + '/', '')} ` +
      `(${entries.length.toLocaleString()} singletons, ${sab.byteLength.toLocaleString()} bytes raw SAB)\n`);

    // Categories NTRW native: Map<category, Set<word>>. Same shape
    // every rewriter native uses, so `sab pack rewriter` (called
    // downstream) packs it through the same code path. The id under
    // the rewriter category is `voice-<mode>-categories`.
    const categoriesPath = join(ROOT, 'fixtures', `voice-${mode}-categories.rewriter.json.gz`);
    writeRewriterMapNative(categoryToWords, categoriesPath, `${mode} categories`);
  }
}

async function buildBritish() {
  process.stderr.write('--- british rewriter (NTRW natives + shared twlist) ---\n');
  process.stderr.write(`  loading pairs from ${BRITISH_PAIRS_PATH.replace(ROOT + '/', '')}...\n`);
  const rows = loadBritishPairs();
  process.stderr.write(`  loaded ${rows.length.toLocaleString()} (source, target, direction) rows\n`);

  const { usuk, ukus, words } = deriveBritishMaps(rows);

  writeRewriterMapNative(usuk, BRITISH_USUK_REWRITER_NATIVE, 'us-uk (Britishize) source keys');
  writeRewriterMapNative(ukus, BRITISH_UKUS_REWRITER_NATIVE, 'uk-us (Americanize) source keys');

  const entries = [...words].sort().map(word => ({ type: `british_w_${word}`, word }));
  const { sab } = packEntries(entries);
  await saveSABtoFile(sab, BRITISH_TWLIST_FIXTURE);
  process.stderr.write(
    `  wrote ${BRITISH_TWLIST_FIXTURE.replace(ROOT + '/', '')} ` +
    `(${entries.length.toLocaleString()} singletons, ${sab.byteLength.toLocaleString()} bytes raw SAB)\n`);
}

// ---- voice rewriter (per-mode NTRW native + per-mode twlist) ---

// Parse a per-mode voice rewriter source file. Each non-blank, non-`#`
// line is `<canonical>\t<replacement>`. Multi-word and hyphenated
// rows drop (the twlist must stay single-token-safe). Both columns
// lowercased before insertion.
function loadVoicePairs(mode) {
  const path = join(VOICE_REWRITER_SOURCE_DIR, mode, 'pairs.tsv.gz');
  const raw  = readFileSync(path);
  const text = gunzipSync(raw).toString('utf8');
  const pairs = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const [canonical, replacement] = line.split('\t');
    if (!canonical || !replacement) continue;
    if (/[\s-]/.test(canonical) || /[\s-]/.test(replacement)) continue;
    pairs.push([canonical.toLowerCase(), replacement.toLowerCase()]);
  }
  return { mode, path, pairs };
}

// Derive Map<canonical, Set<replacement>> + the shared word universe
// for the twlist. Mirrors deriveTyposMaps / deriveBritishMaps.
function deriveVoiceRewriterMaps(pairs) {
  const map   = new Map();
  const words = new Set();
  for (const [canonical, replacement] of pairs) {
    words.add(canonical);
    words.add(replacement);
    if (!map.has(canonical)) map.set(canonical, new Set());
    map.get(canonical).add(replacement);
  }
  return { map, words };
}

async function buildVoiceRewriter() {
  process.stderr.write('--- voice rewriter (per-mode NTRW natives + shared twlist) ---\n');
  const sharedWords = new Set();
  for (const mode of SHIPPED_VOICE_REWRITER_MODES) {
    const { pairs, path } = loadVoicePairs(mode);
    process.stderr.write(
      `  ${mode}: loaded ${pairs.length} (canonical, replacement) pairs ` +
      `(from ${path.replace(ROOT + '/', '')})\n`);

    const { map, words } = deriveVoiceRewriterMaps(pairs);
    for (const w of words) sharedWords.add(w);

    // Per-mode NTRW native. `sab.js pack rewriter` compiles
    // voice-<mode>.rewriter.json.gz → voice-<mode>.rewriter.sab.gz
    // downstream (id registered in tools/sab.js enumerator).
    const ntrwPath = join(ROOT, 'fixtures', `voice-${mode}.rewriter.json.gz`);
    writeRewriterMapNative(map, ntrwPath, `${mode} canonical keys`);
  }

  // Shared twlist across all voice modes. One 0-bit singleton per
  // unique word across canonical ∪ replacement of every mode. Type
  // per word is `voice_w_<word>`, unique per word; sortdct's merge
  // keeps every word singleton even when the reformatter-voice-<mode>
  // twlist contributes the same word under a different type name.
  // Same shape as `rewriter-british.twlist.sab.gz`. The worker loader
  // in build-session-worker.js keys off `rewriter-<name>` so the
  // shared filename is non-negotiable.
  const entries = [...sharedWords].sort().map(word => ({ type: `voice_w_${word}`, word }));
  const twlistPath = join(ROOT, 'fixtures', `rewriter-voice.twlist.sab.gz`);
  const { sab } = packEntries(entries);
  await saveSABtoFile(sab, twlistPath);
  process.stderr.write(
    `  wrote ${twlistPath.replace(ROOT + '/', '')} ` +
    `(${entries.length} singletons across ${SHIPPED_VOICE_REWRITER_MODES.length} mode(s), ` +
    `${sab.byteLength.toLocaleString()} bytes raw SAB)\n`);
}

// ---- main ----------------------------------------------------------

async function main() {
  buildXanaxLookupNative();
  await buildXanaxTwlist();
  await buildTypos();
  await buildBritish();
  await buildVoice();
  await buildVoiceRewriter();
  process.stderr.write('\n--- done ---\n');
}

await main();
