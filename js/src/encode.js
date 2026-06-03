// NICETEXT: embed bits to cover text. Streaming surface, streaming internals.
//
// encode(input, output, dict, opts) reads payload bytes from a
// ReadableStream<Uint8Array> via streamWrap (which feeds an
// AsyncBitReader: escaped input chunks, then the EOF marker, then a
// randomBits tail) and writes UTF-8 cover-text bytes to a
// WritableStream<Uint8Array>. No drain, no whole-payload buffering.
//
// Browser-safe ESM. No Node deps.

import { streamWrap } from './stream.js';
import { mulberry32 } from './random.js';
import { createFormatter } from './grammar/format.js';
import { lookupType, lookupTypeByName, readTreeNode, TREE_NO_NODE } from './dictionary.js';
import { Fingerprint, fingerprintSink } from './fingerprint.js';
import { decode } from './decode.js';
import { wrapModelStreamWithReformatters, dispatchReformatterSetup } from './reformatter/index.js';

// Cover-transforms rewriter chain (docs/cover-transforms.md). Order is
// fixed: british -> typos -> voice -> xanax.
// Each module exports apply(phraseBuf) plus an optional setRewriter
// Data(map) hook for rewriters whose apply() consults the universal
// NTRW lookup (Map<string, Set<string>>). The encoder invokes apply()
// after every phraseBuf push, gated by the boolean field in
// opts.rewriter; the engine's natural per-push analyzePhraseBuf
// rewind path catches any phrase-fusion conflict created by a
// mutation, so individual rewriters don't need their own check.
//
// Rewriter apply-time data is passed in via opts.rewriterData (an
// object keyed by rewriter name, values are Map<string, Set<string>>
// already unpacked from each fixtures/<name>.rewriter.sab.gz). encode
// dispatches setRewriterData() per enabled rewriter at the start of
// each call. Callers that don't supply rewriterData (e.g., unit
// tests that don't exercise CMU-driven xanax behavior) get the
// fallback path inside each rewriter, for xanax that's strict-
// orthographic only; other rewriters degrade to no-op.
import * as britishRw   from './rewriter/british.js';
import * as typosRw     from './rewriter/typos.js';
import * as voiceRw     from './rewriter/voice.js';
import * as xanaxRw     from './rewriter/xanax.js';

const REWRITER_CHAIN = [
  ['british',   britishRw],
  ['typos',     typosRw],
  ['voice',     voiceRw],
  ['xanax',     xanaxRw],
];

const DEFAULT_MIN_EXTRA_BITS = 64;
// Safety cap when walking the per-type Huffman tree. No legitimate code
// should exceed this (master + uniform Huffman maxes around log2(N)~16;
// frequency-weighted Huffman on natural-language Zipf maxes ~25).
const MAX_HUFFMAN_BITS = 48;

// Wrap a flat type stream as a model stream. Each "model" is a single type slot.
// typeStream.next() yields {typeIndex, wordCount}; encode.resolveType uses
// only typeIndex (looks up the rest from the SAB).
export function typeStreamAsModelStream(typeStream) {
  return {
    next() {
      const t = typeStream.next();
      return [{ kind: 'type', typeIndex: t.typeIndex }];
    },
  };
}

// Returns the resolved type record (full typeRec from dictionary.js), or
// null if the type isn't in the dict. Skip-mode: the encoder drops the
// slot, no bits read, no word emitted, preserving round-trip safety
// because the same dict on decode also won't know the type and the
// cover text won't contain the corresponding word. A defined typeIndex
// that misses signals internal corruption, not a dict-mismatch, so it
// still throws.
function resolveType(dict, item) {
  if (item.typeIndex !== undefined && item.typeIndex !== null) {
    const rec = lookupType(dict, item.typeIndex);
    if (!rec) throw new Error(`encode: typeIndex ${item.typeIndex} not in dictionary`);
    return rec;
  }
  if (!item.name) return null;
  return lookupTypeByName(dict, item.name);
}

