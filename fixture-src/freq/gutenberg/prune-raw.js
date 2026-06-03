#!/usr/bin/env node
// prune-raw.js -- read english-paths.txt and delete from raw/ every
// .txt that isn't on the list. The list itself encodes the variant
// choice (bare or -0.txt) per book, so a single set-membership test
// is sufficient. Empty directories left behind get removed in a
// second pass so future rsyncs don't have stale dirs to descend into.
//
// Run AFTER list-english.js, BEFORE re-running fetch.js.

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
// english-paths.txt lives in raw/ alongside the downloaded books;
// list-english.js writes it there.
const LIST = join(RAW, 'english-paths.txt');

if (!existsSync(LIST)) {
  console.error(`missing ${LIST} -- run list-english.js first`);
  process.exit(1);
}
if (!existsSync(RAW)) {
  console.error(`missing ${RAW} -- nothing to prune`);
  process.exit(0);
}

const wanted = new Set(
  readFileSync(LIST, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
);
process.stderr.write(`english-only paths in list: ${wanted.size}\n`);

let deleted = 0;
let kept = 0;
const stack = [RAW];
while (stack.length) {
  const dir = stack.pop();
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { continue; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      stack.push(p);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith('.txt')) continue;
    const rel = relative(RAW, p).split(sep).join('/');
    if (!wanted.has(rel)) {
      rmSync(p);
      deleted++;
      continue;
    }
    kept++;
  }
}
process.stderr.write(`kept: ${kept}\n`);
process.stderr.write(`deleted (off-list): ${deleted}\n`);

// Second pass: remove empty directories (deepest first so parents
// become empty as we go). Do not remove RAW itself.
function removeEmptyDirs(root) {
  let removed = 0;
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
    }
    if (dir === root) return;
    try {
      const remaining = readdirSync(dir);
      if (remaining.length === 0) {
        rmdirSync(dir);
        removed++;
      }
    } catch {}
  }
  walk(root);
  return removed;
}
const removed = removeEmptyDirs(RAW);
process.stderr.write(`removed empty dirs: ${removed}\n`);
