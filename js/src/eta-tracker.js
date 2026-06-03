// eta-tracker.js: live-rate ETA from in-progress throughput samples.
//
// Built for the encode progress modal (audit Finding 7). No hardcoded
// throughput assumptions: every number comes from THIS run's
// performance.now() deltas on THIS machine. Computers of vastly
// different speeds get accurate per-run ETAs without per-machine
// calibration or persisted history.
//
// Usage:
//   const eta = createEtaTracker({ totalBytes: 1_000_000 });
//   onProgress: (info) => {
//     const remaining = eta.update(bytesProcessed); // string or null
//     modal.update(`...${remaining ? ' (ETA ' + remaining + ')' : ''}`, ...);
//   };
//
// Algorithm:
//   - Exponentially-weighted moving average of bytes-per-millisecond,
//     sampled at >=100 ms intervals (avoids jitter from rapid-fire
//     progress events).
//   - Warmup gate: returns null until elapsedMs >= warmupMs OR
//     bytesProcessed >= warmupBytes. First seconds on a cold cache
//     are unreliable; the gate prevents misleading early estimates.
//   - Throughput collapse mid-run (GC, backgrounded tab) is absorbed
//     by the EWMA: ETA inflates within a couple seconds rather than
//     freezing or showing stale numbers.
//
// Browser-safe ESM. No deps. Pure of side effects (performance.now()
// is the only "now" source).

const DEFAULTS = {
  warmupMs: 5000,
  warmupBytes: 64 * 1024,
  alpha: 0.3,            // EWMA smoothing factor (0..1; higher = more reactive)
  minSampleMs: 100,      // ignore samples faster than this (jitter)
  now: () => (typeof performance !== 'undefined' && performance.now
              ? performance.now()
              : Date.now()),
};

export function createEtaTracker(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const totalBytes = Number(cfg.totalBytes) || 0;
  const t0 = cfg.now();
  let lastT = t0;
  let lastBytes = 0;
  let smoothedRate = null; // bytes per millisecond

  return {
    // Feed a cumulative bytes-processed reading. Returns a formatted
    // ETA string (e.g. "12s", "3m 14s", "1h 5m") or null if it's too
    // early to produce a reliable estimate.
    update(bytesProcessed) {
      const now = cfg.now();
      const dt = now - lastT;
      const db = bytesProcessed - lastBytes;
      if (dt >= cfg.minSampleMs && db > 0) {
        const instantRate = db / dt;
        smoothedRate = smoothedRate == null
          ? instantRate
          : cfg.alpha * instantRate + (1 - cfg.alpha) * smoothedRate;
        lastT = now;
        lastBytes = bytesProcessed;
      }
      const elapsedMs = now - t0;
      if (elapsedMs < cfg.warmupMs && bytesProcessed < cfg.warmupBytes) return null;
      if (smoothedRate == null || smoothedRate <= 0) return null;
      if (totalBytes <= 0) return null;
      const remainingBytes = Math.max(0, totalBytes - bytesProcessed);
      const remainingMs = remainingBytes / smoothedRate;
      return formatEta(remainingMs);
    },
    // Inspection hooks for tests / debugging.
    _state() {
      return { smoothedRate, lastBytes, lastT, t0 };
    },
  };
}

export function formatEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  // Sub-second estimates are useless ("ETA <1s" then a 5s hang reads
  // worse than no estimate). Clamp to a 1s minimum.
  if (ms < 1000) return '1s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s > 0 ? `${min}m ${s}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${hr}h ${m}m` : `${hr}h`;
}
