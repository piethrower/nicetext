#!/usr/bin/env node
// fetch.js: re-download the canonical Unicode 16.0 emoji-test.txt
// plus CLDR 48 English annotation files, and store them gzipped
// alongside this script. Run when refreshing the source; the build
// pipeline (tools/build-twlist-fixtures.js) reads the .gz files,
// not this script.
//
// Three sources:
//   1. emoji-test.txt. Unicode 16.0 emoji catalog (group/subgroup
//      headers, code points, status, name). Drives the
//      single-emoji TW-list (em16_<snake_case_subgroup> types).
//   2. annotations/en.xml. CLDR-curated English keyword lists per
//      emoji ("rose | red | flower"). Drives Aug A / Aug B / Aug-mix
//      lookup at runtime.
//   3. annotationsDerived/en.xml. CLDR-derived English keywords for
//      composite sequences (skin-tone variants, ZWJ families, flag
//      pairs). Same shape as annotations/en.xml; merge at consume
//      time.
//
// CLDR version pinned to release-48 (the latest published release at
// time of capture). Bump by updating CLDR_TAG below and re-running.
// Unicode emoji version pinned via the URL path; bump EMOJI_VERSION
// for future Emoji17, Emoji18 sources (those land as separate
// fixture-src/twlist/<name>/ directories per the snapshot-codebook
// convention; this script targets Emoji16 specifically).
//
// Licenses:
//   - emoji-test.txt: Unicode terms of use
//     (https://www.unicode.org/terms_of_use.html). Redistribution
//     permitted with attribution.
//   - CLDR XML: Unicode-3.0 / CLDR Terms of Use
//     (https://www.unicode.org/copyright.html). Redistribution
//     permitted with attribution.
// Attribution text lives in tools/build-twlist-fixtures.js (per-
// fixture # attribution: header) and attributions.html (page-level).

import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));

const EMOJI_VERSION = '16.0';
const CLDR_TAG = 'release-48';

const SOURCES = [
  {
    url: `https://unicode.org/Public/emoji/${EMOJI_VERSION}/emoji-test.txt`,
    out: 'emoji-test.txt.gz',
  },
  {
    url: `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_TAG}/common/annotations/en.xml`,
    out: 'annotations-en.xml.gz',
  },
  {
    url: `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_TAG}/common/annotationsDerived/en.xml`,
    out: 'annotations-derived-en.xml.gz',
  },
];

for (const { url, out } of SOURCES) {
  process.stderr.write(`fetching ${url}...\n`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  const dst = join(HERE, out);
  await pipeline(Readable.fromWeb(r.body), createGzip(), createWriteStream(dst));
  process.stderr.write(`wrote ${dst}\n`);
}