// Yield + onProgress cadence. Every YIELD_EVERY models the engine
// drains the formatter into the output stream, calls onProgress for
// progress reporting, and yields to the macrotask queue so any
// pending port-backed cancel can be delivered to a worker running
// this loop.
const YIELD_EVERY = 64;

// State-only puncts: their fmt.emitPunct sets formatter state
// (capitalize next word, etc.) but emits ZERO characters into cover.
// They therefore CANNOT create a phrase-fusion barrier between two
// adjacent WORD picks at decode time. The encoder defers these into
// phraseBuf so analyzePhraseBuf sees through them; the actual
// emitPunct fires when the buffer flushes (or is dropped on rewind,
// in which case the state effect never happens, keeping the cover
// and formatter state consistent).
const STATE_ONLY_PUNCTS = new Set(['Cap', 'CAPSLOCKON', 'capslockoff']);
function isStateOnlyPunct(value) {
  return STATE_ONLY_PUNCTS.has(value);
}

// Public surface. When `validate` is true (the default) the encode
// path is wrapped in a concurrent self-check: source bytes are
// fingerprinted as they stream in, the cover output is tee'd to a
// concurrent decode() that fingerprints the recovered bytes, and at
// the end the two digests are compared. On mismatch the caller's
// `output` writable is aborted with the validation error so any
// downstream stream consumer surfaces the failure as a stream error,
// and encode() throws the same error for in-process callers.
//
// Pass `validate: false` to skip the self-check (benchmarks, perf
// tests). Round-trip-recoverability is the only critical function of
// nicetext, so default-on matches the project invariant.
export async function encode(input, output, dict, opts = {}) {
  return _encodeWithDecode(decode, input, output, dict, opts);
}

