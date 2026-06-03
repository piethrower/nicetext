// aug-pipeline.js: fixed-point augmentation orchestrator.
//
// Drives the SAB-native augs in aug-impls-sab.js through the
// snapshot-based fixed-point loop from docs/research-notes.md §18.2,
// with the §18.4 SAB + multi-worker execution model.
//
// Single entry:
//   await runAugsPacked(t0Entries, selectedAugs, opts) => Array<{type, word}>
//
// Layered structure (no merge during the loop):
//   - t0 is packed once into its own SAB.
//   - Iter 1 input for every aug: [t0].
//   - Iter i (i > 1) input for aug x: the list of every OTHER aug's
//     iter-(i-1) contribution SAB. Empty SABs from prior iter are
//     skipped (they contribute no entries to the indexes anyway).
//   - Each call returns one contribution SAB (possibly empty).
//   - Convergence: if every aug at iter i returned an empty SAB, stop.
//     Otherwise iterate, capped at |selectedAugs| + 1 iterations.
//   - Final output: t0 ∪ every contribution SAB across all iterations,
//     unpacked-and-concatenated to a JS array. Cross-SAB duplicates
//     are tolerated; sortDict downstream collapses them by word.
//
// selectedAugs: subset of ['vowel', 'eiw', 'wie'] in any order. Mixed-
// phrase emits live inside eiw/wie themselves now (per the redesigned
// phrase-and-charset spec §C); see opts.mix below.
//
// opts:
//   cldr              : emoji CLDR keyword map (required for eiw/wie).
//   curatedKeywords   : optional Set<string> filter applied to CLDR keys.
//   mix               : int 0..MIX_MAX, controls phrase variants emitted
//                        by eiw/wie (0 = no phrases; N = atom + N word-
//                        phrases + (N-1) bare-repeats per (E,k,T) tuple).
//   poolSize          : override worker pool size (default
//                        defaultPoolSize() - 1, clamped to selectedAugs.length).
//   useWorkers        : false to force in-process (test default).
//   onProgress(event) : optional. Event shapes:
//     { phase:'aug-iter-start', iter, cap, poolSize, augKinds:[...] }
//     { phase:'aug-progress',   iter, workerId, augKind, emitted }
//     { phase:'aug-done',       iter, workerId, augKind, emitted }
//     { phase:'aug-iter',       iter, total }   (end of iteration)
//
// Browser-safe ESM. No fs/dom imports at the top level.

import {
  packEntries,
  packEntriesAsync,
  unpackEntries,
  unpackEntriesAsync,
  entryCount,
  wrapEntriesSAB,
} from './entries-sab.js';
import {
  emojiIntoWordsContributionPacked,
  wordsIntoEmojiContributionPacked,
} from './aug-impls-sab.js';
import { sortDict, sortDictAsync } from './sortdct.js';
import { createWorker, defaultPoolSize } from '../worker/spawn.js';

const AUG_KINDS = new Set(['eiw', 'wie']);
const AUG_WORKER_URL = new URL('../worker/aug-worker.js', import.meta.url);

