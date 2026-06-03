// Tests for createEtaTracker / formatEta.

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';

import { createEtaTracker, formatEta } from '../../js/src/eta-tracker.js';

// Synthetic clock: caller drives time.
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

test('formatEta: sub-second, seconds, minutes, hours', () => {
  assert.equal(formatEta(0), '1s');
  assert.equal(formatEta(999), '1s');
  assert.equal(formatEta(1500), '2s');
  assert.equal(formatEta(45_000), '45s');
  assert.equal(formatEta(60_000), '1m');
  assert.equal(formatEta(125_000), '2m 5s');
  assert.equal(formatEta(3600_000), '1h');
  assert.equal(formatEta(3725_000), '1h 2m');
});

test('formatEta: bad input → ?', () => {
  assert.equal(formatEta(NaN), '?');
  assert.equal(formatEta(-1), '?');
  assert.equal(formatEta(Infinity), '?');
});

test('eta: returns null during warmup window', () => {
  const c = makeClock();
  const eta = createEtaTracker({ totalBytes: 1_000_000, now: c.now, warmupMs: 5000, warmupBytes: 64 * 1024 });
  c.advance(1000); // 1s elapsed
  assert.equal(eta.update(10_000), null); // still in warmup (both gates open)
});

test('eta: warmupBytes alone exits warmup', () => {
  const c = makeClock();
  const eta = createEtaTracker({ totalBytes: 1_000_000, now: c.now, warmupMs: 60_000, warmupBytes: 64 * 1024 });
  // Two samples: feed a rate of 100 bytes/ms.
  c.advance(200); eta.update(20_000);
  c.advance(800); // bytesProcessed at 100k will exceed warmupBytes
  const s = eta.update(100_000);
  assert.ok(s != null, `expected ETA once bytes exceed warmupBytes; got ${s}`);
});

test('eta: warmupMs alone exits warmup', () => {
  const c = makeClock();
  const eta = createEtaTracker({ totalBytes: 1_000_000, now: c.now, warmupMs: 2000, warmupBytes: 100 * 1024 * 1024 });
  c.advance(500); eta.update(5_000);
  c.advance(2000); // now 2.5s elapsed
  const s = eta.update(10_000);
  assert.ok(s != null);
});

test('eta: converges to rough remaining time at steady throughput', () => {
  // Steady 1000 bytes/ms = 1 MB/s. Total = 10 MB. After 5 s (5 MB
  // processed), ETA should be roughly 5 seconds.
  const c = makeClock();
  const eta = createEtaTracker({
    totalBytes: 10 * 1024 * 1024,
    now: c.now,
    warmupMs: 1000,
    warmupBytes: 1024 * 1024,
  });
  // Feed 500 samples at 10 ms intervals; each sample 10 KB.
  for (let i = 1; i <= 500; i++) {
    c.advance(10);
    eta.update(i * 10 * 1024);
  }
  // 500 * 10 KB = 5 MB processed; 5 MB remaining; rate = 1 KB/ms.
  const s = eta.update(500 * 10 * 1024);
  // Parse "5s", accept anything within a few seconds.
  assert.match(s, /^\d+s$/, `expected seconds-format ETA, got "${s}"`);
  const sec = parseInt(s, 10);
  assert.ok(sec >= 3 && sec <= 8, `expected ETA near 5s, got ${s}`);
});

test('eta: throughput collapse inflates ETA (does not freeze)', () => {
  const c = makeClock();
  const eta = createEtaTracker({
    totalBytes: 10 * 1024 * 1024,
    now: c.now,
    warmupMs: 500,
    warmupBytes: 256 * 1024,
  });
  // Phase 1: fast throughput, 1 MB/s, for 2 seconds → 2 MB processed.
  for (let i = 1; i <= 200; i++) {
    c.advance(10);
    eta.update(i * 10 * 1024);
  }
  const fastEta = eta.update(2 * 1024 * 1024);
  // Phase 2: throughput collapse to ~10 KB/s; advance 5 sec, only 50 KB added.
  for (let i = 1; i <= 50; i++) {
    c.advance(100);
    eta.update(2 * 1024 * 1024 + i * 1024);
  }
  const slowEta = eta.update(2 * 1024 * 1024 + 50 * 1024);
  // ETA should be DRAMATICALLY larger after collapse (was ~8s, now should be minutes).
  const parseSeconds = (s) => {
    if (s == null) return Infinity;
    const m = /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/.exec(s) ?? /^(\d+)s$/.exec(s);
    // '<1s' was the pre-clamp sentinel; kept for safety but unused
    // after formatEta now clamps to '1s' minimum.
    if (s === '<1s') return 0;
    if (!m) return NaN;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  };
  const fastSec = parseSeconds(fastEta);
  const slowSec = parseSeconds(slowEta);
  assert.ok(slowSec > fastSec * 5,
    `expected slow ETA (${slowEta}) to be >5× fast ETA (${fastEta}); fastSec=${fastSec}, slowSec=${slowSec}`);
});

test('eta: returns null when totalBytes is 0 or missing', () => {
  const c = makeClock();
  const eta = createEtaTracker({ totalBytes: 0, now: c.now, warmupMs: 0, warmupBytes: 0 });
  c.advance(100); eta.update(1000);
  c.advance(100);
  assert.equal(eta.update(2000), null);
});

test('eta: ignores rapid-fire samples below minSampleMs', () => {
  const c = makeClock();
  const eta = createEtaTracker({
    totalBytes: 1_000_000, now: c.now,
    warmupMs: 0, warmupBytes: 0,
    minSampleMs: 100,
  });
  // 5 samples within 10ms each, only the first sets state, the rest are ignored.
  for (let i = 1; i <= 5; i++) {
    c.advance(10);
    eta.update(i * 1000);
  }
  // Smoothed rate should still be null (no sample ever spanned >=100ms).
  const state = eta._state();
  assert.equal(state.smoothedRate, null);
});
