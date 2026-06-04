// On-demand engine worker. Handles ONE job (load / encode / decode)
// per spawn, posts a single result message, and is terminated by the
// parent. Encode and decode jobs are now stream-driven: the parent
// passes two MessagePorts in the job message , one for the input
// byte stream, one for the output byte stream , and the engine runs
// over those ports via portReadable / portWritable.
//
// See docs/architecture-workers.md for the on-demand model.

import { parentPort } from './parent-port.js';
import { wrapDictionaryFromSAB } from '../dictionary.js';
import { unpackRewriterMap } from '../builder/rewriter-sab.js';
import {
  wrapModelTableFromSAB,
  modelTableStream,
} from '../modeltable.js';
import {
  wrapGrammarFromSAB,
  modelStream as grammarModelStream,
} from '../grammar/expand.js';
import { weightedTypeStream } from '../typestream.js';
import { encode } from '../encode.js';
import { decode } from '../decode.js';
import { mulberry32 } from '../random.js';
import { portReadable, portWritable } from './streams.js';

// Per-job AbortController for the round-trip-self-check skip. Created
// at the start of each encode job; the 'skipValidation' parent message
// fires the abort. Encode() reads the signal and detaches its
// validator branch (stops the in-worker decode and removes the
// validator-side backpressure on the fan-out writer).
let encodeSkipValidationController = null;

parentPort.onMessage(async (msg) => {
  try {
    if (msg.type === 'encode') return await handleEncode(msg);
    if (msg.type === 'decode') return await handleDecode(msg);
    if (msg.type === 'skipValidation') {
      if (encodeSkipValidationController) {
        try { encodeSkipValidationController.abort(); } catch {}
      }
      return;
    }
    parentPort.postMessage({ type: 'error', error: `unknown message type ${msg.type}` });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'cancelled') {
      // Aborts are signalled to the parent via the streams themselves
      // (input.abort or output.cancel propagated the error). No
      // additional control message is needed.
      return;
    }
    parentPort.postMessage({ type: 'error', error: err?.message ?? String(err) });
  }
});

function buildStreamForEncode(msg, dict) {
  const streamSeed = msg.streamSeed ?? 0xDEADBEEF;
  const rng = mulberry32(streamSeed);
  if (msg.grammarSab) {
    const grammar = wrapGrammarFromSAB(msg.grammarSab);
    return {
      modelStream: grammarModelStream(grammar, {
        random: rng,
        maxLength: msg.maxLength,
        dict,
      }),
    };
  }
  if (msg.modelSab) {
    const table = wrapModelTableFromSAB(msg.modelSab);
    return {
      modelStream: modelTableStream(table, {
        random: rng,
        mode: msg.mode ?? 'random',
        dict,
      }),
    };
  }
  return {
    typeStream: weightedTypeStream(dict, { random: rng }),
  };
}

async function handleEncode(msg) {
  const dict = wrapDictionaryFromSAB(msg.dictSab);
  const streamOpts = buildStreamForEncode(msg, dict);
  const onProgress = async (info) => {
    parentPort.postMessage({ type: 'progress', info });
  };
  // Validate-pass progress (round-trip self-check decode) rides on a
  // separate message type so the parent can drive a second progress
  // bar without disambiguating which pass an event came from.
  const onValidateProgress = async (info) => {
    parentPort.postMessage({ type: 'validateProgress', info });
  };
  const input = portReadable(msg.inputPort);
  const output = portWritable(msg.outputPort, { transfer: true });

  encodeSkipValidationController = new AbortController();
  try {
    await encode(input, output, dict, {
      ...streamOpts,
      randomSeed: msg.randomSeed ?? 0xC0FFEE,
      onProgress,
      onValidateProgress,
      skipValidationSignal: encodeSkipValidationController.signal,
      // Cover-transforms rewriter chain. byos universal `{enabled,
      // intensity, mode?}` per-field shape; encoder's chain wiring
      // resolves enabled rewriters into a tight per-emission hook.
      // Absent / null = no rewriters (the default path).
      rewriter: msg.rewriter ?? null,
      // Apply-time NTRW lookup data per enabled rewriter, unpacked
      // from the per-rewriter .rewriter.sab.gz SABs jobs.js loaded
      // and forwarded. Shape: { <name>: Map<string, Set<string>> }.
      // encode() dispatches setRewriterData(map) for each enabled
      // rewriter that supplied data; modules without data fall back
      // to their own default behavior (xanax: strict-ortho only;
      // others: no-op).
      rewriterData: msg.rewriterSabs
        ? Object.fromEntries(
            Object.entries(msg.rewriterSabs).map(([name, sab]) => [name, unpackRewriterMap(sab)]))
        : null,
      // Cover-transforms reformatter chain (byos universal shape).
      // Forwarded straight to encode() which wraps the model stream
      // with wrapModelStreamWithReformatters before consumption.
      // Streaming is preserved end-to-end, the previous post-encode
      // buffer-and-format path is gone.
      reformatter: msg.reformatter ?? null,
      // Apply-time data per reformatter (currently only voice ships
      // a fixture). Same NTRW shape as rewriter SABs; unpack to
      // Map<category, Set<typename>> for the voice enhancer.
      reformatterData: msg.reformatterSabs
        ? Object.fromEntries(
            Object.entries(msg.reformatterSabs).map(([name, sab]) => [name, unpackRewriterMap(sab)]))
        : null,
    });
  } finally {
    encodeSkipValidationController = null;
  }
}

async function handleDecode(msg) {
  const dict = wrapDictionaryFromSAB(msg.dictSab);
  const onProgress = async (info) => {
    parentPort.postMessage({ type: 'progress', info });
  };
  const input = portReadable(msg.inputPort);
  const output = portWritable(msg.outputPort, { transfer: true });
  await decode(input, output, dict, { onProgress });
}

// Ready protocol (see js/src/worker/spawn.js). Last statement after
// all imports + handler registration; createWorker() awaits this
// before resolving. Forgetting this line will hang createWorker().
parentPort.postMessage({ type: 'ready' });
