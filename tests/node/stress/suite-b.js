// Suite B: rapid-fire engine-direct round-trips (no worker). Same
// dict + model held across all reps, varied secret sizes, ~150 total
// round-trips. Looks for state leaks between runs, hangs, validate
// failures, and decode mismatches.
import { chromium } from 'playwright';

const PORT = process.env.PORT || '8888';
const URL = `http://localhost:${PORT}/tests/node/stress-test.html`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[error]', m.text());
  if (m.type() === 'warning') console.log('[warn]', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  const out = [];
  function log(...a) { const s = a.join(' '); console.log('[probe]', s); out.push(s); }
  try {
    const eng = await import('/js/src/index.js');
    const { encode, decode } = eng;
    const stressEng = await import('/tests/node/stress/stress-engine.js');
    const { snipCorpusFromFixtures, DEFAULT_SOURCES, captureBytesSink } = stressEng;
    const { loadResource } = await import('/js/src/resource-loader.js');
    const { loadStressAssets, entriesToSnipFixture } = await import('/tests/node/stress/load-assets.js');

    // Curated corpora still ship as raw .txt.gz; fetch them directly.
    async function gzBytes(name) {
      const r = await fetch('/fixtures/' + name);
      const raw = new Uint8Array(await r.arrayBuffer());
      const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
      return { name, raw, inflated: new Uint8Array(await new Response(s).arrayBuffer()) };
    }

    const SOURCES = [...DEFAULT_SOURCES, 'emoji16', 'emoji-cldr-names-16', 'emoji-curated-phrases-16'];
    // Engine-direct: this probe runs on the page main thread, so it
    // calls the main-thread loadResource (no worker proxy).
    const { baseTwlists, cldr, curatedKeywords } = await loadStressAssets(loadResource, SOURCES);

    // Snip corpus: raw corpora + twlist text re-derived from the loaded
    // entries (the twlist fixtures are SAB now, not .tsv.gz).
    const fixtures = [
      await gzBytes('aesop-curated.txt.gz'),
      await gzBytes('frankenstein-curated.txt.gz'),
      entriesToSnipFixture('claude2026', baseTwlists.claude2026),
      entriesToSnipFixture('emoji16', baseTwlists.emoji16),
    ];
    const corpus = snipCorpusFromFixtures(fixtures, 0xC0FFEE, 32 * 1024);

    log('assets ready, kicking off runStress with a rich size ladder');
    const ctl = new AbortController();
    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      const since = Math.round((Date.now() - lastTick) / 1000);
      if (since > 60) { log('!! WATCHDOG: ' + since + 's since last tick, aborting'); ctl.abort(); }
    }, 5000);

    const sizes = [1, 7, 16, 64, 128, 256, 512, 1024, 2048, 4096];
    const t0 = performance.now();
    let runs = 0, passes = 0, fails = 0;
    await stressEng.runStress({
      signal: ctl.signal,
      sizes,
      reps: 3,
      rngSeed: 0xC0DEBABE,
      corpus,
      assets: { baseTwlists, cldr, curatedKeywords },
      sources: SOURCES,
      emojiFlood: true,
      restrict: false,
      maxSweeps: 1,
      maxDurationMs: Infinity,
      onProgress: (e) => {
        if (e.kind === 'tick') { lastTick = Date.now(); }
        else if (e.kind === 'roundtrip') {
          runs++;
          if (e.ok) passes++;
          else fails++;
          if (runs % 10 === 0 || !e.ok) {
            log('  roundtrip', runs, 'size=' + e.size, 'rep=' + (e.rep+1), 'ok=' + e.ok, 'ms=' + e.ms);
          }
        } else if (e.kind === 'sweep-end' || e.kind === 'cancelled' || e.kind === 'failure') {
          log('event', e.kind, JSON.stringify({ totals: e.totals, reason: e.reason, error: e.error?.message }).slice(0, 200));
        }
      },
    });
    clearInterval(watchdog);
    const dur = Math.round(performance.now() - t0);
    log('SUITE B DONE: runs=' + runs + ' pass=' + passes + ' fail=' + fails + ' wall=' + dur + 'ms');
    return { ok: fails === 0, runs, passes, fails, wallMs: dur };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), stack: e?.stack };
  }
});

console.log('\nSuite B result:', JSON.stringify(result, null, 2));
await browser.close();
