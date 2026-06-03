// Smoke: verify that kind:'twlist' derives from kind:'raw-bytes' so
// the gunzip work is shared between consumers. Run as:
//   node tests/node/tmp/probe-twlist-derivation.mjs

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadResource,
  _cacheSize,
  _clearCache,
} from '../../../js/src/resource-loader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TWLIST_URL = pathToFileURL(join(ROOT, 'fixtures', 'connectors.twlist.tsv.gz')).href;

let ok = true;

_clearCache();
console.log(`Start: cache size = ${_cacheSize()}`);

// Load twlist (packed SAB). Internally this should also populate the
// raw-bytes cache entry for the same URL.
const twlistSab = await loadResource({ url: TWLIST_URL, kind: 'twlist' });
console.log(`After twlist load: cache size = ${_cacheSize()}, packed SAB ${twlistSab.byteLength.toLocaleString()} bytes`);
if (_cacheSize() !== 2) {
  console.log(`  ✗ expected 2 entries (raw-bytes + twlist), got ${_cacheSize()}`);
  ok = false;
}

// Load raw-bytes for the same URL. Should hit cache; no new entries,
// no new pool dispatch.
const sizeBefore = _cacheSize();
const bytesSab = await loadResource({ url: TWLIST_URL, kind: 'raw-bytes' });
console.log(`After raw-bytes load: cache size = ${_cacheSize()}, bytes SAB ${bytesSab.byteLength.toLocaleString()} bytes`);
if (_cacheSize() !== sizeBefore) {
  console.log(`  ✗ expected cache stable at ${sizeBefore}, got ${_cacheSize()}`);
  ok = false;
}

// Load twlist again. Should hit cache; nothing new.
await loadResource({ url: TWLIST_URL, kind: 'twlist' });
console.log(`After twlist re-load: cache size = ${_cacheSize()}`);
if (_cacheSize() !== sizeBefore) {
  console.log(`  ✗ expected cache stable at ${sizeBefore}, got ${_cacheSize()}`);
  ok = false;
}

console.log(ok ? '✓ derivation cache shared' : '✗ derivation cache mismatch');
process.exit(ok ? 0 : 1);
