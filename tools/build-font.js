// Promote a refreshed font from raw/ to cooked/.
//
// Input:  fixture-src/font/raw/AppleIiScreenTypeface-2aP3.ttf
//           (gitignored, ephemeral; placed by hand per fixture-src/font/fetch.js)
// Output: fixture-src/font/cooked/AppleIiScreenTypeface-2aP3.ttf
//           (committed, authoritative; deployed to fixtures/font/ by build-all-fixtures.js)
//
// A font isn't transformed, so this is a verbatim copy gated on
// staleness, the same shape as tools/build-confusables-map.js: a no-op
// unless raw/ is present and newer than cooked/. raw/ is absent on a
// normal checkout, so nothing happens; the committed cooked/ is the
// source of truth. Only a manual font refresh (fetch.js) makes raw/
// newer and triggers the copy.
//
// Run with: node tools/build-font.js

import { copyFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const FONT = 'AppleIiScreenTypeface-2aP3.ttf';
const SRC = join(REPO, 'fixture-src', 'font', 'raw', FONT);
const OUT = join(REPO, 'fixture-src', 'font', 'cooked', FONT);

if (!existsSync(SRC)) {
  process.stderr.write(
    `raw font absent (${SRC}); cooked/ is authoritative, nothing to do.\n` +
    `See fixture-src/font/fetch.js to refresh the font.\n`,
  );
  process.exit(0);
}
if (existsSync(OUT) && statSync(SRC).mtimeMs <= statSync(OUT).mtimeMs) {
  process.stderr.write(`cooked/ font is up to date with raw/; nothing to do.\n`);
  process.exit(0);
}

copyFileSync(SRC, OUT);
process.stderr.write(`copied ${SRC}\n  -> ${OUT}\n`);
