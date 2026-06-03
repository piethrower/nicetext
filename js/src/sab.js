// sab.js: native ↔ SAB compile layer for /fixtures.
//
// One pack function per resource category, in one module, dispatched
// by resourceCategory token. Used by:
//   - tools/sab.js CLI (batch native ↔ sab by category)
//   - js/src/resource-loader.js native-fallback path (when a SAB
//     fixture is absent and the loader has to compile native at
//     runtime)
//   - js/src/worker/build-session-worker.js (session-built dicts
//     and models registered into the resource cache with the
//     pageLifeSpan: id prefix)
//
// The seven categories enumerated in SAB_RESOURCE_CATEGORIES below
// each have pack + unpack wired via _registerCategory at module
// bottom. Adding a new category means: extend the enumeration,
// extend NATIVE_EXT + REGISTRY, ship a per-category pack module
// under js/src/builder/ (or js/src/eve/ for Eve-specific
// formats), register it.
//
// pack() enforces the u32 size guard: refuse to emit a SAB at or
// above 2^32 bytes. That cap is also the JS engine cap on
// SharedArrayBuffer; if a fixture ever trips it, we add a v2 format
// with u64 offsets, version-gated cleanly.
//
// Browser-safe ESM. node:fs / node:zlib are dynamic-imported only
// inside the file-IO helpers (saveSABtoFile / loadSABfromFile),
// which the browser never calls.

import { packDictToSAB, unpackDictFromSAB } from './builder/sab-pack.js';
import { packModelTableToSAB, unpackModelTableFromSAB } from './builder/modeltable-pack.js';
import { packFreqToSAB, unpackFreqFromSAB } from './builder/freq-pack.js';
import { packCldrMapToSAB, unpackCldrMapFromSAB } from './builder/cldr-map-pack.js';
import { packStrings, wrapPackedStrings } from './eve/packed-strings-sab.js';
import { packEntries, unpackEntries, wrapEntriesSAB } from './builder/entries-sab.js';
import { packMonotypedModel, wrapMonotypedModel } from './eve/monotyped-model-sab.js';
import { parseTwlistLines } from './builder/sources.js';
import { parseFreqLines } from './builder/frequencies.js';
import { packRewriterMap, unpackRewriterMap } from './builder/rewriter-sab.js';

const IS_NODE = typeof process !== 'undefined'
  && typeof process.versions === 'object'
  && typeof process.versions.node === 'string';

// The six resource categories this layer handles. The CLI validates
// its <category> argument against this list; loadResource passes the
// same tokens as `resourceCategory`; build-session-worker uses them
// for its `pageLifeSpan:` cache registrations.
//
// wlist and twlist are DISTINCT and NEVER aliases:
// - twlist: typed wordlist, entries-SAB (NTEN), (type, word) pairs.
//   Native .twlist.tsv.gz. BYOS reads this for codebook construction.
// - wlist: plain sorted-unique wordlist, packed-strings-SAB (NTPS).
//   Native .wlist.txt.gz (one word per line). Used by Eve (and
//   anywhere else that wants O(log n) word-membership over a fixed
//   word set). A wlist is FREQUENTLY a projection of a twlist or
//   corpus text, but the projection is a build-time step that
//   produces a real wlist fixture; the runtime category token names
//   the format on the wire, not the derivation that produced it.
//
// The plan originally listed seven categories; an `emoji-keywords`
// slot was scoped before the wlist promotion. After wlist became
// first-class, that slot was redundant, the curated-keywords
// fixture ships through wlist + twlist generically, and was
// retired in the emoji-cldr sub-commit.
export const SAB_RESOURCE_CATEGORIES = Object.freeze([
  'twlist',
  'wlist',
  'dict',
  'model',
  'freq',
  'emoji-cldr',
  'monotyped-model',
  'rewriter',
]);

