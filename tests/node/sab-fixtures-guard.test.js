// Discipline check: /fixtures contains only SAB fixtures + corpora
// + the allowlisted runtime metadata files. Mirrors the build-time
// guard in tools/sab-fixtures-guard.js so the same regression
// surfaces in CI (node tests) as well as in the build pipeline
// (build-all-fixtures step 8).
//
// Node-only by nature, the check walks the on-disk /fixtures
// directory.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { nodeOnly } from './_runtime.js';

test('sab-fixtures-guard: /fixtures contains only sab.gz + corpora + allowlisted metadata',
  nodeOnly('filesystem walk over /fixtures'),
  async () => {
    const { findFixturesViolations, FIXTURES_ALLOWLIST_EXACT, FIXTURES_ALLOWLIST_SUFFIXES }
      = await import('../../tools/sab-fixtures-guard.js');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = join(here, '..', '..', 'fixtures');

    const violations = findFixturesViolations(fixturesDir);
    if (violations.length > 0) {
      const allow = [...FIXTURES_ALLOWLIST_EXACT].join(', ');
      const suffixes = FIXTURES_ALLOWLIST_SUFFIXES.join(', ');
      assert.ok(false,
        `/fixtures has ${violations.length} non-allowlisted file(s).\n` +
        `Allowlist: exact names [${allow}]; suffixes [${suffixes}].\n` +
        `Violations:\n  ` + violations.join('\n  ') +
        `\nAdd to tools/sab-fixtures-guard.js if intentional; ` +
        `otherwise clean up the build pipeline.`,
      );
    }
  },
);
