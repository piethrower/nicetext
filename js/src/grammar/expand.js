// Grammar expander, produces sentence models from a SAB-backed grammar.
//
// A sentence model is a flat array of items:
//   { kind: 'type',  name: string }  : a type slot (encoder reads bits, looks up word)
//   { kind: 'punct', value: string } : a format/punctuation token (literal {…} contents)
//
// Refs that match a rule recurse; refs to non-rule names emit as type
// slots (classified at pack time, not at runtime). Punct tokens are
// always terminals.
//
// Recursive grammars can produce arbitrarily long models. The expander
// skips and retries any model that exceeds maxLength (default 1024),
// per the thesis -l flag.
//
// Browser-safe ESM. No Node deps.

import { lookupTypeByName } from '../dictionary.js';
import { packGrammarToSAB, GRAMMAR_SAB_CONSTANTS } from '../builder/grammar-pack.js';

const {
  MAGIC, VERSION,
  RULE_ENTRY_SIZE, ALT_ENTRY_SIZE, NAME_ENTRY_SIZE,
  TOKEN_KIND_SHIFT, TOKEN_INDEX_MASK,
  KIND_PUNCT, KIND_RULE_REF, KIND_NAME_REF,
} = GRAMMAR_SAB_CONSTANTS;

const POOL_LEN_PREFIX_SIZE = 2;
const DECODER = new TextDecoder();

const DEFAULT_MAX_LENGTH = 1024;
const MAX_RETRIES = 64;
const CLEAN_RETRIES = 32;

function readHeader(view) {
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(
      `grammar: bad SAB magic 0x${magic.toString(16)} (expected NTGR)`
    );
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`grammar: unsupported SAB version ${version}`);
  }
  return {
    ruleCount:        view.getUint32(8, true),
    altCount:         view.getUint32(12, true),
    punctCount:       view.getUint32(16, true),
    nameCount:        view.getUint32(20, true),
    startRuleIndex:   view.getUint32(24, true),
    ruleTableOffset:  view.getUint32(28, true),
    altTableOffset:   view.getUint32(32, true),
    altTokensOffset:  view.getUint32(36, true),
    punctsOffset:     view.getUint32(40, true),
    namesOffset:      view.getUint32(44, true),
    stringPoolOffset: view.getUint32(48, true),
    stringPoolLength: view.getUint32(52, true),
  };
}

// Build a SAB-backed grammar from a parsed grammar tree
// (parser.js output). Pack once; subsequent modelStream creations
// reuse the SAB cheaply.
export function loadGrammar(parsedGrammar) {
  const sab = packGrammarToSAB(parsedGrammar);
  return wrapGrammarFromSAB(sab);
}

// Wrap a previously-packed grammar SAB into the runtime grammar
// object, without re-packing. Used by workers that receive a SAB ref
// from the parent's resource cache.
export function wrapGrammarFromSAB(sab) {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const header = readHeader(view);
  return { sab, view, bytes, header };
}

// Summary stats for a wrapped grammar SAB. Rule + alt totals come from
// the header; max alt token count requires walking the alt table once.
export function grammarStats(grammar) {
  const R = grammar.header.ruleCount;
  const A = grammar.header.altCount;
  let maxTokens = 0;
  for (let i = 0; i < A; i++) {
    const off = grammar.header.altTableOffset + i * ALT_ENTRY_SIZE;
    const tokenCount = grammar.view.getUint32(off + 8, true);
    if (tokenCount > maxTokens) maxTokens = tokenCount;
  }
  return {
    ruleCount: R,
    altCount: A,
    maxTokens,
    sabBytes: grammar.sab.byteLength,
  };
}

function readPoolString(grammar, poolRelOffset) {
  const off = grammar.header.stringPoolOffset + poolRelOffset;
  const len = grammar.bytes[off] | (grammar.bytes[off + 1] << 8);
  // slice (not subarray) so TextDecoder gets a non-shared view,
  // TextDecoder.decode rejects views over SharedArrayBuffer.
  return DECODER.decode(grammar.bytes.slice(off + 2, off + 2 + len));
}

function readPunct(grammar, idx) {
  const stringOff = grammar.view.getUint32(
    grammar.header.punctsOffset + idx * NAME_ENTRY_SIZE, true
  );
  return readPoolString(grammar, stringOff);
}

