#!/usr/bin/env node
// tools/sab.js: CLI for native ↔ SAB conversion of /fixtures.
//
// Usage:
//   node tools/sab.js pack <type>     # native → /fixtures/<id>.<type>.sab.gz
//   node tools/sab.js unpack <type>   # /fixtures/<id>.<type>.sab.gz → native
//
// <type> is one of: twlist, dict, model, freq, emoji-cldr, emoji-keywords.

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SAB_RESOURCE_CATEGORIES, NATIVE_EXT, pack, unpack, saveSABtoFile, loadSABfromFile,
} from '../js/src/sab.js';
import { getBYOSID } from '../js/src/byos.js';
import cardsRegistry from '../fixtures/cards.data.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(ROOT, 'fixtures');

function usage() {
  process.stderr.write(
    'usage: node tools/sab.js [pack|unpack] <resourceCategory>\n' +
    `categories:  ${SAB_RESOURCE_CATEGORIES.join(', ')}\n`,
  );
}

// Enumerate the fixture ids of `type`. Each id, combined with the
// type's NATIVE_EXT, names the on-disk native intermediate
// (<id><NATIVE_EXT[type]>) and, with the SAB extension
// (<id>.<type>.sab.gz), the SAB fixture.
function enumerateIds(type) {
  switch (type) {
    case 'dict':
    case 'model': {
      // The id for path composition is getBYOSID(card, cardsRegistry),
      // which resolves to the short nickname-rev form ('aesop-1')
      // when the card matches a known registry entry. The .byosID
      // field on cards is the LONG form; not what fixture filenames
      // use. Model fixtures exist only for non-flat cards; flat
      // cards have dict only.
      const cards = type === 'model'
        ? cardsRegistry.filter((c) => c.story && c.story.style !== 'flat')
        : cardsRegistry;
      return cards.map((c) => getBYOSID(c, cardsRegistry));
    }
    case 'twlist': {
      // twlist ids = the registry `key` values from
      // fixtures/twlist-sources.meta.json. Same source-of-truth
      // build-twlist-wlist.js reads, keeps the two pipelines in
      // lockstep and handles non-canonical filenames (e.g.
      // key='emoji16-curated-keywords' →
      // filename='emoji16.curated-keywords.tsv.gz').
      const meta = JSON.parse(
        readFileSync(join(FIXTURES, 'twlist-sources.meta.json'), 'utf8'),
      );
      const sources = meta.sources || meta;
      return sources.map((s) => s.key).sort();
    }
    case 'freq': {
      // The three shipped freq resource sources match the runtime
      // FREQ_FIXTURE_FILES map in build-session-worker.js (norvig,
      // google, gutenberg). Hard-coded here because there is no
      // on-disk registry for freq the way there is for twlist;
      // the source set is closed and small.
      return ['google', 'gutenberg', 'norvig'];
    }
    case 'emoji-cldr': {
      // One shipped emoji-cldr fixture today: emoji16. Same closed-
      // set rationale as freq. Add ids here if a future arc ships
      // a non-emoji-16 cldr variant (e.g., emoji-17).
      return ['emoji16'];
    }
    case 'rewriter': {
      // Closed set, each cover-transform's data arc adds its id
      // here as its lookup fixture lands. The `typos-*` / `british-*`
      // entries are per-mode rewriter NTRW fixtures; the `voice-*-
      // categories` entries are per-mode reformatter NTRW fixtures
      // (category -> [unique-typenames]). Singleton twlists for both
      // ride through the `twlist` enumerator.
      return [
        'xanax',
        'typos-forward', 'typos-reverse',
        'british-us-uk', 'british-uk-us',
        'voice-pirate-categories', 'voice-valleygirl-categories',
        'voice-surfer-categories', 'voice-flapper-categories',
        'voice-cockney-categories', 'voice-brooklynese-categories',
        'voice-neutral-categories', 'voice-cat-categories',
        'voice-dog-categories',
        'voice-pirate', 'voice-valleygirl', 'voice-surfer',
        'voice-flapper', 'voice-cockney', 'voice-brooklynese',
        'voice-neutral', 'voice-cat', 'voice-dog',
      ];
    }
    case 'wlist': {
      // wlist ids are filename stems. Two production paths produce
      // .wlist.txt.gz natives into /fixtures:
      //   - tools/build-corpus-wlist.js  (one per unique corpus stem)
      //   - tools/build-twlist-wlist.js  (one per twlist source name)
      // Both paths drop their natives into /fixtures, so we enumerate
      // by scanning *.wlist.txt.gz on disk rather than re-running the
      // projections. Stems and twlist-source names share a flat
      // namespace under /fixtures by convention; no collision today.
      const ids = [];
      for (const f of readdirSync(FIXTURES)) {
        if (f.endsWith('.wlist.txt.gz')) {
          ids.push(f.slice(0, -'.wlist.txt.gz'.length));
        }
      }
      return ids.sort();
    }
    default:
      throw new Error(
        `sab: enumerator for type "${type}" not yet implemented (scaffold only).`,
      );
  }
}

async function doPack(type) {
  const ids = enumerateIds(type);
  const nativeExt = NATIVE_EXT[type];
  let okCount = 0;
  let skipCount = 0;
  for (const id of ids) {
    const nativePath = join(FIXTURES, `${id}${nativeExt}`);
    const sabPath    = join(FIXTURES, `${id}.${type}.sab.gz`);
    if (!existsSync(nativePath)) {
      process.stderr.write(`  skip ${id} (no native at ${nativePath})\n`);
      skipCount++;
      continue;
    }
    process.stderr.write(`  packing ${id}\n`);
    const compressed = readFileSync(nativePath);
    const text = gunzipSync(compressed).toString('utf8');
    const sab = pack(text, type);
    await saveSABtoFile(sab, sabPath);
    unlinkSync(nativePath);
    process.stderr.write(
      `    wrote ${sabPath.replace(ROOT + '/', '')} ` +
      `(${sab.byteLength.toLocaleString()} bytes), deleted native\n`,
    );
    okCount++;
  }
  process.stderr.write(`pack ${type}: ${okCount} packed, ${skipCount} skipped\n`);
}

async function doUnpack(type) {
  // unpack invokes js/src/sab.js / unpack(sab, type), which throws
  // 'not yet implemented' for every type in this commit. Surfaced
  // here so the CLI fails cleanly rather than appearing to succeed.
  unpack(new SharedArrayBuffer(0), type);
}

async function main(argv) {
  const [subcommand, type] = argv;
  if (!subcommand || !type) {
    usage();
    process.exit(2);
  }
  if (subcommand !== 'pack' && subcommand !== 'unpack') {
    process.stderr.write(`sab: unknown subcommand "${subcommand}"\n`);
    usage();
    process.exit(2);
  }
  if (!SAB_RESOURCE_CATEGORIES.includes(type)) {
    process.stderr.write(`sab: unknown resourceCategory "${type}"\n`);
    usage();
    process.exit(2);
  }
  try {
    if (subcommand === 'pack')   await doPack(type);
    else                          await doUnpack(type);
  } catch (e) {
    process.stderr.write(`sab: ${e.message}\n`);
    process.exit(1);
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`sab: ${e.stack || e.message || e}\n`);
  process.exit(1);
});
