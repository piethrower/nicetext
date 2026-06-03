// Shared stress-harness asset loading. All three stress callers (the
// browser stress-worker, the Node CLI run.mjs, and the Playwright
// suite-b probe) need the same dict-building inputs: the base TW-lists,
// the emoji CLDR keyword map, and the curated-keyword filter set. The
// fixtures ship as SAB natives (*.twlist.sab.gz, emoji16.emoji-cldr.sab.gz)
// so every load routes through the canonical resource loader and is
// unpacked with the same builder primitives the production session
// worker uses.
//
// loadResource is injected by the caller rather than imported here, so
// this module is realm-agnostic: the browser worker passes the
// resource-loader-client proxy, while the Node CLI and the page-side
// probe pass the main-thread loadResource directly. The unpack helpers
// are pure ESM and run in both node and the browser.

import { unpackEntries, wrapEntriesSAB } from '../../../js/src/builder/entries-sab.js';
import { unpackCldrMapFromSAB } from '../../../js/src/builder/cldr-map-pack.js';

// Load one twlist fixture as an entries array of { type, word }. The
// build-time packer already did the TSV parse, so the runtime cost is
// one fetch + gunzip + Uint32Array walk.
export async function loadTwlistEntries(loadResource, key) {
  const sab = await loadResource(key, 'twlist', { fixture: true });
  return unpackEntries(wrapEntriesSAB(sab));
}

// Load the full asset bundle the stress engine consumes:
//   { baseTwlists: { key: Array<{type, word}> },
//     cldr:        { emoji: [keyword, ...] } | null,
//     curatedKeywords: Set<string> | null }
// Shape matches what stress-engine.js's runStress / buildArtifacts-
// FromCorpus expect (assets.baseTwlists / assets.cldr /
// assets.curatedKeywords). The emoji-flood inputs (cldr +
// curatedKeywords) only load when opts.emoji is true; the Node CLI
// skips them when --emoji-flood is off, matching the prior behavior.
export async function loadStressAssets(loadResource, sources, opts = {}) {
  const { emoji = true } = opts;
  const baseTwlists = {};
  for (const s of sources) {
    baseTwlists[s] = await loadTwlistEntries(loadResource, s);
  }
  let cldr = null;
  let curatedKeywords = null;
  if (emoji) {
    // CLDR keyword map: unpack the emoji-cldr SAB (NTCM) to the same
    // { emoji: [keyword, ...] } object the old JSON form produced.
    const cldrSab = await loadResource('emoji16', 'emoji-cldr', { fixture: true });
    cldr = unpackCldrMapFromSAB(cldrSab);
    // Curated-keyword filter for Aug A/B/mix. Only the word column is
    // needed; collect it into a Set for membership checks.
    curatedKeywords = new Set();
    for (const e of await loadTwlistEntries(loadResource, 'emoji16-curated-keywords')) {
      curatedKeywords.add(e.word);
    }
  }
  return { baseTwlists, cldr, curatedKeywords };
}

// Render already-unpacked twlist entries back to TSV-shaped text and
// wrap them as a snip fixture ({ name, raw, inflated }). The snip
// corpus producer (snipCorpusFromFixtures) carves random byte ranges
// from its fixtures; before the SAB migration the twlist sources
// contributed their `.twlist.tsv.gz` text to that mix. Deriving the
// text from the loaded entries preserves that lexical diversity
// without a second fetch.
export function entriesToSnipFixture(name, entries) {
  let text = '';
  for (const e of entries) text += `${e.type}\t${e.word}\n`;
  const bytes = new TextEncoder().encode(text);
  return { name, raw: bytes, inflated: bytes };
}