// Native file extensions per resource category (the format the build
// tools emit into /fixtures as transient intermediates). Used by the
// CLI to locate native inputs and by loadResource's native-fallback
// path to find a sibling file when no .sab.gz exists.
export const NATIVE_EXT = Object.freeze({
  'twlist':         '.twlist.tsv.gz',
  'wlist':          '.wlist.txt.gz',
  'dict':           '.dict.json.gz',
  'model':          '.model.json.gz',
  'freq':           '.freq.tsv.gz',
  'emoji-cldr':     '.emoji-cldr.json.gz',
  // monotyped-model native form is the JSON array of ordered MM
  // strings (`["Cap|g|.", "..."]`). Builders consume corpus text
  // directly via genMonotypedModel(), but the sab.js pack/unpack
  // contract handles the (ordered-MM-list ↔ SAB) round-trip
  // symmetrically: same shape as every other category.
  'monotyped-model': '.monotyped-model.json.gz',
  // Cover-transforms rewriter apply-time lookup (NTRW). Native form
  // is JSON {key: [value, ...]}, parsed and packed via packRewriter
  // Map. Loaded by each rewriter module's setRewriterData() hook
  // when byos.rewriter.<name> > 0. See docs/cover-transforms.md
  // and js/src/builder/rewriter-sab.js.
  'rewriter':        '.rewriter.json.gz',
});

// Per-category packer/unpacker dispatch table. All seven categories
// are now wired; the null-initialized scaffold persists so a future
// eighth-category sub-commit follows the same pattern (init to null,
// _registerCategory wires it at module bottom).
const REGISTRY = {
  'twlist':          { pack: null, unpack: null },
  'wlist':           { pack: null, unpack: null },
  'dict':            { pack: null, unpack: null },
  'model':           { pack: null, unpack: null },
  'freq':            { pack: null, unpack: null },
  'emoji-cldr':      { pack: null, unpack: null },
  'monotyped-model': { pack: null, unpack: null },
  'rewriter':        { pack: null, unpack: null },
};

// 2^32. JS engines cap a single SharedArrayBuffer at or below this
// in practice; our u32 offset fields can't address beyond it. pack()
// refuses to emit a SAB whose byteLength meets or exceeds this.
export const SAB_SIZE_CEILING = 4_294_967_296;

// pack(native, resourceCategory) -> SharedArrayBuffer
//
// Dispatches by resourceCategory. Throws on unknown category, on
// unwired category, if the per-category packer returns a non-SAB,
// or if the produced SAB hits the u32 size ceiling.
//
// The parameter is named `resourceCategory` (not `type`) for the
// same reason the loader API was renamed: `type` in nicetext
// canonically means the per-word part-of-speech / categorization
// column in a twlist entry. Overloading it for "SAB resource
// category" is the bug class the loader-protocol fix (commit
// f88dd8f) eliminated; this module follows the same discipline.
export function pack(native, resourceCategory) {
  const entry = REGISTRY[resourceCategory];
  if (!entry) {
    throw new Error(
      `sab.pack: unknown resourceCategory "${resourceCategory}". ` +
      `Expected one of: ${SAB_RESOURCE_CATEGORIES.join(', ')}`,
    );
  }
  if (!entry.pack) {
    throw new Error(
      `sab.pack: not yet implemented for resourceCategory "${resourceCategory}" ` +
      `(scaffold only).`,
    );
  }
  const sab = entry.pack(native);
  if (!sab || typeof sab.byteLength !== 'number') {
    throw new Error(
      `sab.pack: packer for resourceCategory "${resourceCategory}" returned a non-SAB value.`,
    );
  }
  if (sab.byteLength >= SAB_SIZE_CEILING) {
    throw new Error(
      `sab.pack: produced SAB of ${sab.byteLength.toLocaleString()} bytes ` +
      `for resourceCategory "${resourceCategory}" meets or exceeds the u32 cap ` +
      `(${SAB_SIZE_CEILING.toLocaleString()}). Time to migrate this category ` +
      `to a v2 format with u64 offsets.`,
    );
  }
  return sab;
}

