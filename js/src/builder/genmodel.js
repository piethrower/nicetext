// genmodel: extract sentence-model table from a sample text + dictionary.
// Port of OG-NiceText-C++/nicetext-1.0/gendict/src/genmodel.cc concept.
//
// For each sentence in the sample text:
//   - Tokenize via the lexer (WORD / PUNCT / EOS)
//   - For each WORD:
//       * Detect case: ALL_CAPS, Title_Case, lower (first char)
//       * Emit {CAPSLOCKON}/{capslockoff} or {Cap} format tokens as needed
//       * Look up the lowercased word in the dictionary
//       * If found: emit a TYPE slot referencing that word's typeIndex
//       * If not found: emit the original word as a quoted-literal {^word^}
//   - For each PUNCT: emit a single-character punct token
//   - At EOS: finalize the current model and add it to the frequency table
//     (deduplicated; weight = count of identical models)
//
// Output JSON shape:
//   {
//     version: 1,
//     name: "shakespeare",
//     models: [
//       { tokens: [{kind:'punct'|'type', ...}], weight: 5 },
//       ...
//     ]
//   }
//
// Browser-safe ESM. No Node deps.

import { tokenize, phraseFuse, TOKEN } from '../lexer.js';
import { lookupType, lookupWord } from '../dictionary.js';
import { precleanCorpus } from './precleanCorpus.js';
import { mergesortAsync } from './mergesort-async.js';
import { getRedactedMatcher } from './redaction.js';

// Merge a dict's phraseIndex with the redacted matcher's phraseIndex
// into one combined Map/maxPhraseLen pair. Same shape phraseFuse
// expects. Each bucket sorted parts-length-desc so phraseFuse's
// first-match-wins loop gives greedy-longest behavior across both
// origin types. canonicals stay as the dict / redaction.js set them
// (dict canonical for compound words; REDACTION_MARKER for redacted
// entries).
function mergeDictAndRedactedPhraseIndex(dict, redacted) {
  const dictIdx = dict && dict.phraseIndex ? dict.phraseIndex : null;
  const dictMax = dict && dict.maxPhraseLen ? dict.maxPhraseLen : 0;
  const out = new Map();
  if (dictIdx) for (const [k, v] of dictIdx) out.set(k, [...v]);
  for (const [k, v] of redacted.phraseIndex) {
    const cur = out.get(k);
    if (cur) cur.push(...v);
    else out.set(k, [...v]);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => b.parts.length - a.parts.length);
  }
  return { phraseIndex: out, maxPhraseLen: Math.max(dictMax, redacted.maxPhraseLen) };
}

function caseOf(word) {
  if (word.length === 0) return 'lower';
  if (word === word.toUpperCase() && /[A-Za-z]/.test(word)) return 'all_caps';
  const c0 = word.charAt(0);
  if (c0 === c0.toUpperCase() && c0 !== c0.toLowerCase()) return 'title';
  return 'lower';
}

// Compact token format: each token is either a non-negative integer
// (index into the table's `typeNames` array) or a string (punct value).
// Storing type NAMES (not indexes into the source dict) at the table level
// makes the table portable across any dict that contains those type names.
function modelKey(tokens) {
  return tokens.map(t => typeof t === 'number' ? `t:${t}` : `p:${t}`).join('|');
}

// opts.onProgress (optional): called roughly every PROGRESS_SAMPLE
// tokens with `{pos, total}` so long-corpus model builds can drive
// a real progress bar from character-offset.
const PROGRESS_SAMPLE = 4096;

// Public async entry: loads getRedactedMatcher, merges with
// dict.phraseIndex, delegates to the sync inner loop. Every shipping
// caller goes through here so redaction is mandatory and lexer-
// aligned (phraseFuse pass). Async because loadResource is async;
// the cache makes subsequent calls cheap.
export async function generateModelTable(text, dict, opts = {}) {
  const redacted = await getRedactedMatcher();
  const merged = mergeDictAndRedactedPhraseIndex(dict, redacted);
  return _generateModelTableSync(text, dict, {
    ...opts,
    phraseIndex: merged.phraseIndex,
    maxPhraseLen: merged.maxPhraseLen,
  });
}

