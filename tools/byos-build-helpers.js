// byos-build-helpers.js: shared Node helpers for byos.json-driven fixture
// builds. Used by tools/build-base-dict.js, tools/build-corpus-dict.js, and
// tools/build-model-table.js. Reads byos.json files, resolves source-name
// twlist fixtures, applies augmentations, and dispatches to the engine
// builders in js/src/builder/.

import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  validate as validateByos, generateBYOSID,
  getDictPath, getDictNativePath, getModelPath, getModelNativePath,
  getTwlistPath, getTwlistNativePath,
  getWlistPath, getWlistNativePath,
  getFreqPath, getFreqNativePath,
  getEmojiCldrPath, getEmojiCldrNativePath,
  getCardsPath, getTypehashPath,
} from '../js/src/byos.js';
import { parseTwlistLines } from '../js/src/builder/sources.js';
import { runAugsPacked } from '../js/src/builder/aug-pipeline.js';
import { sortDict } from '../js/src/builder/sortdct.js';
import { buildDictionary } from '../js/src/builder/dct2mstr.js';

// Cover-transforms rewriter chain (docs/cover-transforms.md). Same
// fixed-order chain as the encoder's runtime apply chain; each
// module's getRewriterUniqueTwlist() contributes 0-bit unique-type
// singleton entries to the dict when enabled via byos.rewriter.
import * as britishRw   from '../js/src/rewriter/british.js';
import * as typosRw     from '../js/src/rewriter/typos.js';
import * as xanaxRw     from '../js/src/rewriter/xanax.js';

const REWRITER_CHAIN = [
  ['british',   britishRw],
  ['typos',     typosRw],
  ['xanax',     xanaxRw],
];

// Collect 0-bit unique-type singleton entries from every rewriter
// the byos enables. Order matches the chain (british -> ... -> xanax)
// for deterministic build output; the entries are concat'd into the
// pre-aug twlist so sortdct's merge folds them into the per-word
// merged type strings.
function collectRewriterTwlist(rewriterFlags) {
  if (!rewriterFlags) return [];
  const out = [];
  for (const [name, mod] of REWRITER_CHAIN) {
    if (rewriterFlags[name] === true) {
      out.push(...mod.getRewriterUniqueTwlist());
    }
  }
  return out;
}

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve a path-helper output (e.g. "fixtures/X.dict.sab.gz") against
// the repo root. The path-helper outputs are repo-relative; this turns
// them into absolute filesystem paths for Node fs operations.
export function repoPath(relPath) {
  return join(ROOT, relPath);
}

// Convenience wrappers that accept a byos + cards array and return an
// absolute filesystem path. The byos-side single-source-of-truth lives
// in js/src/byos.js; these are just absolute-path adapters for Node.
// dictFsPath / modelFsPath return the canonical (SAB) fixture paths;
// build tools that write the *native* intermediate use the
// *NativeFsPath variants. `sab pack <type>` compiles native → SAB then
// deletes the native, so the native location is transient.
export function dictFsPath(byos, cards)        { return repoPath(getDictPath(byos, cards)); }
export function dictNativeFsPath(byos, cards)  { return repoPath(getDictNativePath(byos, cards)); }
export function modelFsPath(byos, cards)       { return repoPath(getModelPath(byos, cards)); }
export function modelNativeFsPath(byos, cards) { return repoPath(getModelNativePath(byos, cards)); }
export function twlistFsPath(name)           { return repoPath(getTwlistPath(name)); }
export function twlistNativeFsPath(name)     { return repoPath(getTwlistNativePath(name)); }
export function wlistFsPath(name)            { return repoPath(getWlistPath(name)); }
export function wlistNativeFsPath(name)      { return repoPath(getWlistNativePath(name)); }
export function freqFsPath(name)             { return repoPath(getFreqPath(name)); }
export function freqNativeFsPath(name)       { return repoPath(getFreqNativePath(name)); }
export function emojiCldrFsPath(name)        { return repoPath(getEmojiCldrPath(name)); }
export function emojiCldrNativeFsPath(name)  { return repoPath(getEmojiCldrNativePath(name)); }
export function cardsFsPath()               { return repoPath(getCardsPath()); }

export function typehashFsPath(byos, cards) { return repoPath(getTypehashPath(byos, cards)); }

// Read + parse a byos.json file. Validates strictly. Returns the byos object.
export function loadByosFile(byosPath) {
  const raw = readFileSync(byosPath, 'utf8');
  const byos = JSON.parse(raw);
  validateByos(byos);
  return byos;
}