// unpack(sab, resourceCategory) -> native
//
// Inverse of pack(). Step 4 wires the per-category unpackers; until
// then every call throws cleanly.
export function unpack(sab, resourceCategory) {
  const entry = REGISTRY[resourceCategory];
  if (!entry) {
    throw new Error(
      `sab.unpack: unknown resourceCategory "${resourceCategory}". ` +
      `Expected one of: ${SAB_RESOURCE_CATEGORIES.join(', ')}`,
    );
  }
  if (!entry.unpack) {
    throw new Error(
      `sab.unpack: not yet implemented for resourceCategory "${resourceCategory}" ` +
      `(scaffold only).`,
    );
  }
  return entry.unpack(sab);
}

// Internal hook for step-4 commits to wire a category's pack/unpack
// without exposing REGISTRY. Each per-category commit imports and
// calls this from sab.js's bottom (or its own setup) to register
// its implementation. Keeps REGISTRY closed to ad-hoc mutation.
export function _registerCategory(resourceCategory, { pack, unpack } = {}) {
  const entry = REGISTRY[resourceCategory];
  if (!entry) {
    throw new Error(`sab._registerCategory: unknown resourceCategory "${resourceCategory}"`);
  }
  if (pack !== undefined) entry.pack = pack;
  if (unpack !== undefined) entry.unpack = unpack;
}

// saveSABtoFile(sab, path) -> Promise<void>
//
// Node-only. Gzips the SAB bytes at max compression and writes them
// to `path`. The browser never calls this; it routes SABs through
// the resource cache rather than the filesystem.
export async function saveSABtoFile(sab, path) {
  if (!IS_NODE) {
    throw new Error('sab.saveSABtoFile: node-only; not callable from the browser.');
  }
  const { writeFile } = await import('node:fs/promises');
  const { gzip, constants: zlibConstants } = await import('node:zlib');
  const { promisify } = await import('node:util');
  const gzipAsync = promisify(gzip);
  const bytes = Buffer.from(new Uint8Array(sab));
  const gzipped = await gzipAsync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION });
  await writeFile(path, gzipped);
}