export async function runAugsPacked(t0Entries, selectedAugs, opts = {}) {
  if (!Array.isArray(t0Entries)) {
    throw new TypeError('runAugsPacked: t0Entries must be an array');
  }
  if (!Array.isArray(selectedAugs)) {
    throw new TypeError('runAugsPacked: selectedAugs must be an array');
  }
  for (const k of selectedAugs) {
    if (!AUG_KINDS.has(k)) {
      throw new Error(`runAugsPacked: unknown aug kind "${k}"`);
    }
  }
  // Pre-collapse t0 by sortDict before packing. Augs are invariant to
  // collapse: buildIndexesFromPacked builds wordTypes / emojiHomeTypes
  // by adding to a Set per word, and sortDict's comma-split rule means
  // a single (T1,T2,T3, w) collapsed entry produces the same Set as
  // three (T1,w), (T2,w), (T3,w) raw entries. The downstream emit
  // loops iterate `for T of targetTypes`, so collapsing T-sets to one
  // merged-T entry per word cuts inner-loop work by the avg fanout
  // (100×+ on rich session bases at mix=7). Per-aug emits land in
  // merged types; the final sortDict at the orchestrator's caller
  // re-merges them with everything else, identical net result.
  //
  // opts.hashed forwards to sortDict: when true, t0's merged-type
  // strings become 11-char hashes (see typehash.js). Aug emissions
  // then carry hashes as their type field, and the caller's final
  // sortDict (also hashed when opts.hashed is true) sees those hashes
  // as atomic tokens, no comma-split blowup. opts.hashMap is the
  // shared map both sortDict calls populate (caller-side and here),
  // capturing both layers of hashes for later dehash.
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // Yielding pre-collapse sort. The build-session-worker switch
  // routes the new 'sort-build' / 'sort-merge' / 'sort-final' /
  // 'sort-end' phases to load-progress events; the row id includes
  // 'aug-presort' so it doesn't collide with the main base-dict
  // sort row in build-session-worker.
  t0Entries = await sortDictAsync(t0Entries, {
    hashed: !!opts.hashed, hashMap: opts.hashMap,
    onProgress: (e) => onProgress?.({ ...e, sortKind: 'aug-presort' }),
  });

  if (selectedAugs.length === 0) return t0Entries.slice();

  const augOpts = {
    cldr: opts.cldr,
    curatedKeywords: opts.curatedKeywords,
    // Each emoji aug carries its own repetition depth. The dispatch
    // below (runAugInProcess / runAugInWorker) reads eiwMix or wieMix
    // depending on which aug is firing and passes it as `mix`.
    eiwMix: (opts.eiwMix | 0) || 0,
    wieMix: (opts.wieMix | 0) || 0,
    // diagnose / onDiagnose are forwarded only on iter 1 (see dispatch
    // loop below), the t0 input is the meaningful pre-emit fanout.
    diagnose: !!opts.diagnose,
    onDiagnose: typeof opts.onDiagnose === 'function' ? opts.onDiagnose : null,
  };

  // Pack the t0 union into an entries-SAB. On a real-world build this
  // can be 4M+ entries, packEntriesAsync yields every 50K so the
  // build-session-worker stays responsive and progress events flow
  // back to the page.
  const t0View = await packEntriesAsync(t0Entries, {
    onProgress: (e) => onProgress?.(e),
  });

  // contribsByIter[j-1] is a Map<augKind, view> for iteration j.
  const contribsByIter = [];

  let poolSize = opts.poolSize;
  if (poolSize === undefined) poolSize = Math.max(1, defaultPoolSize() - 1);
  poolSize = Math.max(1, Math.min(poolSize, selectedAugs.length));
  // Use a worker even at poolSize=1 so the aug's sync hot loop runs
  // off the build-session-worker's thread; otherwise the
  // augReporter's setTimeout flushes can't fire and the modal goes
  // silent for the whole iteration. Tests that pass useWorkers:false
  // (in-process for assertion convenience) still bypass.
  const useWorkers = opts.useWorkers !== false;
  const workers = useWorkers ? await spawnPool(poolSize) : null;

  const cap = selectedAugs.length + 1;
  try {
    const reportedPoolSize = workers ? workers.length : 1;
    for (let iter = 1; iter <= cap; iter++) {
      if (onProgress) {
        onProgress({
          phase: 'aug-iter-start', iter, cap,
          poolSize: reportedPoolSize, augKinds: selectedAugs.slice(),
        });
      }
      const inputsByKind = buildInputsForIter(iter, selectedAugs, t0View, contribsByIter);
      // Diagnose only on iter 1 so the per-iter fixed-point doesn't
      // re-emit the fanout report on every pass. iter ≥ 2 inputs are
      // OTHER augs' contributions, not the t0 union, so reporting them
      // would mislead about real cost anyway.
      const iterAugOpts = iter === 1
        ? augOpts
        : { ...augOpts, diagnose: false, onDiagnose: null };
      const thisIter = await dispatchIteration(
        workers, selectedAugs, inputsByKind, iterAugOpts, iter, onProgress,
      );

      let totalEmitted = 0;
      for (const k of selectedAugs) totalEmitted += entryCount(thisIter.get(k));
      contribsByIter.push(thisIter);
      if (onProgress) {
        onProgress({ phase: 'aug-iter', iter, total: totalEmitted });
      }
      if (totalEmitted === 0) break;
      if (iter === cap) {
        // eslint-disable-next-line no-console
        console.warn(
          `runAugsPacked: still emitting at theoretical cap (iter ${iter}); ` +
          'accepting current bag',
        );
      }
    }

    // Concat-unpack t0 + every contribution SAB across all iterations.
    // Same 4M+ scale as the pack: unpackEntriesAsync yields every 50K
    // so the merge phase doesn't go silent in the modal.
    const out = await unpackEntriesAsync(t0View, {
      onProgress: (e) => onProgress?.(e),
      label: 't0',
    });
    let layerIdx = 0;
    for (const layer of contribsByIter) {
      layerIdx++;
      for (const k of selectedAugs) {
        const v = layer.get(k);
        if (entryCount(v) === 0) continue;
        const arr = await unpackEntriesAsync(v, {
          onProgress: (e) => onProgress?.(e),
          label: `iter${layerIdx}/${k}`,
        });
        for (const e of arr) out.push(e);
      }
    }
    return out;
  } finally {
    if (workers) {
      await Promise.all(workers.map(w => Promise.resolve(w.terminate())));
    }
  }
}