// Build the cards array directly from tools/byos/*.byos.json source
// files. This is synchronous and self-contained so child build scripts
// (build-base-dict.js, build-corpus-dict.js, build-model-table.js) can
// resolve their canonical id via getBYOSID(byos, cards) without
// depending on the orchestrator having pre-emitted cards.data.js.
// The orchestrator uses the same array for its emit step.
export function loadCardsRegistry() {
  const byosDir = join(ROOT, 'tools', 'byos');
  const files = readdirSync(byosDir)
    .filter(f => f.endsWith('.byos.json'))
    .sort();
  const cards = [];
  for (const f of files) {
    const byos = JSON.parse(readFileSync(join(byosDir, f), 'utf8'));
    validateByos(byos);
    const { build, ...publicSpec } = byos;
    cards.push({ ...publicSpec, byosID: generateBYOSID(byos) });
  }
  return cards;
}

// Read fixtures/{name}.twlist.tsv.gz (the NATIVE intermediate) and
// return parsed [{type, word}, ...] entries. Source names map 1:1
// to fixture filenames per the byos schema.
//
// Reads the native rather than the runtime SAB (`.twlist.sab.gz`)
// because this helper runs during the build-all-fixtures window,
// when build-corpus-dict.js calls loadBaseTwlist, `sab pack twlist`
// hasn't run yet, so SABs don't exist. Natives are transient
// (deleted by sab pack twlist at the end of the pipeline); ad-hoc
// callers must rebuild them first via build-twlist-fixtures.js.
export function loadFixtureTwlist(name) {
  const buf = readFileSync(twlistNativeFsPath(name));
  const text = gunzipSync(buf).toString('utf8');
  return parseTwlistLines(text);
}

// Build the union TWLIST for a byos's base block: load each source from its
// fixture file, concat, apply augmentations the byos requests. Returns
// `{ entries, hashMap }`. `entries` is the array of { type, word } entries
// post-aug; `hashMap` is a Map<hash, mergedString> populated when
// byos.base.hashedMergedTypes is true (default), shared across the
// pre-collapse sortDict inside runAugsPacked AND the caller's final
// sortDict (passed back so the caller can extend the same map).
//
// Pure transform once the fixtures are loaded; safe to call from any
// byos-driven build path.
//
// Mirrors js/src/worker/build-session-worker.js so bake-time and runtime
// produce identical output for the same byos. Special handling:
//   - 'customtw': runtime-only flag; skip silently at bake time.
//   - 'emoji16-curated-keywords': filter input for emoji augmentation,
//     not a fold-in source. Skip from the union; loaded separately
//     below if any emoji aug is on.
// After the union, the selected augs run through the §18 fixed-point
// orchestrator (runAugsPacked). Emoji augs are gated on 'emoji16' being
// in the selected sources (no point augmenting when no emoji entries
// exist). Cross-aug duplicates are tolerated: sortDict downstream
// collapses them by word.
export async function loadBaseTwlist(byos) {
  if (!byos.base) {
    throw new Error(`byos-build: ${byos.name} has no base block; loadBaseTwlist requires one`);
  }
  let entries = [];
  for (const src of byos.base.sources) {
    if (src === 'customtw') continue;
    if (src === 'emoji16-curated-keywords') continue;
    const loaded = loadFixtureTwlist(src);
    process.stderr.write(`  ${src}: ${loaded.length} entries\n`);
    entries = entries.concat(loaded);
  }
  process.stderr.write(`  combined: ${entries.length} entries\n`);

  // Cover-transforms rewriter injection. Each enabled rewriter
  // contributes its 0-bit unique-type singleton entries to the
  // pre-aug twlist; sortdct's merge folds the new type strings into
  // each word's merged type. No-op when byos.rewriter is absent or
  // every rewriter is false (the legacy default).
  const rewriterEntries = collectRewriterTwlist(byos.rewriter);
  if (rewriterEntries.length > 0) {
    process.stderr.write(`  cover-transforms rewriters: +${rewriterEntries.length} singleton entries\n`);
    entries = entries.concat(rewriterEntries);
  }

  const aug = byos.base.augment || {};
  const haveEmoji16 = byos.base.sources.includes('emoji16');
  const augA = aug.emojiIntoWords && aug.emojiIntoWords.enabled === true ? aug.emojiIntoWords : null;
  const augB = aug.wordsIntoEmoji && aug.wordsIntoEmoji.enabled === true ? aug.wordsIntoEmoji : null;
  const wantsEmojiAug = (augA || augB) && haveEmoji16;
  const eiwMix = augA && Number.isInteger(augA.intensity) ? Math.max(0, augA.intensity) : 0;
  const wieMix = augB && Number.isInteger(augB.intensity) ? Math.max(0, augB.intensity) : 0;
  const selectedAugs = [];
  if (wantsEmojiAug) {
    if (augA) selectedAugs.push('eiw');
    if (augB) selectedAugs.push('wie');
  }
  // Hashed merged types default ON per byos schema (see js/src/byos.js).
  // hashMap is allocated only when both flags align: hashing on AND
  // generateHashmap on. Otherwise pass null and skip the bookkeeping.
  const hashed = byos.base.hashedMergedTypes !== false;
  const wantHashmap = hashed && byos.base.generateHashmap === true;
  const hashMap = wantHashmap ? new Map() : null;

  if (selectedAugs.length === 0) {
    // No augs: still pre-collapse via runAugsPacked? No, runAugsPacked
    // short-circuits for empty selectedAugs. Apply sortDict here directly
    // so the caller gets the same hashed/non-hashed shape.
    entries = await sortDict(entries, { hashed, hashMap });
    return { entries, hashMap };
  }

  let cldr = null;
  let curatedKeywords = null;
  if (wantsEmojiAug) {
    process.stderr.write('  loading emoji CLDR keywords...\n');
    const cldrBuf = readFileSync(emojiCldrNativeFsPath('emoji16'));
    cldr = JSON.parse(gunzipSync(cldrBuf).toString('utf8'));
    if (byos.base.sources.includes('emoji16-curated-keywords')) {
      process.stderr.write('  loading curated-keyword filter...\n');
      const curBuf = readFileSync(twlistNativeFsPath('emoji16-curated-keywords'));
      const curText = gunzipSync(curBuf).toString('utf8');
      const cur = parseTwlistLines(curText);
      curatedKeywords = new Set(cur.map(e => e.word));
    }
  }
  const mixDescr = (eiwMix > 0 || wieMix > 0) ? `, mix=eiw:${eiwMix}/wie:${wieMix}` : '';
  const hashDescr = hashed ? (wantHashmap ? ', hashed+map' : ', hashed') : ', raw-types';
  process.stderr.write(`  running augs (${selectedAugs.join(', ')}${mixDescr}${hashDescr})...\n`);
  entries = await runAugsPacked(entries, selectedAugs, {
    cldr,
    curatedKeywords,
    eiwMix,
    wieMix,
    useWorkers: false,
    hashed,
    hashMap,
    onProgress: ({ phase, iter, total }) => {
      if (phase === 'aug-iter') {
        process.stderr.write(`    iter ${iter}: ${total} new entries\n`);
      }
    },
  });
  process.stderr.write(`  after augs: ${entries.length} entries (pre-sortDict; cross-aug dups OK)\n`);
  return { entries, hashMap };
}