// Per-category pack + unpack registrations. The native input to
// pack() is the gunzipped file *text* (UTF-8 string); each per-
// category packer handles its own decode of that text. unpack()
// returns the matching native-shape object (JSON for dict/model/
// emoji-cldr, entries array for twlist, sorted string array for
// wlist, {totalTokens, counts} for freq). See
// docs/architecture-sab.md for the per-category layout details.
_registerCategory('dict', {
  pack: (text) => packDictToSAB(JSON.parse(text)),
  unpack: (sab) => unpackDictFromSAB(sab),
});
_registerCategory('model', {
  pack: (text) => packModelTableToSAB(JSON.parse(text)),
  unpack: (sab) => unpackModelTableFromSAB(sab),
});
_registerCategory('twlist', {
  // Real twlist: (type, word) pairs, lowercased word side (twlist
  // sources are lowercase by invariant, see project memory rule
  // "dicts are lowercase"). Packs via entries-SAB (NTEN); BYOS,
  // aug pipeline, and any other consumer needing the type column
  // reads through wrapEntriesSAB + entrySpansAt/iterEntries.
  // Returns the .sab of the wrapped view so the result is a plain
  // SharedArrayBuffer at the loader's API surface.
  pack: (text) => packEntries(parseTwlistLines(text)).sab,
  unpack: (sab) => unpackEntries(wrapEntriesSAB(sab)),
});
_registerCategory('wlist', {
  // Plain wordlist: one word per line, blanks skipped. Output is
  // sorted-unique-lowercased packed-strings-SAB (NTPS) so the
  // wrapPackedStrings(sab).hasSorted(w) binary-search membership
  // path works regardless of input order. Pack is defensive: it
  // re-normalizes (lowercase + dedupe + sort) so a hand-written
  // native that ships out-of-order still produces a valid SAB.
  // The corresponding native builders (build-corpus-wlist,
  // build-twlist-wlist) emit canonical natives, so this re-normalize
  // is a no-op on the shipped pipeline.
  pack: (text) => {
    const set = new Set();
    for (const raw of text.split('\n')) {
      const w = raw.trim().toLowerCase();
      if (w.length > 0) set.add(w);
    }
    return packStrings([...set].sort(), { shared: true });
  },
  unpack: (sab) => {
    const view = wrapPackedStrings(sab);
    return [...view.iterate()];
  },
});
_registerCategory('freq', {
  // Word-frequency fixture: TSV body of `<word>\t<count>` lines.
  // parseFreqLines handles '#' comments and blank lines; the
  // returned {totalTokens, counts} feeds packFreqToSAB. Output is
  // the NTFQ format (see js/src/builder/freq-pack.js), sorted by
  // UTF-8 bytes so a future binary-search lookup is trivial. The
  // existing consumer (combineFrequencies) iterates the unpacked
  // Map and is order-insensitive.
  pack: (text) => packFreqToSAB(parseFreqLines(text)),
  unpack: (sab) => unpackFreqFromSAB(sab),
});
_registerCategory('emoji-cldr', {
  // Emoji → keyword-array map fixture. Native is a JSON object
  // `{emoji: [keyword, ...]}`; pack parses + emits the NTCM format
  // (see js/src/builder/cldr-map-pack.js) which the build-session
  // worker reads via loadResource(id, 'emoji-cldr') + unpack to
  // produce the same object shape the existing aug-impls-sab
  // consumer expects (cldr[emoji] dictionary access).
  pack: (text) => packCldrMapToSAB(JSON.parse(text)),
  unpack: (sab) => unpackCldrMapFromSAB(sab),
});
_registerCategory('monotyped-model', {
  // Per-corpus monotyped model fixture. Native is a JSON array of
  // ordered MM strings (same shape `genMonotypedModel` builds
  // internally before packing). pack parses + emits the NTMM format
  // (see js/src/eve/monotyped-model-sab.js) including the CMM pool
  // + per-unique-MM CMM index derived inside packMonotypedModel.
  // unpack iterates the MM ordered side to reconstruct the array.
  // tools/build-monotyped-models.js bypasses this layer because it
  // already holds the corpus text and goes corpus → SAB directly;
  // this wiring is the symmetric round-trip surface the sab.js
  // contract exposes to any other consumer.
  pack: (text) => packMonotypedModel(JSON.parse(text)),
  unpack: (sab) => [...wrapMonotypedModel(sab).iterateOrdered()],
});
_registerCategory('rewriter', {
  // Cover-transforms rewriter apply-time lookup. Native is JSON
  // `{key: [value, ...]}` matching the universal Map<string, Set<
  // string>> shape every rewriter consumes (xanax: word -> {article},
  // typos: canonical -> {variants}, british: US -> {UK}, voice:
  // canonical -> {variants}). pack parses + emits the NTRW format
  // (see js/src/builder/rewriter-sab.js). unpack returns a fully-
  // materialized Map<string, Set<string>> so the rewriter module's
  // apply() can do native Map.get + Set.has lookups.
  pack: (text) => packRewriterMap(JSON.parse(text)),
  unpack: (sab) => unpackRewriterMap(sab),
});

// loadSABfromFile(path) -> Promise<SharedArrayBuffer>
//
// Node-only. Reads `path`, gunzips, copies the bytes into a fresh
// SAB. Symmetric inverse of saveSABtoFile.
export async function loadSABfromFile(path) {
  if (!IS_NODE) {
    throw new Error('sab.loadSABfromFile: node-only; not callable from the browser.');
  }
  const { readFile } = await import('node:fs/promises');
  const { gunzip } = await import('node:zlib');
  const { promisify } = await import('node:util');
  const gunzipAsync = promisify(gunzip);
  const compressed = await readFile(path);
  const bytes = await gunzipAsync(compressed);
  const sab = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sab).set(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
  return sab;
}