// Internal seam: same as encode() but lets callers inject a custom
// decode function for the validate path. Production code calls
// encode(); tests use this to drive failure paths (e.g., a stub
// decode that emits wrong bytes so the digest comparison diverges).
export async function _encodeWithDecode(decodeFn, input, output, dict, opts = {}) {
  const {
    validate = true,
    onProgress = null,
    onValidateProgress = null,
    // skipValidationSignal: AbortSignal, when fired mid-job, detach
    // the validator side: cancel the validator's input, swallow the
    // resulting decode rejection, and skip the digest comparison at
    // the end. Encode then races ahead at user-writer speed without
    // the safety net. Equivalent to validate:false but selectable
    // after the job has already begun. (Audit follow-up 2026-05-18:
    // explicit per-job opt-out for users who need a slow encode to
    // complete sooner.)
    skipValidationSignal = null,
    ...coreOpts
  } = opts;

  if (!validate) {
    return _encodeCore(input, output, dict, { ...coreOpts, onProgress });
  }

  const sourceFp = new Fingerprint();
  const sourceTap = new TransformStream({
    transform(chunk, controller) {
      sourceFp.update(chunk);
      controller.enqueue(chunk);
    },
  });
  // Cover fan-out via explicit byte-copy, NOT ReadableStream.tee().
  // tee() shares chunk references between branches; downstream sinks
  // that transfer the chunk's ArrayBuffer (e.g., the worker
  // plumbing's portWritable in transfer mode) detach the buffer,
  // leaving the other branch reading zero-length chunks. Copying
  // each chunk into an independent Uint8Array keeps the user-side
  // and validator-side buffers fully decoupled.
  //
  // Backpressure: the validator branch is a TransformStream, not a
  // free-running manual ReadableStream. fanoutWritable.write awaits
  // both branches in parallel, so the encoder paces to the slower of
  // (user-side writer, validator decode). Without this, when decode
  // lags encode (the common case, since decode is a parser) the
  // validator queue grew unbounded inside the worker, ballooning
  // per-worker memory until new-worker spawn failed under multi-file
  // pipeline loads.
  const validatorTransform = new TransformStream();
  const validatorReadable = validatorTransform.readable;
  const validatorWriter = validatorTransform.writable.getWriter();
  const decodedSink = fingerprintSink();
  const userWriter = output.getWriter();

  // Mid-job skip: when the skipValidationSignal fires we detach the
  // validator side entirely (a) so decode stops eating CPU in the
  // worker and (b) so the encoder no longer paces to it, encode then
  // races at user-writer speed. `validatorSkipped` is the latch:
  // - cancel validatorReadable → decode's read() rejects, decode
  //   throws and exits its loop.
  // - abort validatorWriter → any in-flight write resolves; future
  //   writes are skipped (the fanoutWritable below early-returns).
  // - the digest comparison at the end short-circuits.
  let validatorSkipped = false;
  let skipListener = null;
  const detachValidator = () => {
    if (validatorSkipped) return;
    validatorSkipped = true;
    const reason = new Error('validation-skipped');
    // Aborting the writer is the only safe-from-outside termination
    // path: validatorReadable is locked by decode's reader, so a
    // direct cancel() throws ReadableStream-is-locked. The abort
    // propagates as a read rejection inside decode → decode's loop
    // unwinds and exits, which is what we want (engine worker CPU
    // freed). swallow any async rejection from the abort itself.
    Promise.resolve(validatorWriter.abort(reason)).catch(() => {});
  };
  if (skipValidationSignal) {
    if (skipValidationSignal.aborted) {
      detachValidator();
    } else {
      skipListener = () => detachValidator();
      skipValidationSignal.addEventListener('abort', skipListener, { once: true });
    }
  }

  // The user-facing close fires AFTER the digest comparison, not when
  // the inner encode finishes writing. On mismatch we abort the user
  // writer with the validation error instead of closing it. This
  // makes failure propagate through the user's stream as a normal
  // stream error (port-backed writables forward the abort across the
  // worker boundary), instead of racing with worker termination on
  // a side channel.
  const fanoutWritable = new WritableStream({
    async write(chunk) {
      // After skip: only the user-writer is awaited, encode runs at
      // user-writer speed without the validator backpressure.
      if (validatorSkipped) {
        await userWriter.write(chunk);
        return;
      }
      // Validator-side writes are best-effort. Decode cancels its
      // input the moment it sees the EOF marker (unwrap.done), so any
      // encoder bytes produced after that point cause validatorWriter
      // to reject. That's an expected end-of-validation signal, not a
      // real failure, the fingerprint is already complete. Swallow
      // the rejection here so the user-side write still paces the
      // encoder. Genuine validator failures (decode threw) surface
      // through the awaited validatePromise below.
      await Promise.all([
        validatorWriter.write(new Uint8Array(chunk)).catch(() => {}),
        userWriter.write(chunk),
      ]);
    },
    async close() {
      try { await validatorWriter.close(); } catch {}
    },
    async abort(err) {
      try { await validatorWriter.abort(err); } catch {}
      return userWriter.abort(err);
    },
  });

  const tappedInput = input.pipeThrough(sourceTap);
  const innerEncodePromise = _encodeCore(
    tappedInput,
    fanoutWritable,
    dict,
    { ...coreOpts, onProgress },
  );
  const validatePromise = decodeFn(
    validatorReadable,
    decodedSink.writable,
    dict,
    { onProgress: onValidateProgress },
  );

  try {
    // After skip, the validator branch will reject (cancelled input).
    // Swallow it, encode-side is the only branch whose completion
    // matters once we've detached.
    await Promise.all([
      innerEncodePromise,
      validatePromise.catch((err) => {
        if (validatorSkipped) return;
        throw err;
      }),
    ]);
  } catch (err) {
    try { await validatorWriter.abort(err); } catch {}
    try { await userWriter.abort(err); } catch {}
    try { userWriter.releaseLock(); } catch {}
    if (skipListener && skipValidationSignal) {
      skipValidationSignal.removeEventListener('abort', skipListener);
    }
    throw err;
  }
  if (skipListener && skipValidationSignal) {
    skipValidationSignal.removeEventListener('abort', skipListener);
  }
  // Skipped: short-circuit the digest comparison and close the user
  // writer normally. The cover is delivered without the safety net,
  // by the user's explicit, per-job opt-in.
  if (validatorSkipped) {
    try { await userWriter.close(); } catch {}
    try { userWriter.releaseLock(); } catch {}
    return;
  }

  const srcDigest = sourceFp.digest();
  const decDigest = decodedSink.fingerprint.digest();
  if (srcDigest !== decDigest) {
    const err = new Error(
      `encode: round-trip validation failed ` +
      `(source 0x${srcDigest.toString(16).padStart(8, '0')} ` +
      `vs decoded 0x${decDigest.toString(16).padStart(8, '0')})`
    );
    try { await userWriter.abort(err); } catch {}
    try { userWriter.releaseLock(); } catch {}
    throw err;
  }

  try { await userWriter.close(); } finally {
    try { userWriter.releaseLock(); } catch {}
  }
}

