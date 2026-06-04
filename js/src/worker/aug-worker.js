// aug-worker.js: runs one aug per dispatch against a list of input
// SABs (the prior-iter contributions that form this aug's input layer).
//
// Message-in:  { kind, inputSabs: SharedArrayBuffer[], augOpts }
// Message-out: a stream of { type:'progress', kind, emitted } as the aug
//              ticks through its emit loop, terminated by exactly one
//              { contributionSab: SharedArrayBuffer } (success) or
//              { error: string } (failure).
//
// The SABs are shared by reference; no transfer is required. The
// worker stays alive across dispatches so the parent pool can recycle
// it. See docs/research-notes.md §18.4.
//
// Browser-safe ESM. Uses parent-port.js to abstract over the
// browser/Node worker entry-point convention.

import { parentPort } from './parent-port.js';
import { wrapEntriesSAB } from '../builder/entries-sab.js';
import {
  emojiIntoWordsContributionPacked,
  wordsIntoEmojiContributionPacked,
} from '../builder/aug-impls-sab.js';

parentPort.onMessage((msg) => {
  try {
    const { kind, inputSabs, augOpts } = msg;
    const inputViews = inputSabs.map(sab => wrapEntriesSAB(sab));
    const onTick = (emitted) => {
      parentPort.postMessage({ type: 'progress', kind, emitted });
    };
    // Per-aug mix lookup: augOpts carries eiwMix / wieMix; each
    // contribution function takes a single `mix` arg.
    const base = { ...(augOpts || {}), onTick };
    let out;
    switch (kind) {
      case 'eiw':   out = emojiIntoWordsContributionPacked(inputViews, { ...base, mix: base.eiwMix | 0 }); break;
      case 'wie':   out = wordsIntoEmojiContributionPacked(inputViews, { ...base, mix: base.wieMix | 0 }); break;
      default: throw new Error(`aug-worker: unknown kind "${kind}"`);
    }
    parentPort.postMessage({ contributionSab: out.sab });
  } catch (e) {
    parentPort.postMessage({ error: String((e && e.stack) || e) });
  }
});

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// all imports + handler registration; createWorker() awaits this
// before resolving. Forgetting this line will hang createWorker().
parentPort.postMessage({ type: 'ready' });
