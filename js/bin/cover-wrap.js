#!/usr/bin/env node
// cover-wrap : run the cover-text post-processor stack on stdin.
// Reads bare cover text, runs the escape filter, then applies the
// user-specified envelope + format stack in order. Output is the
// wrapped cover, suitable for save / share.

import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import { applyStack, escapeTransform, KNOWN_LAYER_TYPES } from '../src/cover-pipeline.js';

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
  process.stderr.write(`usage: cover-wrap [--layers=<csv>] [--filename=<name>] [--subject=<text>] [--no-escape] [-i <input>] [-o <output>]

  --layers      Comma-separated list of layer types applied in order.
                Empty (or omitted) emits the cover unchanged after escape.
                Layer types: ${KNOWN_LAYER_TYPES.join(', ')}.
                Example: --layers=html,gzip,base64
  --filename    Base filename embedded in format-layer metadata
                (gzip FNAME, PEM BEGIN <name>, uuencode begin line).
                Each format layer appends its own extension to this name.
                Default: message.
  --subject     Subject line embedded in envelope content
                (<title>/<h1> in HTML, Subject: in EML, /Title in PDF, etc.).
                Default: Note.
  --no-escape   Skip the escape pass. Use only when you control both ends
                and know the cover doesn't contain wrapper-marker lines.
  -i, --in      Input file (default: stdin).
  -o, --out     Output file (default: stdout).
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

  const layers = flags.layers
    ? flags.layers.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  for (const t of layers) {
    if (!KNOWN_LAYER_TYPES.includes(t)) {
      process.stderr.write(`cover-wrap: unknown layer type "${t}"\n`);
      process.stderr.write(`known types: ${KNOWN_LAYER_TYPES.join(', ')}\n`);
      process.exit(2);
    }
  }

  const filename = flags.filename || 'message';
  const subject = flags.subject || 'Note';

  if (filename.length > 64) {
    process.stderr.write(`cover-wrap: --filename exceeds 64-char cap\n`);
    process.exit(2);
  }
  if (subject.length > 64) {
    process.stderr.write(`cover-wrap: --subject exceeds 64-char cap\n`);
    process.exit(2);
  }

  // Per the locked design, each format layer's `filename` accumulates
  // the previous layer's extension. The CLI takes a base filename and
  // walks the stack, picking the right per-layer name. Envelopes set
  // the suffix; formats append theirs.
  const ENVELOPE_EXT = {
    html: 'html', pdf: 'pdf', eml: 'eml', markdown: 'md', latex: 'tex',
  };
  const FORMAT_EXT = {
    gzip: 'gz', base64: 'b64', uuencode: 'uue',
  };

  let currentName = filename;
  const stack = layers.map(t => {
    const layer = { type: t, filename: currentName, subject };
    if (ENVELOPE_EXT[t]) currentName = `${filename.replace(/\.(html|pdf|eml|md|tex)$/i, '')}.${ENVELOPE_EXT[t]}`;
    else if (FORMAT_EXT[t]) currentName = `${currentName}.${FORMAT_EXT[t]}`;
    return layer;
  });

  const inputNode = flags.in || flags.i
    ? createReadStream(flags.in || flags.i)
    : process.stdin;
  const outputNode = flags.out || flags.o
    ? createWriteStream(flags.out || flags.o)
    : process.stdout;

  let inputWeb = nodeReadableToWeb(inputNode);
  if (!flags['no-escape']) {
    inputWeb = inputWeb.pipeThrough(escapeTransform());
  }
  const wrapped = applyStack(inputWeb, stack);
  await wrapped.pipeTo(nodeWritableToWeb(outputNode));
}

main().catch((err) => {
  process.stderr.write(`cover-wrap: ${err.message}\n`);
  process.exit(1);
});
