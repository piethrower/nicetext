// Iterative bottom-up mergesort that yields to the event loop every
// `yieldEvery` element-merges. The native Array.sort can't be
// interrupted; callers that want to keep the Build modal responsive
// (and to honor an AbortSignal) use this instead. The trade is
// ~3-8x slower wall-clock than native sort for the cost of mid-sort
// progress reporting + cancellability + no >1s silent window.
//
// Sort is stable (mergesort preserves equal-key order).
//
// Usage:
//   const sorted = await mergesortAsync(arr, (a, b) => a - b, {
//     yieldEvery: 50_000,
//     onProgress: (e) => router(e),
//     signal: ctrl.signal,
//   });
//
// onProgress events:
//   { phase: 'mergesort-pass',  runSize, mergedItems, total }
//                                  emitted mid-pass every yieldEvery
//                                  merged items
//   { phase: 'mergesort-end',   total }
//                                  emitted once at completion
//
// opts.yieldEvery   merged items per yield (default 50,000)
// opts.signal       optional AbortSignal, throws DOMException
//                   AbortError when set between yields
// opts.onProgress   optional callback
//
// Implementation: classic ping-pong buffer. `src` and `dst` swap roles
// each pass. The final pass copies the sorted result back into `arr`
// in place IF the caller wants stable identity; mergesortAsync returns
// the sorted array (which may be `arr` or `dst` depending on parity).
// Callers that mutate the original should use `arr.length = 0;
// arr.push(...sorted)`; callers that just need a sorted reference can
// keep the return value.
export async function mergesortAsync(arr, cmp, opts = {}) {
  if (!Array.isArray(arr)) throw new TypeError('mergesortAsync: arr must be an array');
  if (typeof cmp !== 'function') throw new TypeError('mergesortAsync: cmp must be a function');
  const yieldEvery = opts.yieldEvery ?? 50_000;
  const signal = opts.signal ?? null;
  const onProgress = opts.onProgress ?? null;
  const n = arr.length;
  if (n <= 1) {
    if (onProgress) onProgress({ phase: 'mergesort-end', total: n });
    return arr;
  }

  let src = arr;
  let dst = new Array(n);
  let mergedSinceYield = 0;

  for (let runSize = 1; runSize < n; runSize *= 2) {
    for (let runStart = 0; runStart < n; runStart += runSize * 2) {
      // Merge [runStart, runStart+runSize) with [runStart+runSize,
      // runStart+runSize*2), into dst[runStart..].
      const leftEnd  = Math.min(runStart + runSize, n);
      const rightEnd = Math.min(runStart + runSize * 2, n);
      let i = runStart;
      let j = leftEnd;
      let k = runStart;
      while (i < leftEnd && j < rightEnd) {
        if (cmp(src[i], src[j]) <= 0) dst[k++] = src[i++];
        else                          dst[k++] = src[j++];
      }
      while (i < leftEnd)  dst[k++] = src[i++];
      while (j < rightEnd) dst[k++] = src[j++];
      mergedSinceYield += (rightEnd - runStart);
      if (mergedSinceYield >= yieldEvery) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (onProgress) onProgress({
          phase: 'mergesort-pass',
          runSize,
          mergedItems: runStart + (rightEnd - runStart),
          total: n,
        });
        await new Promise(r => setTimeout(r, 0));
        mergedSinceYield = 0;
      }
    }
    // Swap roles for the next pass.
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  if (onProgress) onProgress({ phase: 'mergesort-end', total: n });
  return src;
}
