#!/usr/bin/env node
// Node-side test runner. Same harness.js that drives the browser
// page (test-suite.html) runs the suite here; the runtime-portable
// shims handle the `node:test` / `node:assert` / `node:fs` calls in
// each runtime. One engine, two runtimes, same architecture as
// stress-engine.
//
// Output: TAP-like one line per test, terminal summary, non-zero
// exit on failure. Compatible with most CI parsers and human eyes.
//
// Usage:
//   npm test
//   node tests/node/run-node.mjs

import { runAll } from './harness.js';

function describeError(err) {
  if (!err) return '';
  const lines = [];
  lines.push(`${err.name || 'Error'}: ${err.message || err}`);
  if ('actual' in err || 'expected' in err) {
    try { lines.push(`  actual:   ${JSON.stringify(err.actual)}`); } catch {}
    try { lines.push(`  expected: ${JSON.stringify(err.expected)}`); } catch {}
  }
  if (err.stack) lines.push(err.stack.split('\n').slice(1, 4).join('\n'));
  return lines.join('\n  ');
}

let n = 0;
let passCount = 0;
let failCount = 0;
let skipCount = 0;
let todoCount = 0;

const out = await runAll({
  onProgress: (ev) => {
    if (ev.phase === 'result') {
      n++;
      const r = ev.result;
      const ms = r.ms == null ? '' : ` # ${r.ms.toFixed(1)}ms`;
      if (r.status === 'pass') {
        passCount++;
        process.stdout.write(`ok ${n} - ${r.name}${ms}\n`);
      } else if (r.status === 'skip') {
        skipCount++;
        process.stdout.write(`ok ${n} - ${r.name} # SKIP\n`);
      } else if (r.status === 'todo') {
        todoCount++;
        process.stdout.write(`ok ${n} - ${r.name} # TODO\n`);
      } else {
        failCount++;
        process.stdout.write(`not ok ${n} - ${r.name}${ms}\n`);
        if (r.error) {
          process.stdout.write('  ---\n  ');
          process.stdout.write(describeError(r.error));
          process.stdout.write('\n  ---\n');
        }
      }
    }
  },
});

process.stdout.write(`1..${n}\n`);
process.stdout.write(`# tests ${out.results.length}\n`);
process.stdout.write(`# pass  ${passCount}\n`);
process.stdout.write(`# fail  ${failCount}\n`);
if (skipCount) process.stdout.write(`# skip  ${skipCount}\n`);
if (todoCount) process.stdout.write(`# todo  ${todoCount}\n`);

process.exit(failCount > 0 ? 1 : 0);