function _generateModelTableSync(text, dict, opts = {}) {
  // dedupe (default true): collapse identical sentence shapes into a single
  // entry with weight=count. Compact, suitable for weighted-random selection.
  // dedupe=false: every sentence is its own entry, weight=1, in original
  // document order. Larger output, but enables true sequential replay.
  //
  // resolveWord (optional, default = real dict lookup): a function
  // (loweredWord) => typeName-string-or-null. When supplied, replaces
  // the internal lookupWord+lookupType chain. Used by Eve's
  // MonoTypedModelCheck: a meta-dict that maps every word to a single
  // type 'g' produces pure structural sentence templates
  // (`{Cap}|g|g|.`) that compare against per-corpus monotyped-model
  // fixtures without ever needing word-type identity. Default closure
  // preserves byte-identical behavior on every existing call site;
  // existing engine tests pass unmodified.
  const {
    name = 'unnamed',
    dedupe = true,
    onProgress = null,
    resolveWord = null,
    // Internal: when true, dedupe-mode skips the final sort. The
    // caller is responsible for sorting (e.g., generateModelTableAsync
    // uses the yielding mergesort instead). Output is otherwise
    // identical.
    skipSort = false,
    // The merged phraseIndex (dict + redacted) and its maxPhraseLen,
    // built by the async wrapper below. Required when caller has gone
    // through generateModelTable's async entry (every shipping path).
    phraseIndex = null,
    maxPhraseLen = 0,
  } = opts;
  const resolve = resolveWord ?? ((lower) => {
    const entry = lookupWord(dict, lower);
    if (!entry) return null;
    const rec = lookupType(dict, entry.typeIndex);
    return rec ? rec.name : null;
  });
  text = precleanCorpus(text);
  const counts = new Map();   // modelKey → { tokens, weight }     (dedupe mode)
  const ordered = [];         // [{ tokens, weight }, ...]         (no-dedupe mode)
  let current = [];
  let capLockOn = false;
  // Build a typeNames table as we go. Each unique type seen becomes an index
  // into typeNames; tokens in models reference those indexes (compact +
  // portable across dicts that share the same type names).
  const typeNames = [];
  const typeNameToIndex = new Map();
  function nameIndexOf(typeName) {
    let i = typeNameToIndex.get(typeName);
    if (i === undefined) {
      i = typeNames.length;
      typeNames.push(typeName);
      typeNameToIndex.set(typeName, i);
    }
    return i;
  }

  function pushPunct(v) { current.push(v); }
  function pushTypeByName(typeName) {
    current.push(nameIndexOf(typeName));
  }

  function flushSentence() {
    if (current.length === 0) return;
    if (capLockOn) {
      pushPunct('capslockoff');
      capLockOn = false;
    }
    if (dedupe) {
      const key = modelKey(current);
      const existing = counts.get(key);
      if (existing) existing.weight++;
      else counts.set(key, { tokens: current, weight: 1 });
    } else {
      ordered.push({ tokens: current, weight: 1 });
    }
    current = [];
  }

  let n = 0;
  const total = text.length;
  // Step 4 (phrase-and-charset arc): when the dict carries multi-word
  // entries, run the corpus token stream through phrase fusion so a
  // sequence like `a la carte` lexes as one WORD whose value matches
  // the dict's canonical phrase key. Without this, corpus phrases would
  // process word-by-word, miss the dict, and become quoted-literal
  // `^word^` puncts, wasting any model that should have produced
  // bit-bearing phrase slots.
  const rawTokens = tokenize(text, { skipBoilerplate: true });
  const tokens = (phraseIndex && phraseIndex.size > 0)
    ? phraseFuse(rawTokens, phraseIndex, maxPhraseLen)
    : rawTokens;
  for (const tok of tokens) {
    if (onProgress && (++n & (PROGRESS_SAMPLE - 1)) === 0) {
      onProgress({ pos: tok.position, total });
    }
    if (tok.type === TOKEN.WORD) {
      const word = tok.value;
      const lower = word.toLowerCase();
      const typeName = resolve(lower);
      const cs = caseOf(word);

      if (cs === 'all_caps' && !capLockOn) {
        pushPunct('CAPSLOCKON');
        capLockOn = true;
      } else if (cs !== 'all_caps' && capLockOn) {
        pushPunct('capslockoff');
        capLockOn = false;
      }
      if (cs === 'title' && !capLockOn) {
        pushPunct('Cap');
      }

      if (typeName) {
        pushTypeByName(typeName);
      } else {
        // Word isn't in the dictionary; preserve as quoted literal.
        pushPunct(`^${word}^`);
      }
      continue;
    }
    if (tok.type === TOKEN.PUNCT) {
      pushPunct(tok.value);
      continue;
    }
    if (tok.type === TOKEN.WHITESPACE) {
      // Wrap the literal whitespace in the formatter's quoted-literal
      // form so it round-trips byte-for-byte and the formatter clears
      // its pending-space flag (suppresses the implicit single-space
      // that would otherwise stack on top of the literal whitespace).
      pushPunct(`^${tok.value}^`);
      continue;
    }
    if (tok.type === TOKEN.EOS) {
      // Preserve the lexer's exact EOS value (terminator + trailing
      // whitespace) via quoted-literal so cover layout matches corpus
      // paragraph breaks and indentation. Replaces the legacy hardcoded
      // `'. n'` normalization that collapsed every EOS to one newline.
      //
      // Guard against word-fusion on decode: WORD_RE treats `.` as a
      // word-extender (`theta.gamma` lexes as ONE token via the EXT
      // pattern). An end-of-corpus EOS like `.` carries no trailing
      // whitespace, so emitting it followed by the next sentence's
      // first WORD would render `theta.gamma` and break bit accounting
      // on round-trip. Append a single space whenever the EOS has no
      // trailing whitespace at all, sentence-final terminators in
      // mid-corpus already carry whitespace via EOS_RE's greedy
      // `["\\s]*\\n*` consumption, so this only fires for end-of-corpus
      // and similar edges.
      const eosValue = /\s$/.test(tok.value) ? tok.value : tok.value + ' ';
      pushPunct(`^${eosValue}^`);
      flushSentence();
    }
  }
  // Flush trailing partial model (if file didn't end with EOS).
  // Append a synthetic terminator first so every model has at least
  // one trailing punct. Without this, a corpus that ends mid-sentence
  // would emit a trailing model with no sentence boundary.
  if (current.length > 0) pushPunct('^.\n^');
  flushSentence();
  if (onProgress) onProgress({ pos: total, total });

  let models;
  if (dedupe) {
    models = [...counts.values()];
    if (!skipSort) {
      // Sort deterministically: by weight desc, then by serialized form.
      models.sort((a, b) => b.weight - a.weight || modelKey(a.tokens).localeCompare(modelKey(b.tokens)));
    }
  } else {
    models = ordered;
  }

  // version 2: tokens are integers (typeNames index) or strings (puncts).
  // typeNames carries the actual type names so the table is portable across
  // any dict that contains them.
  return { version: 2, name, ordered: !dedupe, typeNames, models };
}

// Yielding companion to generateModelTable. Identical output (byte-
// equivalent JSON, deterministic sort order) but the deduped-models
// sort runs through the yielding mergesort so big corpora (Shakespeare
// produces 39K+ unique MMs after dedupe) don't lock the worker for
// the 2-4 s the native Array.sort previously took. The body of the
// model generation (tokenize + dedupe-count + serialize) already
// yields via the existing onProgress probe, only the final sort was
// unyieldable.
//
// Same options as generateModelTable plus:
//   opts.signal         optional AbortSignal forwarded to the sort
//   opts.sortOnProgress optional callback for sort-phase events
//   opts.yieldEvery     items per sort yield (default 50,000)
export async function generateModelTableAsync(text, dict, opts = {}) {
  const json = await generateModelTable(text, dict, { ...opts, skipSort: true });
  if (opts.dedupe !== false) {
    json.models = await mergesortAsync(
      json.models,
      (a, b) => (
        b.weight - a.weight
        || modelKey(a.tokens).localeCompare(modelKey(b.tokens))
      ),
      {
        yieldEvery: opts.yieldEvery ?? 50_000,
        signal: opts.signal ?? null,
        onProgress: opts.sortOnProgress ?? null,
      },
    );
  }
  return json;
}
