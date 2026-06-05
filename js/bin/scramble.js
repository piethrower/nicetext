#!/usr/bin/env node
// scramble : recover: cover text → original bytes. Streaming I/O.

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { wrapDictionaryFromSAB } from '../src/dictionary.js';
import { decode } from '../src/decode.js';
import { loadResource } from '../src/worker/jobs.js';

process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else { flags[a.slice(2)] = argv[++i]; }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = argv[++i];
    }
  }
  return flags;
}

function usage() {
  process.stderr.write(`usage: scramble -d <dict> -i <input.txt> -o <output.bin>

  -d, --dict   path to dictionary file (must match the one used by nicetext)
  -i, --in     path to cover text input
  -o, --out    path to output file (raw bytes)
`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dictPath = flags.d ?? flags.dict;
  const inPath = flags.i ?? flags.in;
  const outPath = flags.o ?? flags.out;
  if (!dictPath || !inPath || !outPath) { usage(); process.exit(2); }

  // Route the dict load through the shared resource-loader (single
  // path for browser and CLI; .gz handled transparently).
  const dictSab = await loadResource(pathToFileURL(dictPath), 'dict');
  const dict = wrapDictionaryFromSAB(dictSab);
  const inputStream = Readable.toWeb(createReadStream(inPath));
  const outputStream = Writable.toWeb(createWriteStream(outPath));
  await decode(inputStream, outputStream, dict);
}

main().then(
  // The shared loader's worker_threads pool holds the event loop
  // open after work completes; exit explicitly.
  () => process.exit(0),
  (err) => { process.stderr.write(`${err.stack || err.message || err}\n`); process.exit(1); },
);