// Build a base dictionary from a byos with a base block (story.style typically
// 'flat'). Used for master, mit, and any future base-only fixture. Returns
// `{ dict, hashMap }`. hashMap is a Map<hash, mergedString> when
// byos.base.generateHashmap is true (with hashedMergedTypes also true);
// null otherwise. Caller decides whether to persist hashMap to fixtures.
export async function buildBaseDict(byos) {
  const { entries, hashMap } = await loadBaseTwlist(byos);
  const hashed = byos.base.hashedMergedTypes !== false;
  process.stderr.write('  sortdct...\n');
  const mtwlist = await sortDict(entries, { hashed, hashMap });
  process.stderr.write(`  mtwlist: ${mtwlist.length} unique words\n`);
  // Phase 1: byos.base.frequencies is informational metadata only; the
  // engine layer's frequencies opt expects a Map<word, count>, which
  // base-dict builds don't have (no corpus). Pass null (= unweighted)
  // until Phase 2 wires up loading the named freq fixtures and combining.
  process.stderr.write('  dct2mstr...\n');
  const dict = buildDictionary(mtwlist, {
    name: byos.name,
    frequencies: null,
    tieBreak: byos.base.tieBreak,
  });
  return { dict, hashMap };
}

// Quick stats line for stderr after a dict is built.
export function reportDictStats(dict, label) {
  const totalTypes = dict.types.length;
  const encodingTypes = new Set(
    dict.words.filter(w => w.bits > 0).map(w => w.typeIndex)
  ).size;
  const totalBits = dict.words.reduce((s, w) => s + w.bits, 0);
  const avgBitsPerWord = totalBits / Math.max(1, dict.words.length);
  const maxBits = dict.words.reduce((m, w) => Math.max(m, w.bits), 0);
  process.stderr.write(
    `\n${label}\n` +
    `  ${totalTypes} types (${encodingTypes} carry bits)\n` +
    `  ${dict.words.length} words\n` +
    `  ${avgBitsPerWord.toFixed(2)} avg bits/word, ${maxBits} max\n`
  );
}