async function _encodeCore(input, output, dict, opts = {}) {
  const {
    typeStream,
    modelStream,
    randomSeed = 0xC0FFEE,
    minExtraBits = DEFAULT_MIN_EXTRA_BITS,
    onProgress = null,
    rewriter: rewriterFlags = null,
    rewriterData = null,
    // Cover-transforms reformatter block (byos universal `{enabled,
    // intensity, mode?}` per-field shape). When present, the model
    // stream is wrapped via wrapModelStreamWithReformatters before
    // consumption: every enabled field's enhance() is applied to
    // each model in chain order (voice -> lineBreak -> sentenceEnd
    // -> case). Absent or every-field-disabled is a zero-cost
    // short-circuit.
    reformatter = null,
    // Per-reformatter apply-time data, keyed by reformatter name.
    // Voice consumes the unpacked Map<category, Set<typename>> from
    // fixtures/voice-<mode>-categories.rewriter.sab.gz before any
    // enhance() runs; pure-code reformatters (case / lineBreak /
    // sentenceEnd) ignore it.
    reformatterData = null,
  } = opts;

  // Pre-resolve which rewriters are enabled into a tight chain.
  // rewriterFlags carries the byos universal `{enabled, intensity,
  // mode?}` per-field shape; a field is active when enabled is true
  // AND intensity > 0. Skipped entirely (no per-push iteration cost)
  // when no field is active or opts.rewriter is omitted.
  const enabledRewriters = rewriterFlags
    ? REWRITER_CHAIN.filter(([name]) => {
        const f = rewriterFlags[name];
        return f && f.enabled === true
          && Number.isInteger(f.intensity) && f.intensity > 0;
      })
    : [];

  // Dispatch per-encode configuration to each enabled rewriter:
  //   setRewriterData(map)      apply-time NTRW Map (from opts.rewriter
  //                             Data[name]), optional per module
  //   setRewriterIntensity(n)   integer 0..100 from opts.rewriter[name]
  //                            : gates apply()'s replacement-probability
  //                             coin flip
  //   setRewriterRandom(rng)    non-secret RNG derived from randomSeed,
  //                             shared across all rewriters in this
  //                             encode so the coin flips are reproducible
  // Modules without one of the setters are skipped silently; their
  // apply() falls back to whatever default behavior they implement for
  // unset config.
  const rewriterRng = mulberry32((randomSeed | 0) ^ 0xA1B2C3D4);
  for (const [name, mod] of enabledRewriters) {
    if (rewriterData && rewriterData[name] && typeof mod.setRewriterData === 'function') {
      mod.setRewriterData(rewriterData[name]);
    }
    if (typeof mod.setRewriterIntensity === 'function') {
      mod.setRewriterIntensity(rewriterFlags[name].intensity);
    }
    if (typeof mod.setRewriterRandom === 'function') {
      mod.setRewriterRandom(rewriterRng);
    }
  }

  const runRewriterChain = enabledRewriters.length === 0
    ? () => {}
    : (phraseBuf) => {
        for (const [, mod] of enabledRewriters) mod.apply(phraseBuf);
      };

  let stream = modelStream;
  if (!stream && typeStream) stream = typeStreamAsModelStream(typeStream);
  if (!stream) throw new Error('encode: typeStream or modelStream required');

  // Cover-transforms reformatter chain. Wrap the model stream so each
  // enabled enhancer mutates the model before the consumption loop
  // sees it; chain composition is left-to-right. The rng is derived
  // from randomSeed (xor'd with a distinct constant so the
  // reformatter coin flips don't co-vary with the rewriter chain).
  if (reformatter) {
    const reformatterRng = mulberry32((randomSeed | 0) ^ 0x52464D54);
    // Reformatters that need apply-time data (today: voice) expose
    // the same setRewriter{Data,Random,Intensity} surface as the
    // rewriter modules. Dispatch once before the stream wrapper
    // captures the rng; modules with no setter are skipped silently.
    dispatchReformatterSetup(reformatter, reformatterData, reformatterRng, dict);
    stream = wrapModelStreamWithReformatters(stream, reformatter, reformatterRng);
  }

  const writer = output.getWriter();
  const textEnc = new TextEncoder();
  let lastEmittedChar = null;
  async function pumpOut(text) {
    if (!text) return;
    lastEmittedChar = text[text.length - 1];
    await writer.write(textEnc.encode(text));
  }

  try {
    const rng = mulberry32(randomSeed);
    const reader = streamWrap(input, { randomBits: rng });
    const fmt = createFormatter();
    const isGrammarMode = !!modelStream;

    // Step 4 (phrase-and-charset arc): peek-and-buffer with backtrack
    // so independent slot picks can't accidentally form a phrase entry
    // in cover that the decoder would fuse, bit accounting would
    // otherwise break. Buffer holds recent single-WORD candidates with
    // their consumed-bit lists; pushbackBits replays bits when a
    // matched span rewinds.
    const phraseIndex = dict.phraseIndex || new Map();
    const maxPhraseLen = dict.maxPhraseLen || 0;
    const phraseBuf = []; // [{ word, slotBits }]
    const pushbackBits = []; // bits (0 | 1) to consume before pulling from reader

    // Diagnostic gate: NICETEXT_DEBUG_ENCODE=1 enables stderr trace
    // of every readBit source, every phraseBuf push, and every
    // tryFlushOrRewind decision. Off by default; only active in Node.
    const _DBG = (typeof process !== 'undefined') && process.env && process.env.NICETEXT_DEBUG_ENCODE === '1';
    let _bitCounter = 0;
    function _log(...args) { if (_DBG) process.stderr.write(args.join(' ') + '\n'); }

    async function readBit(slotBits) {
      let bit;
      let src;
      if (pushbackBits.length > 0) {
        bit = pushbackBits.shift();
        src = 'pushback';
      } else {
        if (!reader.hasBits(1)) await reader.refill();
        bit = reader.readBitsSync(1);
        src = 'wire';
      }
      slotBits.push(bit);
      if (_DBG) _log(`  readBit#${_bitCounter} src=${src} bit=${bit} pushback-remaining=${pushbackBits.length}`);
      _bitCounter++;
      return bit;
    }

    function flushBuffer() {
      while (phraseBuf.length > 0) {
        const _e = phraseBuf.shift();
        if (_e.kind === 'state') {
          { if (_DBG) _log(`EMITPUNCT[buf] ${JSON.stringify(_e.value)}`); fmt.emitPunct(_e.value); }
        } else {
          { if (_DBG) _log(`EMITWORD "${_e.word}"`); fmt.emitWord(_e.word); }
        }
      }
    }

    // Local greedy phrase-fuse over flat parts. Mirrors the lexer's
    // phraseFuse so we can predict, before committing cover bytes,
    // exactly how the decoder will tokenize the buffer if emitted.
    // If predicted tokens don't match the encoder's atomic picks (one
    // token per buffered entry) the bits don't balance, rewind.
    function greedyFuseFlat(flat) {
      const tokens = [];
      let i = 0;
      while (i < flat.length) {
        const candidates = phraseIndex.get(flat[i]);
        let bestLen = 1;
        if (candidates) {
          for (const cand of candidates) {
            const L = cand.parts.length;
            if (L > bestLen && i + L <= flat.length) {
              let allMatch = true;
              for (let j = 0; j < L; j++) {
                if (cand.parts[j] !== flat[i + j]) { allMatch = false; break; }
              }
              if (allMatch) bestLen = L;
            }
          }
        }
        tokens.push(flat.slice(i, i + bestLen).join(' '));
        i += bestLen;
      }
      return tokens;
    }

    // Returns 'complete-match' | 'strict-prefix' | 'no-prefix' for the
    // current phraseBuf state.
    //   complete-match: cover-side greedy fusion of the buffered
    //     entries does NOT reproduce the encoder's atomic picks
    //     (one fused token per buf entry). Bit accounting would
    //     break: rewind every entry's slotBits.
    //   strict-prefix: fusion currently aligns with picks, but the
    //     buffer's flat parts are a prefix of some longer phrase
    //     entry. Holding lets a future slot disambiguate before any
    //     cover bytes commit.
    //   no-prefix: fusion aligns and no longer phrase can extend.
    //     Safe to flush the oldest entry to cover.
    // The greedy comparison covers both the original "two single-word
    // slots accidentally fuse" case AND the previously-uncaught
    // "single-word(s) plus a multi-word atomic emit fuse into a
    // longer phrase" case (encode.js line 221 path), because both
    // single-word and multi-word picks now enter the buffer with
    // their parts list before any cover bytes are emitted.
    function analyzePhraseBuf() {
      if (phraseBuf.length === 0 || phraseIndex.size === 0) return 'no-prefix';
      // Filter out state-only entries: they don't produce cover bytes,
      // so they can't appear in the lexer's token stream and thus
      // can't affect the decoder's phrase fusion. The flat parts list
      // and picks list both ignore them.
      const flat = [];
      const picks = [];
      for (const e of phraseBuf) {
        if (e.kind === 'state') continue;
        flat.push(...e.parts);
        picks.push(e.parts.join(' '));
      }
      if (flat.length === 0) return 'no-prefix';
      const fused = greedyFuseFlat(flat);
      let mismatch = fused.length !== picks.length;
      if (!mismatch) {
        for (let i = 0; i < fused.length; i++) {
          if (fused[i] !== picks[i]) { mismatch = true; break; }
        }
      }
      if (mismatch) return 'complete-match';
      const candidates = phraseIndex.get(flat[0]);
      if (candidates) {
        for (const cand of candidates) {
          if (cand.parts.length > flat.length) {
            let allMatch = true;
            for (let i = 0; i < flat.length; i++) {
              if (cand.parts[i] !== flat[i]) { allMatch = false; break; }
            }
            if (allMatch) return 'strict-prefix';
          }
        }
      }
      return 'no-prefix';
    }

    // After pushing a candidate to phraseBuf, decide what to do:
    //   - complete-match → rewind all bits in matched span, drop entries
    //     from buffer, return (this slot effectively skipped, no emit).
    //   - strict-prefix → hold (don't emit yet, wait for more slots).
    //   - no-prefix → flush oldest, recheck (until empty or a prefix).
    function tryFlushOrRewind() {
      while (phraseBuf.length > 0) {
        const result = analyzePhraseBuf();
        if (_DBG) _log(`tryFlushOrRewind: buf=[${phraseBuf.map(e => e.kind === 'state' ? `<${e.value}>` : `"${e.word}"`).join(', ')}] result=${result}`);
        if (result === 'complete-match') {
          // Push word-entries' slotBits back onto the pushback queue
          // in original read order; state-only entries are simply
          // dropped (their emitPunct was never called, so the
          // formatter state never moved, nothing to reverse). The
          // model items they came from are likewise consumed.
          const allBits = [];
          for (const e of phraseBuf) {
            if (e.kind === 'state') continue;
            allBits.push(...e.slotBits);
          }
          if (_DBG) _log(`  REWIND: pushing back ${allBits.length} bits [${allBits.join(',')}] from words [${phraseBuf.filter(e => e.kind !== 'state').map(e => '"' + e.word + '"').join(', ')}]`);
          pushbackBits.unshift(...allBits);
          phraseBuf.length = 0;
          return;
        }
        if (result === 'strict-prefix') return;
        // no-prefix: flush oldest and recheck the shorter buffer.
        const _e = phraseBuf.shift();
        if (_DBG) _log(`  FLUSH: ${_e.kind === 'state' ? `<${_e.value}>` : `"${_e.word}"`}`);
        if (_e.kind === 'state') {
          { if (_DBG) _log(`EMITPUNCT[buf] ${JSON.stringify(_e.value)}`); fmt.emitPunct(_e.value); }
        } else {
          { if (_DBG) _log(`EMITWORD "${_e.word}"`); fmt.emitWord(_e.word); }
        }
      }
    }

    const MAX_NO_PROGRESS_MODELS = 256;
    let modelsSinceProgress = 0;
    let inForceDynamicMode = false;
    let modelsProcessed = 0;
    for (;;) {
      if (reader.exhausted && reader.tailBitsRead >= minExtraBits) break;
      // Two-stage no-progress guard.
      //   Stage 1: in normal mode, after MAX_NO_PROGRESS_MODELS picks
      //     that consumed zero bits, switch to force-dynamic mode.
      //     This handles the "model picker kept landing on statics"
      //     case.
      //   Stage 2: in force-dynamic mode, the encoder is pulling
      //     guaranteed-dynamic models but STILL not progressing.
      //     That means downstream logic (phrase-fusion rewinds,
      //     nested-prefix dicts) is erasing every pick's bits.
      //     Force-dynamic can't help here, throw.
      // Any successful progress resets the streak AND exits
      // force-dynamic mode (return to normal picking for variety).
      if (modelsSinceProgress > MAX_NO_PROGRESS_MODELS) {
        if (inForceDynamicMode) {
          throw new Error(
            `encode: ${MAX_NO_PROGRESS_MODELS} models picked without consuming any bits ` +
            `even after switching to force-dynamic mode; the dictionary likely has too ` +
            `few multi-word types to encode the payload, or every pick rewinds.`
          );
        }
        inForceDynamicMode = true;
        modelsSinceProgress = 0;
      }
      const bitsBefore = reader.bitsRead;
      const model = stream.next({ forceDynamic: inForceDynamicMode });
      for (const itemRaw of model) {
        if (itemRaw.kind === 'punct') {
          if (phraseIndex.size > 0 && isStateOnlyPunct(itemRaw.value)) {
            // State-only puncts (Cap, CAPSLOCKON, capslockoff) emit
            // no cover bytes, so they cannot create a fusion barrier
            // for the decoder. Defer them into the buffer along with
            // the words. analyzePhraseBuf filters them when computing
            // flat parts; flushBuffer / no-prefix flush emit them in
            // order; complete-match rewind simply discards them.
            phraseBuf.push({ kind: 'state', value: itemRaw.value, slotBits: [] });
            continue;
          }
          // PUNCT/EOS that DOES emit to cover clears phrase fusion
          // barrier (matches decoder, whose lexer will produce a
          // PUNCT/WHITESPACE/EOS token at this position).
          flushBuffer();
          if (_DBG) _log(`EMITPUNCT[direct] ${JSON.stringify(itemRaw.value)}`);
          fmt.emitPunct(itemRaw.value);
          continue;
        }
        const typeRec = resolveType(dict, itemRaw);
        if (typeRec === null) continue; // skip-mode: type not in dict, drop the slot
        // Walk the Huffman tree from root, one bit at a time until we hit
        // a leaf. For a single-word type the root IS the leaf (wordCount=1,
        // bits=0, no children) so the loop never executes and we emit
        // root.word directly. No special case needed.
        const slotBits = [];
        let node = readTreeNode(dict, typeRec, 0);
        let bits = 0;
        while (bits < MAX_HUFFMAN_BITS && node.word === null) {
          const bit = await readBit(slotBits);
          bits++;
          const childIdx = bit === 0 ? node.leftChild : node.rightChild;
          if (childIdx === TREE_NO_NODE) {
            throw new Error(
              `encode: invalid path in Huffman tree for type ${typeRec.typeIndex} at bit ${bits}`
            );
          }
          node = readTreeNode(dict, typeRec, childIdx);
        }
        if (node.word === null) {
          throw new Error(
            `encode: walked ${MAX_HUFFMAN_BITS} bits for type ${typeRec.typeIndex} without hitting a leaf, corrupt dict?`
          );
        }
        const candidate = node.word;
        // Both single-word and multi-word picks enter the buffer with
        // their lowercased parts list, so analyzePhraseBuf can run
        // greedy cover-side fusion on the buffered span and detect any
        // accidental phrase formation BEFORE bytes commit. The previous
        // "multi-word emits atomically, no buffer" fast path failed to
        // catch flushed-buffer + atomic-multiword combinations forming
        // a longer phrase entry under nested-prefix dicts.
        if (phraseIndex.size === 0 && enabledRewriters.length === 0) {
          // Fast path: dict has no phrases AND no rewriter chain needs
          // to inspect the buffer, so skip the buffer entirely.
          if (_DBG) _log(`EMITWORD[fast] "${candidate}"`);
          fmt.emitWord(candidate);
        } else {
          const parts = candidate.toLowerCase().split(' ');
          if (_DBG) _log(`PHRASEBUF push "${candidate}" slotBits=[${slotBits.join(',')}] bits=${slotBits.length}`);
          phraseBuf.push({ word: candidate, parts, slotBits });
          // Cover-transforms rewriter chain (per-emission, fixed order).
          // No-op when no rewriter is enabled; otherwise each enabled
          // rewriter inspects the buffer and may mutate entries.
          // tryFlushOrRewind below catches any phrase-fusion conflict a
          // mutation creates via its standard rewind path.
          runRewriterChain(phraseBuf);
          tryFlushOrRewind();
        }
      }
      const bitsAfter = reader.bitsRead;
      if (bitsBefore === bitsAfter) {
        modelsSinceProgress++;
      } else {
        modelsSinceProgress = 0;
        // Made progress: drop back to normal picking (statics
        // contribute cover variety; force-dynamic was only a
        // safety net for the stuck case).
        inForceDynamicMode = false;
      }

      modelsProcessed++;
      if (modelsProcessed % YIELD_EVERY === 0) {
        // Drain the formatter at every cadence checkpoint, but keep
        // phraseBuf intact across drains, phrases can span model
        // boundaries (only PUNCT/EOS clears the buffer).
        await pumpOut(fmt.drain());
        if (onProgress) {
          try { await onProgress({ modelsProcessed, bitsRead: reader.bitsRead }); } catch {}
        }
        // Macrotask yield so port-backed cancel messages can be delivered
        // to a worker running this loop. WritableStream.write resolves on
        // the microtask queue when the underlying sink returns synchronously,
        // which is true for both the in-memory sink and the port-backed
        // writable, so the natural await is not enough on its own.
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // End of stream: flush any words still buffered in phraseBuf so
    // they reach the cover (otherwise the encoder would silently drop
    // them and the decoder would short on bits).
    flushBuffer();
    await pumpOut(fmt.drain());
    if (isGrammarMode && lastEmittedChar !== null && lastEmittedChar !== '\n') {
      await pumpOut('\n');
    }

    await writer.close();
  } catch (err) {
    try { await writer.abort(err); } catch {}
    throw err;
  } finally {
    try { writer.releaseLock(); } catch {}
  }
}
