// Shared discipline check for /fixtures. Asserts the directory
// contains only:
//   1. SAB fixtures (`*.sab.gz`, any depth)
//   2. Raw corpora (`*.txt.gz`)
//   3. The exact allowlist:
//      - cards.data.js                  (runtime ES module
//                                        synchronously imported by
//                                        app.js + eve-worker.js +
//                                        share.js + session.js)
//      - twlist-sources.meta.js         (same, synchronously
//                                        imported metadata twin)
//      - twlist-sources.meta.json       (build-tool JSON twin of
//                                        the .js, consumed by
//                                        tools/sab.js +
//                                        tools/build-twlist-wlist.js
//                                        via fs)
//      - confusables-data.js            (baked TR39 fold Map, copied
//                                        from fixture-src/confusables/
//                                        cooked/ by build-all-fixtures,
//                                        imported by precleanCorpus.js)
//
// This module is the single source-of-truth used by:
//   - tools/build-all-fixtures.js          (final step; loud red
//                                           build on violation)
//   - tests/node/sab-fixtures-guard.test.js (node test mirrors the
//                                           pipeline check, so a
//                                           regression also fails CI)
//
// Adding a new non-SAB fixture requires explicit allowlist approval
// here.

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FIXTURES_ALLOWLIST_EXACT = Object.freeze(new Set([
  'cards.data.js',
  'twlist-sources.meta.js',
  'twlist-sources.meta.json',
  'confusables-data.js',
]));

export const FIXTURES_ALLOWLIST_SUFFIXES = Object.freeze([
  '.sab.gz',
  '.txt.gz',
  '.ttf',          // fixtures/font/*.ttf, copied from fixture-src/font/cooked/
]);

// findFixturesViolations(fixturesDir) -> Array<relative-path string>.
// Walks fixturesDir recursively; returns the relative paths of every
// file that violates the allowlist. Empty array means clean.
export function findFixturesViolations(fixturesDir) {
  const violations = [];
  walk(fixturesDir, fixturesDir, violations);
  return violations;
}

function walk(rootDir, currentDir, out) {
  for (const ent of readdirSync(currentDir, { withFileTypes: true })) {
    const full = join(currentDir, ent.name);
    if (ent.isDirectory()) {
      walk(rootDir, full, out);
      continue;
    }
    if (FIXTURES_ALLOWLIST_EXACT.has(ent.name)) continue;
    if (FIXTURES_ALLOWLIST_SUFFIXES.some((s) => ent.name.endsWith(s))) continue;
    out.push(relative(rootDir, full));
  }
}

// assertNoFixturesViolations(fixturesDir) -> void; throws on violation.
// Used by the build pipeline (a thrown error halts build-all-fixtures
// with a non-zero exit) and by the node test (the throw turns into a
// test failure).
export function assertNoFixturesViolations(fixturesDir) {
  const violations = findFixturesViolations(fixturesDir);
  if (violations.length === 0) return;
  throw new Error(
    `sab-fixtures-guard: ${violations.length} non-allowlisted ` +
    `file(s) in /fixtures (see tools/sab-fixtures-guard.js for the ` +
    `allowlist):\n  ` +
    violations.join('\n  '),
  );
}
