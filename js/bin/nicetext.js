#!/usr/bin/env node
// nicetext : embed: bits → cover text. Streaming I/O.

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { wrapDictionaryFromSAB } from '../src/dictionary.js';
import { weightedTypeStream } from '../src/typestream.js';
import { encode } from '../src/encode.js';
import { mulberry32 } from '../src/random.js';
import { wrapGrammarFromSAB, modelStream } from '../src/grammar/expand.js';
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
  process.stderr.write(`usage: nicetext -d <dict.json> -i <input> [-g <grammar.def>] [-o <output>] [--seed=N] [--stream-seed=N] [--max-length=N] [--no-validate]

  -d, --dict     dictionary JSON (built by gendict)
  -i, --in       input file (any binary)
  -g, --grammar  CFG grammar file (.def). Without -g, falls back to a weighted random type stream.
  -o, --out      output file (default: stdout)
      --seed         PRNG seed for SIZER's random tail (default 0xC0FFEE)
      --stream-seed  PRNG seed for grammar/type stream (default 0xBEEF)
      --max-length   Skip & retry models longer than this (default 1024)
      --no-validate  Skip the round-trip self-check (default: validate on).
                     Validation runs the cover through a concurrent decoder
                     and aborts if the recovered bytes don't fingerprint-
                     match the source. Disable only for benchmarks.
`);
}

// Wrap a Node writable as a Web WritableStream<Uint8Array>. Plain
// process.stdout deserves a hand-rolled wrapper since Writable.toWeb
// has TTY edge cases; everything else goes through the standard
// conversion.
function nodeWritableToWeb(nodeWritable) {
  if (nodeWritable === process.stdout || nodeWritable === process.stderr) {
    return new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          nodeWritable.write(chunk, (err) => err ? reject(err) : resolve());
        });
      },
    });
  }
  return Writable.toWeb(nodeWritable);
}

async function main() {
  // Bare boolean flags must be peeled out before parseFlags, which
  // assumes every long flag takes a value.
  const rawArgv = process.argv.slice(2);
  const noValidate = rawArgv.includes('--no-validate');
  const flags = parseFlags(rawArgv.filter((a) => a !== '--no-validate'));
  const dictPath = flags.d ?? flags.dict;
  const inPath = flags.i ?? flags.in;
  const outPath = flags.o ?? flags.out;
  const grammarPath = flags.g ?? flags.grammar;
  if (!dictPath || !inPath) { usage(); process.exit(2); }

  // All resource loads route through the shared loader (single path
  // for browser and CLI). The loader's resource-worker handles .gz
  // transparently and packs straight to a SAB, so this CLI now
  // accepts both `dict.json` and `dict.json.gz`.
  const dictSab = await loadResource(pathToFileURL(dictPath), 'dict');
  const dict = wrapDictionaryFromSAB(dictSab);
  const seed = Number(flags.seed ?? 0xC0FFEE);
  const streamSeed = Number(flags['stream-seed'] ?? 0xBEEF);
  const maxLength = Number(flags['max-length'] ?? 1024);

  const inputStream = Readable.toWeb(createReadStream(inPath));
  const outNode = outPath ? createWriteStream(outPath) : process.stdout;
  const finalOutput = nodeWritableToWeb(outNode);

  // Flat (no model/grammar) is historically newline-terminated;
  // grammar/model-table covers already end with '\n'. In streaming
  // mode we splice a transform that emits the trailing newline on
  // flush.
  let outputStream = finalOutput;
  if (!grammarPath) {
    const tx = new TransformStream({
      transform(chunk, c) { c.enqueue(chunk); },
      flush(c) { c.enqueue(new TextEncoder().encode('\n')); },
    });
    tx.readable.pipeTo(finalOutput).catch(() => {});
    outputStream = tx.writable;
  }

  let encodeOpts;
  if (grammarPath) {
    const grammarSab = await loadResource(pathToFileURL(grammarPath), 'grammar');
    const grammar = wrapGrammarFromSAB(grammarSab);
    const stream = modelStream(grammar, { random: mulberry32(streamSeed), maxLength, dict });
    encodeOpts = { modelStream: stream, randomSeed: seed };
  } else {
    const stream = weightedTypeStream(dict, { random: mulberry32(streamSeed) });
    encodeOpts = { typeStream: stream, randomSeed: seed };
  }
  if (noValidate) encodeOpts.validate = false;
  await encode(inputStream, outputStream, dict, encodeOpts);
}

main().then(
  // The shared loader's worker_threads pool holds the event loop
  // open after work completes. Exit explicitly so the CLI returns
  // promptly. Output has already been flushed before this resolves.
  () => process.exit(0),
  (err) => { process.stderr.write(`${err.stack || err.message || err}\n`); process.exit(1); },
);
