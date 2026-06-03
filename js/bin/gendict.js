#!/usr/bin/env node
// gendict: build JSON dictionaries from corpora.
//
// Subcommands:
//   listword [--counts] <text-file>
//   txt2dct <type=file> [<type=file>...]
//   sortdct <twlist-file>
//   dct2mstr [--name=NAME] <mtwlist-file>
//   build --name=NAME --out=FILE <type=file> [<type=file>...]
//
// TWLIST/MTWLIST text format: one entry per line, `<type>\t<word>`.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Tolerate downstream pipe closure (e.g. `... | head`).
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });

import { listWords, listWordsWithCounts } from '../src/builder/listword.js';
import { parseWordList, txtToTwlist } from '../src/builder/txt2dct.js';
import { parseTwlistLines } from '../src/builder/sources.js';
import { sortDict } from '../src/builder/sortdct.js';
import { buildDictionary } from '../src/builder/dct2mstr.js';
import { loadResource } from '../src/worker/jobs.js';

// All file reads route through the shared resource-loader (single
// path for browser and CLI). The loader returns a SAB of gunzipped
// bytes; decode locally here. .gz inputs are transparently
// decompressed by the resource-worker.
async function readTextFile(path) {
  const sab = await loadResource(pathToFileURL(path), 'raw-bytes');
  const view = new Uint8Array(sab);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new TextDecoder('utf-8').decode(copy);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v = true] = a.slice(2).split('=');
      flags[k] = v;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function parseTypePairs(positional) {
  const pairs = [];
  for (const arg of positional) {
    const idx = arg.indexOf('=');
    if (idx === -1) throw new Error(`expected <type>=<file>, got: ${arg}`);
    pairs.push({ typeName: arg.slice(0, idx), file: arg.slice(idx + 1) });
  }
  return pairs;
}

function entriesToText(entries) {
  return entries.map(e => `${e.type}\t${e.word}`).join('\n') + '\n';
}

async function loadTypeFiles(pairs) {
  const out = [];
  for (const { typeName, file } of pairs) {
    const text = await readTextFile(file);
    out.push({ typeName, words: parseWordList(text) });
  }
  return out;
}

function usage() {
  process.stderr.write(`usage: gendict <command> [args]

  listword [--counts] <text-file>
  txt2dct <type=file> [<type=file>...]
  sortdct <twlist-file>
  dct2mstr [--name=NAME] <mtwlist-file>
  build --name=NAME --out=FILE <type=file> [<type=file>...]
`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  switch (cmd) {
    case 'listword': {
      if (positional.length !== 1) { usage(); process.exit(2); }
      const text = await readTextFile(positional[0]);
      if (flags.counts) {
        const counts = await listWordsWithCounts(text);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [w, c] of sorted) process.stdout.write(`${c}\t${w}\n`);
      } else {
        for (const w of await listWords(text)) process.stdout.write(`${w}\n`);
      }
      return;
    }

    case 'txt2dct': {
      if (positional.length === 0) { usage(); process.exit(2); }
      const pairs = parseTypePairs(positional);
      const inputs = await loadTypeFiles(pairs);
      const twlist = txtToTwlist(inputs);
      process.stdout.write(entriesToText(twlist));
      return;
    }

    case 'sortdct': {
      if (positional.length !== 1) { usage(); process.exit(2); }
      const text = await readTextFile(positional[0]);
      const mtwlist = await sortDict(parseTwlistLines(text));
      process.stdout.write(entriesToText(mtwlist));
      return;
    }

    case 'dct2mstr': {
      if (positional.length !== 1) { usage(); process.exit(2); }
      const text = await readTextFile(positional[0]);
      const dict = buildDictionary(parseTwlistLines(text), { name: flags.name ?? 'unnamed' });
      process.stdout.write(JSON.stringify(dict, null, 2) + '\n');
      return;
    }

    case 'build': {
      if (!flags.out) { process.stderr.write('build requires --out=FILE\n'); process.exit(2); }
      if (positional.length === 0) { usage(); process.exit(2); }
      const pairs = parseTypePairs(positional);
      const inputs = await loadTypeFiles(pairs);
      const twlist = txtToTwlist(inputs);
      const mtwlist = await sortDict(twlist);
      const dict = buildDictionary(mtwlist, { name: flags.name ?? 'unnamed' });
      writeFileSync(flags.out, JSON.stringify(dict, null, 2) + '\n');
      const totalWords = dict.words.length;
      const totalTypes = dict.types.length;
      const encodingTypes = new Set(dict.words.filter(w => w.bits > 0).map(w => w.typeIndex)).size;
      const maxBits = dict.words.reduce((m, w) => Math.max(m, w.bits), 0);
      process.stderr.write(`built ${flags.out}: ${totalTypes} types (${encodingTypes} carry bits), ${totalWords} words, max ${maxBits} bits\n`);
      return;
    }

    default:
      usage();
      process.exit(cmd ? 1 : 2);
  }
}

main(process.argv.slice(2)).then(
  // The shared loader's worker_threads pool holds the event loop
  // open after work completes; exit explicitly.
  () => process.exit(0),
  (err) => { process.stderr.write(`${err.stack || err.message || err}\n`); process.exit(1); },
);
