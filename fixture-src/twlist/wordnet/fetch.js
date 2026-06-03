#!/usr/bin/env node
// fetch.js: re-download WordNet 3.0's database tarball from Princeton,
// extract the index and data files for each part of speech (noun,
// verb, adj, adv), and store each gzipped alongside this script.
// Index files drive the POS fixture; data files drive the synset
// fixture. Run when refreshing the source; the build pipeline
// (tools/build-twlist-fixtures.js) reads the .gz files, not this
// script.
//
// WordNet 3.0 Copyright 2006 by Princeton University. All rights
// reserved. See https://wordnet.princeton.edu/license-and-commercial-use
// for license terms; the attribution notice is carried in the
// generated fixture's "attribution" field and surfaced in the
// page's Historical Notes section.

import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz';

const work = mkdtempSync(join(tmpdir(), 'nicetext-wn-'));
try {
  const tgz = join(work, 'wn.tgz');
  process.stderr.write(`fetching ${URL}...\n`);
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`fetch ${URL}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tgz));
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', work], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('tar extraction failed');
  for (const pos of ['noun', 'verb', 'adj', 'adv']) {
    for (const kind of ['index', 'data']) {
      const src = join(work, 'dict', `${kind}.${pos}`);
      const dst = join(HERE, `${kind}.${pos}.gz`);
      await pipeline(Readable.from(readFileSync(src)), createGzip(), createWriteStream(dst));
      process.stderr.write(`wrote ${dst}\n`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
