// Identifies the test where tests/node/test-suite.html hangs. Drives
// the page, clicks Run, samples the #summary line every 500 ms, and
// reports the high-water test name + how long it sat there with no
// progress. Times out at 120 s.
//
// Run while `tools/serve.sh` is up on :8888.

import { chromium } from 'playwright';

const PORT = process.env.PORT || '8888';
const URL = `http://localhost:${PORT}/tests/node/test-suite.html`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log(`console.error: ${msg.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Start the run.
await page.click('#run-btn');
console.log('clicked Run; sampling summary every 500ms...');

const t0 = Date.now();
let lastSummary = '';
let lastChangeAt = t0;
const STALL_AFTER_MS = 30_000;
const HARD_TIMEOUT_MS = 120_000;
const samples = [];

while (true) {
  await new Promise(r => setTimeout(r, 500));
  let snap;
  try {
    snap = await page.evaluate(() => {
      const s = document.getElementById('summary');
      const status = s?.dataset?.status || '';
      const text = s?.textContent || '';
      const progressVal = document.getElementById('progress')?.value || 0;
      return { status, text, progressVal };
    });
  } catch (e) {
    console.log(`evaluate failed: ${e.message}`);
    break;
  }
  const now = Date.now();
  if (snap.text !== lastSummary) {
    lastSummary = snap.text;
    lastChangeAt = now;
    samples.push({ at: now - t0, status: snap.status, progress: snap.progressVal, text: snap.text });
    console.log(`+${((now - t0) / 1000).toFixed(1)}s [${snap.status}] ${snap.text}`);
  }
  // Terminal: pass/fail.
  if (snap.status === 'pass' || snap.status === 'fail') {
    console.log('terminal reached.');
    break;
  }
  // Stall detection: no summary change for STALL_AFTER_MS.
  if (now - lastChangeAt > STALL_AFTER_MS) {
    console.log(`STALL: no summary change for ${STALL_AFTER_MS / 1000}s.`);
    console.log(`last summary: ${JSON.stringify(lastSummary)}`);
    break;
  }
  if (now - t0 > HARD_TIMEOUT_MS) {
    console.log(`HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s.`);
    break;
  }
}

console.log('\nsamples:');
for (const s of samples) {
  console.log(`  +${(s.at / 1000).toFixed(1)}s  progress=${s.progressVal.toFixed(3)}  ${s.text}`);
}

await browser.close();
