// Run the browser test suite end-to-end and list every failure with
// its error message. Used to track down regressions during the
// shim-portability refactor.

import { chromium } from 'playwright';

const PORT = process.env.PORT || '8888';
const URL = `http://localhost:${PORT}/tests/node/test-suite.html`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.click('#run-btn');

// Wait for the run to reach a terminal state. Hard cap at 5 min.
await page.waitForFunction(() => {
  const s = document.getElementById('summary');
  return s && (s.dataset.status === 'pass' || s.dataset.status === 'fail');
}, null, { timeout: 5 * 60 * 1000 });

const summary = await page.evaluate(() => document.getElementById('summary').textContent);
const fails = await page.evaluate(() => {
  const out = [];
  for (const li of document.querySelectorAll('#results li')) {
    const badge = li.querySelector('.noderun-badge');
    if (!badge || badge.textContent !== 'fail') continue;
    const name = li.querySelector('.noderun-name')?.textContent || '';
    const err  = li.querySelector('.noderun-error')?.textContent || '';
    out.push({ name, err });
  }
  return out;
});

console.log(summary);
console.log(`\n${fails.length} failures:`);
for (const f of fails) {
  console.log(`\n--- ${f.name}`);
  console.log(f.err);
}

await browser.close();
