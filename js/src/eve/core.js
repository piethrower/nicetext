// Eve Phase I core. Streams a suspected's tokens through the active
// detector set and returns per-knob verdicts.
//
// runPhase1 is intentionally token-iterable-agnostic: pass a sync
// iterable (from `tokenize(text)`) for small fixtures and tests, or
// an async iterable (from `tokenizeStream(stream)`) for large suspecteds.
// JavaScript's `for await` handles both forms transparently.
//
// Eve never modifies core engine behavior. The lexer is imported and
// used as-is by the CLI; this module never edits it.
//
// Browser-safe ESM, zero deps. Phase I never touches the decoder.

export async function runPhase1(tokens, detectors, opts = {}) {
  const yieldEvery = opts.yieldEvery ?? 4096;
  const signal = opts.signal ?? null;
  let tokenCount = 0;
  let active = detectors.slice();
  for await (const tok of tokens) {
    tokenCount++;
    for (const d of active) d.consume(tok);
    if (tokenCount % yieldEvery === 0) {
      if (signal && signal.aborted) break;
      active = active.filter(d => !d.verdict().done);
      if (active.length === 0) break;
      if (opts.onProgress) {
        try {
          await opts.onProgress({
            tokenCount,
            activeCount: active.length,
            totalCount: detectors.length,
          });
        } catch {}
      }
      // Macrotask yield so a long sweep stays cancellable.
      await new Promise(r => setTimeout(r, 0));
    }
  }
  // Stream-end finalize hook. Detectors that distinguish "no
  // evidence yet" from "stream exhausted with no evidence" apply
  // their negative rule here; positive-evidence detectors that
  // already committed during the stream ignore the call. Optional
  // per detector so pre-refactor detectors keep working unchanged.
  for (const d of detectors) {
    if (typeof d.finalize === 'function') d.finalize();
  }
  return {
    tokenCount,
    verdicts: detectors.map(d => ({ knob: d.knob, ...d.verdict() })),
  };
}