// ---------- Per-iter input construction ----------
//
// Iter 1: every aug sees [t0].
// Iter i (i>1): aug x sees the list of every OTHER aug's iter-(i-1)
// contribution SAB. Empty SABs are dropped; they don't change indexes.
function buildInputsForIter(iter, selectedAugs, t0View, contribsByIter) {
  const out = new Map();
  if (iter === 1) {
    for (const k of selectedAugs) out.set(k, [t0View]);
    return out;
  }
  const prior = contribsByIter[iter - 2];
  for (const x of selectedAugs) {
    const list = [];
    for (const y of selectedAugs) {
      if (y === x) continue;
      const v = prior.get(y);
      if (entryCount(v) > 0) list.push(v);
    }
    out.set(x, list);
  }
  return out;
}

// ---------- Worker pool ----------

async function spawnPool(size) {
  const ws = await Promise.all(
    Array.from({ length: size }, () => createWorker(AUG_WORKER_URL)),
  );
  return ws;
}

async function dispatchIteration(workers, selectedAugs, inputsByKind, augOpts, iter, onProgress) {
  const out = new Map();
  if (!workers) {
    // In-process: all augs run sequentially as if they shared one
    // worker slot (workerId 1). The aug emits ticks via opts.onTick;
    // the orchestrator forwards them as aug-progress events.
    for (const k of selectedAugs) {
      const tick = onProgress
        ? (emitted) => onProgress({ phase: 'aug-progress', iter, workerId: 1, augKind: k, emitted })
        : null;
      const view = runAugInProcess(k, inputsByKind.get(k), augOpts, tick);
      out.set(k, view);
      if (onProgress) {
        onProgress({
          phase: 'aug-done', iter, workerId: 1, augKind: k, emitted: entryCount(view),
        });
      }
    }
    return out;
  }
  // Worker pool: each worker claims the next aug index off a shared
  // counter, runs it, repeats until claims exhausted. Promise.all over
  // the workers acts as the iteration barrier. workerId is stable
  // across iterations (the pool slot index, 1-based for UX).
  let nextIdx = 0;
  await Promise.all(workers.map(async (w, wIdx) => {
    const workerId = wIdx + 1;
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= selectedAugs.length) return;
      const kind = selectedAugs[myIdx];
      const inputViews = inputsByKind.get(kind);
      const tick = onProgress
        ? (emitted) => onProgress({ phase: 'aug-progress', iter, workerId, augKind: kind, emitted })
        : null;
      const sab = await runAugInWorker(w, kind, inputViews.map(v => v.sab), augOpts, tick);
      const view = wrapEntriesSAB(sab);
      out.set(kind, view);
      if (onProgress) {
        onProgress({
          phase: 'aug-done', iter, workerId, augKind: kind, emitted: entryCount(view),
        });
      }
    }
  }));
  return out;
}

function runAugInProcess(kind, inputViews, augOpts, onTick) {
  // Per-aug mix lookup. The contribution functions accept a single
  // `mix` arg; the pipeline carries eiwMix / wieMix and resolves the
  // right one for the kind being dispatched.
  const base = { ...(augOpts || {}), onTick };
  switch (kind) {
    case 'eiw':   return emojiIntoWordsContributionPacked(inputViews, { ...base, mix: base.eiwMix | 0 });
    case 'wie':   return wordsIntoEmojiContributionPacked(inputViews, { ...base, mix: base.wieMix | 0 });
    default: throw new Error(`runAugInProcess: unknown kind "${kind}"`);
  }
}

function runAugInWorker(worker, kind, inputSabs, augOpts, onTick) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (!data) return;
      // Mid-stream progress ticks: forward and keep listening. Only the
      // terminal {contributionSab|error} message clears the handlers.
      if (data.type === 'progress') {
        if (onTick) onTick(data.emitted);
        return;
      }
      worker.onmessage = null;
      worker.onerror = null;
      if (data.error) reject(new Error(data.error));
      else if (data.contributionSab) resolve(data.contributionSab);
      else reject(new Error('aug-worker: unexpected response shape'));
    };
    worker.onerror = (err) => {
      worker.onmessage = null;
      worker.onerror = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    worker.postMessage({ kind, inputSabs, augOpts });
  });
}