function readName(grammar, idx) {
  const stringOff = grammar.view.getUint32(
    grammar.header.namesOffset + idx * NAME_ENTRY_SIZE, true
  );
  return readPoolString(grammar, stringOff);
}

function readRule(grammar, ruleIdx) {
  const off = grammar.header.ruleTableOffset + ruleIdx * RULE_ENTRY_SIZE;
  return {
    altIndexStart: grammar.view.getUint32(off + 4, true),
    altCount:      grammar.view.getUint32(off + 8, true),
  };
}

function readAlt(grammar, altIdx) {
  const off = grammar.header.altTableOffset + altIdx * ALT_ENTRY_SIZE;
  return {
    weight:      grammar.view.getUint32(off + 0, true),
    tokenOffset: grammar.view.getUint32(off + 4, true),
    tokenCount:  grammar.view.getUint32(off + 8, true),
  };
}

// random() must return a value in [0, 1) (like Math.random). For PRNGs
// that emit uint32 (e.g. mulberry32), wrap with `() => prng() / 0x100000000`.
function pickWeightedAlt(grammar, rule, random) {
  // Sum weights across this rule's alternatives.
  let total = 0;
  for (let k = 0; k < rule.altCount; k++) {
    const off = grammar.header.altTableOffset + (rule.altIndexStart + k) * ALT_ENTRY_SIZE;
    total += grammar.view.getUint32(off + 0, true);
  }
  const r = random() * total;
  let acc = 0;
  for (let k = 0; k < rule.altCount; k++) {
    const altIdx = rule.altIndexStart + k;
    const off = grammar.header.altTableOffset + altIdx * ALT_ENTRY_SIZE;
    acc += grammar.view.getUint32(off + 0, true);
    if (r < acc) return readAlt(grammar, altIdx);
  }
  return readAlt(grammar, rule.altIndexStart + rule.altCount - 1);
}

function expandRule(grammar, ruleIdx, out, random, maxLength) {
  const rule = readRule(grammar, ruleIdx);
  const alt = pickWeightedAlt(grammar, rule, random);
  for (let k = 0; k < alt.tokenCount; k++) {
    if (out.length > maxLength) return; // bail; caller will retry
    const tok = grammar.view.getUint32(alt.tokenOffset + k * 4, true);
    const kind = (tok >>> TOKEN_KIND_SHIFT) & 3;
    const index = tok & TOKEN_INDEX_MASK;
    if (kind === KIND_PUNCT) {
      out.push({ kind: 'punct', value: readPunct(grammar, index) });
    } else if (kind === KIND_RULE_REF) {
      expandRule(grammar, index, out, random, maxLength);
    } else {
      out.push({ kind: 'type', name: readName(grammar, index) });
    }
  }
}

export function makeModel(grammar, { random = Math.random, maxLength = DEFAULT_MAX_LENGTH } = {}) {
  if (!grammar || !grammar.sab) {
    throw new Error('makeModel: grammar must be SAB-backed (call loadGrammar first)');
  }
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const out = [];
    expandRule(grammar, grammar.header.startRuleIndex, out, random, maxLength);
    if (out.length <= maxLength) return out;
  }
  throw new Error(`expand: could not generate a model under maxLength ${maxLength} after ${MAX_RETRIES} attempts`);
}

// True iff every type slot in `model` resolves to a type known to `dict`.
function modelTypesAllResolve(model, dict) {
  for (const item of model) {
    if (item.kind !== 'type') continue;
    if (lookupTypeByName(dict, item.name) === null) return false;
  }
  return true;
}

// Drives encode: each call returns the next sentence model.
//
// Without a dict, behaves as before, emit whatever expand produces.
// With a dict, runs in two-tier mode: try up to CLEAN_RETRIES times to
// find a model whose every type slot exists in the dict. After that
// many misses, switch to permanent skip-mode for the remainder of the
// stream: emit whatever expand produces and let the encoder skip
// unresolved slots (round-trip stays safe because the same dict on
// decode also skips them).
export function modelStream(grammar, opts = {}) {
  const { dict = null } = opts;
  let skipMode = false;
  return {
    next() {
      if (skipMode || !dict) return makeModel(grammar, opts);
      for (let i = 0; i < CLEAN_RETRIES; i++) {
        const m = makeModel(grammar, opts);
        if (modelTypesAllResolve(m, dict)) return m;
      }
      skipMode = true;
      return makeModel(grammar, opts);
    },
  };
}
