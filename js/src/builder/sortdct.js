// sortdct: TWLIST → MTWLIST.
// Port of OG-NiceText-C++/nicetext-1.0/gendict/src/sorttwl.cc semantics,
// with the whitespace-drop rule removed: phrases are first-class
// entries per docs/phrase-and-charset-spec.md, recognized by the
// lexer's phraseFuse pass and emitted as fused tokens by the encoder.
//
// Rules:
//   1. Lowercase all words.
//   2. If a word appears under multiple types, those types merge into one
//      alphabetically-sorted comma-joined type (e.g. "name_female,name_male").
//   3. Drop empty words.
//   4. Already-merged types in the input (with commas) are split and re-merged.
//   5. _UNIQUE_ tags are a fallback marker for words otherwise unclassified.
//      If a word also carries any non-_UNIQUE_ tag, all _UNIQUE_ tags for
//      that word are dropped before joining; the real classification wins.
//      A word that ONLY has _UNIQUE_ tags keeps them.
//
// Options:
//   opts.hashed  : when true, replace each emitted entry's merged-type
//                   string with a fixed-size hash (see typehash.js). The
//                   hash is content-derived and stable across runs.
//                   Downstream code is type-blind, so this is invisible
//                   to consumers (dct2mstr, sab-pack, genmodel, etc.).
//   opts.hashMap : optional Map<string, string>. When provided AND
//                   hashed is true, sortDict populates it with one
//                   entry per new hash: hash → joined-merged-string.
//                   Pass the same Map across multiple sortDict calls
//                   (e.g. the t0 pre-collapse + the final post-aug pass)
//                   to capture layered hashes, a layer-2 entry's value
//                   may contain layer-1 hashes as tokens; dehashDict
//                   resolves them recursively.
//
// Browser-safe ESM. No Node deps.

import { hashMergedType } from './typehash.js';
import { getRedactedSingles, redactTwlistEntries } from './redaction.js';

// sortDict is a twlist consumer per the redaction architecture, every
// consumer applies redactTwlistEntries to incoming entries (drop slur
// matches, prepend the marker singleton) using the loaded redacted
// singles set. Async because the singles load via loadResource.
export async function sortDict(twlist, opts = {}) {
  twlist = redactTwlistEntries(twlist, await getRedactedSingles());
  const hashed = !!opts.hashed;
  const hashMap = opts.hashMap instanceof Map ? opts.hashMap : null;
  const wordToTypes = new Map(); // lowercased word → Set<atomicType>

  for (const entry of twlist) {
    const word = (entry.word ?? '').toLowerCase();
    if (!word) continue;

    if (!wordToTypes.has(word)) wordToTypes.set(word, new Set());
    const set = wordToTypes.get(word);
    for (const part of (entry.type ?? '').split(',')) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }

  const out = [];
  for (const [word, types] of wordToTypes) {
    if (types.size === 0) continue;
    let effective = types;
    let hasNonUnique = false;
    let hasUnique = false;
    for (const t of types) {
      if (t.startsWith('_UNIQUE_')) hasUnique = true;
      else hasNonUnique = true;
    }
    if (hasUnique && hasNonUnique) {
      effective = new Set();
      for (const t of types) if (!t.startsWith('_UNIQUE_')) effective.add(t);
    }
    const merged = [...effective].sort().join(',');
    let typeOut = merged;
    if (hashed) {
      typeOut = hashMergedType(merged);
      if (hashMap && !hashMap.has(typeOut)) hashMap.set(typeOut, merged);
    }
    out.push({ type: typeOut, word });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
  });
  return out;
}

// sortDictAsync(twlist, opts), yielding variant for big inputs.
//
// Same semantics + return shape as sortDict; yields to the event
// loop in the two big pre-sort loops (build the word→types map +
// build the output entries with merged types). The native
// Array.prototype.sort that comes last can't yield mid-sort, it's
// one synchronous block, but it's typically a fraction of total
// time (the dedup-into-map and merge-types passes dominate on 4M+
// inputs). A 'sort-final' progress event fires before the sort so
// the modal at least labels what's running during that block.
//
//   opts.onProgress  (event) => void. Event shapes:
//     { phase: 'sort-build',   i, total }     during the dedup pass
//     { phase: 'sort-merge',   i, total }     during the merge pass
//     { phase: 'sort-final',   total }        immediately before sort
//     { phase: 'sort-end',     total }
//   opts.yieldEvery  items per yield (default 50,000)
//   opts.signal      optional AbortSignal
//   opts.hashed / opts.hashMap, same as sortDict.
export async function sortDictAsync(twlist, opts = {}) {
  twlist = redactTwlistEntries(twlist, await getRedactedSingles());
  const hashed = !!opts.hashed;
  const hashMap = opts.hashMap instanceof Map ? opts.hashMap : null;
  const onProgress = opts.onProgress ?? null;
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const wordToTypes = new Map();

  const inputLen = Array.isArray(twlist) ? twlist.length : 0;
  let i = 0;
  for (const entry of twlist) {
    i++;
    const word = (entry.word ?? '').toLowerCase();
    if (word) {
      if (!wordToTypes.has(word)) wordToTypes.set(word, new Set());
      const set = wordToTypes.get(word);
      for (const part of (entry.type ?? '').split(',')) {
        const t = part.trim();
        if (t) set.add(t);
      }
    }
    if ((i % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 'sort-build', i, total: inputLen });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const out = [];
  const mergeTotal = wordToTypes.size;
  let j = 0;
  for (const [word, types] of wordToTypes) {
    j++;
    if (types.size === 0) continue;
    let effective = types;
    let hasNonUnique = false;
    let hasUnique = false;
    for (const t of types) {
      if (t.startsWith('_UNIQUE_')) hasUnique = true;
      else hasNonUnique = true;
    }
    if (hasUnique && hasNonUnique) {
      effective = new Set();
      for (const t of types) if (!t.startsWith('_UNIQUE_')) effective.add(t);
    }
    const merged = [...effective].sort().join(',');
    let typeOut = merged;
    if (hashed) {
      typeOut = hashMergedType(merged);
      if (hashMap && !hashMap.has(typeOut)) hashMap.set(typeOut, merged);
    }
    out.push({ type: typeOut, word });
    if ((j % yieldEvery) === 0) {
      if (signal?.aborted) throw makeAbort();
      if (onProgress) onProgress({ phase: 'sort-merge', i: j, total: mergeTotal });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (onProgress) onProgress({ phase: 'sort-final', total: out.length });
  // Native sort can't yield mid-call, but we just announced 'sort-final'
  // so the modal can show "sorting N entries (final pass)" while it
  // runs. Typically the smallest of the three phases.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
  });
  if (onProgress) onProgress({ phase: 'sort-end', total: out.length });
  return out;
}

function makeAbort() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
