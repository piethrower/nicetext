#!/usr/bin/env node
// fetch.js: INSTRUCTIONS ONLY. The Apple II Screen typeface is a
// third-party font, so this script does not download anything. It
// prints where to get the file by hand and where to drop it, then
// exits. raw/ is gitignored and ephemeral; the committed
// cooked/AppleIiScreenTypeface-2aP3.ttf is the authoritative copy the
// build uses, and build-all-fixtures.js deploys that to
// fixtures/font/. You only need to run this to refresh the font.
//
//   Font:    Apple II Screen Typeface by Trekker
//   License: Creative Commons Attribution (CC BY 4.0)
//   Source:  https://www.fontspace.com/apple-ii-screen-typeface-font-f34484
//
// To refresh:
//   1. Open the FontSpace page above and download the family zip
//      (FontSpace serves a gated zip, not a direct .ttf link, which is
//      why this script can't fetch it automatically).
//   2. Unzip it and copy AppleIiScreenTypeface-2aP3.ttf into:
//        fixture-src/font/raw/AppleIiScreenTypeface-2aP3.ttf
//   3. Run: node tools/build-font.js
//      (copies raw/ -> cooked/ only because raw/ is now newer), then
//      commit the updated cooked/AppleIiScreenTypeface-2aP3.ttf.
//   4. Confirm the CC BY attribution in attributions.html and the note
//      in fixture-src/font/info.txt still match the downloaded version.

process.stderr.write(
  'fetch.js for the Apple II Screen font is instructions-only.\n' +
  'Read this file\'s header for the manual download + placement steps.\n' +
  'The committed cooked/AppleIiScreenTypeface-2aP3.ttf is authoritative;\n' +
  'you only need this to refresh the font from FontSpace.\n',
);
