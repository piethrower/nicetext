#!/usr/bin/env node
// build-base-dict.js: byos.json-driven base-dictionary builder.
// Replaces the per-fixture build-master-dict.js / build-mit-dict.js scripts:
// any byos.json with story.style='flat' (i.e., no story layer, only a base
// block) lands here. The output filename comes from byos.name; the source
// list, augmentations, and tieBreak come from the byos's base block.
//
// Usage:  node tools/build-base-dict.js <byos.json>

import { writeFileSync } from 'node:fs';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { basename } from 'node:path';

import {
  loadByosFile, loadCardsRegistry, buildBaseDict, reportDictStats,
  dictNativeFsPath, typehashFsPath, ROOT,
} from './byos-build-helpers.js';

async function main() {
  const byosPath = process.argv[2];
  if (!byosPath) {
    process.stderr.write('usage: build-base-dict.js <byos.json>\n');
    process.exit(2);
  }
  process.stderr.write(`reading byos: ${byosPath}\n`);
  const byos = loadByosFile(byosPath);

  if (!byos.base) {
    throw new Error(`build-base-dict: ${basename(byosPath)} has no base block`);
  }
  if (byos.story && byos.story.style !== 'flat') {
    throw new Error(
      `build-base-dict: ${basename(byosPath)} has story.style='${byos.story.style}'; ` +
      `base-dict builder only handles flat-story byos. Use build-corpus-dict.js for corpus dicts.`
    );
  }

  process.stderr.write('reading sources...\n');
  const { dict, hashMap } = await buildBaseDict(byos);

  // Output filename is composed via the central path helper so the
  // canonical-id rule (rev-suffixed nickname when card matches, long
  // form otherwise) is honored in one place.
  const cards = loadCardsRegistry();
  const out = dictNativeFsPath(byos, cards);
  writeFileSync(out, gzipSync(JSON.stringify(dict), { level: zlibConstants.Z_BEST_COMPRESSION }));
  reportDictStats(dict, `built ${out.replace(ROOT + '/', '')}`);

  // Persist the typehash map sibling fixture when the byos requested it.
  // hashMap is non-null only when byos.base.generateHashmap is true (and
  // hashedMergedTypes is on, which is the default).
  if (hashMap) {
    const tpath = typehashFsPath(byos, cards);
    const obj = Object.fromEntries(hashMap);
    writeFileSync(tpath, gzipSync(JSON.stringify(obj), { level: zlibConstants.Z_BEST_COMPRESSION }));
    process.stderr.write(`built ${tpath.replace(ROOT + '/', '')} (${hashMap.size} entries)\n`);
  }
}

// loadResource (called transitively via sortDict → getRedactedSingles)
// uses a worker_threads pool that keeps the event loop open after work
// completes. Same pattern as js/bin/nicetext.js, explicit exit so the
// CLI returns promptly.
await main();
process.exit(0);
