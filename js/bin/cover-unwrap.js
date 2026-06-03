#!/usr/bin/env node
// cover-unwrap : auto-strip a wrapped cover. Reads a wrapped artifact
// on stdin, iteratively detects and peels each layer until no known
// wrapper prefix matches. Output is the bare cover text (escape-pass
// disambiguators still in place; they're harmless to the decoder).

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import { autoStrip } from '../src/cover-pipeline.js';

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
  process.stderr.write(`usage: cover-unwrap [--max-iterations=N] [-i <input>] [-o <output>]

  --max-iterations  Cap on how many layers auto-strip will peel
                    (default: 10).
  -i, --in          Input file (default: stdin).
  -o, --out         Output file (default: stdout).
`);
}

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

function nodeReadableToWeb(nodeReadable) {
  return Readable.toWeb(nodeReadable);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.h || flags.help) { usage(); process.exit(0); }

  const maxIterations = flags['max-iterations']
    ? parseInt(flags['max-iterations'], 10)
    : 10;
  if (!Number.isFinite(maxIterations) || maxIterations < 0) {
    process.stderr.write(`cover-unwrap: --max-iterations must be a non-negative integer\n`);
    process.exit(2);
  }

  const inputNode = flags.in || flags.i
    ? createReadStream(flags.in || flags.i)
    : process.stdin;
  const outputNode = flags.out || flags.o
    ? createWriteStream(flags.out || flags.o)
    : process.stdout;

  const inputWeb = nodeReadableToWeb(inputNode);
  const bare = await autoStrip(inputWeb, { maxIterations });
  await bare.pipeTo(nodeWritableToWeb(outputNode));
}

main().catch((err) => {
  process.stderr.write(`cover-unwrap: ${err.message}\n`);
  process.exit(1);
});
