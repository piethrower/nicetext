// SAB binary packer for parsed CFG grammars. Same shape rationale as
// the dict and model-table packers: workers share one SAB ref, no
// per-isolate object graph, expander reads via byte-offset arithmetic.
// See docs/architecture-sab.md.
//
// Browser-safe ESM. No Node deps.

const MAGIC = 0x5247544E; // "NTGR" little-endian
const VERSION = 1;

// Header layout (56 bytes):
//   0  magic            u32 ("NTGR" LE)
//   4  version          u32
//   8  ruleCount        u32  (R)
//  12  altCount         u32  (A, sum across all rules)
//  16  punctCount       u32  (P)
//  20  nameCount        u32  (N', distinct type-name refs)
//  24  startRuleIndex   u32
//  28  ruleTableOff     u32  (R entries × 12 bytes)
//  32  altTableOff      u32  (A entries × 12 bytes)
//  36  altTokensOff     u32  (variable u32 tokens)
//  40  punctsOff        u32  (P u32 entries: stringOffset)
//  44  namesOff         u32  (N' u32 entries: stringOffset)
//  48  stringPoolOff    u32
//  52  stringPoolLen    u32
const HEADER_SIZE = 56;

// Rule entry (12 bytes):
//   0  nameStringOffset u32  (the rule's own name; for diagnostics/expgram)
//   4  altIndexStart    u32  (index into the alt table)
//   8  altCount         u32
const RULE_ENTRY_SIZE = 12;

// Alt entry (12 bytes):
//   0  weight           u32
//   4  tokenOffset      u32  (absolute byte offset into altTokens section)
//   8  tokenCount       u32
const ALT_ENTRY_SIZE = 12;

// Each entry in puncts and names is a u32 stringOffset. Length lives
// in the pool's length-prefix.
const NAME_ENTRY_SIZE = 4;

// Each token is a u32:
//   bits 30..31  kind:
//                  0 = punct       index → puncts[index]
//                  1 = rule-ref    index → rules[index]
//                  2 = name-ref    index → names[index]
//   bits  0..29  index (30 bits, max 1B+)
const TOKEN_KIND_SHIFT = 30;
const TOKEN_INDEX_MASK = 0x3FFFFFFF;
const KIND_PUNCT    = 0;
const KIND_RULE_REF = 1;
const KIND_NAME_REF = 2;

const POOL_LEN_PREFIX_SIZE = 2;

export const GRAMMAR_SAB_CONSTANTS = {
  MAGIC, VERSION, HEADER_SIZE,
  RULE_ENTRY_SIZE, ALT_ENTRY_SIZE, NAME_ENTRY_SIZE,
  TOKEN_KIND_SHIFT, TOKEN_INDEX_MASK,
  KIND_PUNCT, KIND_RULE_REF, KIND_NAME_REF,
};

const ENCODER = new TextEncoder();

// packGrammarToSAB(parsedGrammar) -> SharedArrayBuffer.
//
// parsedGrammar is the output of js/src/grammar/parser.js:
//   { startSymbol: string, rules: Map<name, [{ tokens, weight }]> }
// where each token is { kind: 'punct' | 'ref', value: string }.
export function packGrammarToSAB(parsedGrammar) {
  if (!parsedGrammar || typeof parsedGrammar !== 'object' || !parsedGrammar.rules) {
    throw new Error('grammar-pack: expected parsed grammar with rules Map');
  }
  const ruleNames = [...parsedGrammar.rules.keys()];
  if (ruleNames.length === 0) {
    throw new Error('grammar-pack: empty grammar (no rules)');
  }
  const ruleNameToIndex = new Map();
  for (let i = 0; i < ruleNames.length; i++) {
    ruleNameToIndex.set(ruleNames[i], i);
  }
  const startRuleIndex = ruleNameToIndex.get(parsedGrammar.startSymbol);
  if (startRuleIndex === undefined) {
    throw new Error(
      `grammar-pack: startSymbol "${parsedGrammar.startSymbol}" not in rules`
    );
  }

  // Walk every alt token: classify as punct, rule-ref, or name-ref.
  // Intern punct strings into puncts (first-seen order); intern type-name
  // strings (refs that don't match a rule) into names (first-seen order).
  const punctIndex = new Map();
  const nameIndex = new Map();
  function internPunct(s) {
    let i = punctIndex.get(s);
    if (i === undefined) { i = punctIndex.size; punctIndex.set(s, i); }
    return i;
  }
  function internName(s) {
    let i = nameIndex.get(s);
    if (i === undefined) { i = nameIndex.size; nameIndex.set(s, i); }
    return i;
  }

  // Pre-classify all tokens, computing total counts.
  let totalAlts = 0;
  let totalTokens = 0;
  const ruleAlts = []; // [[{weight, classifiedTokens: [{kind, index}]}, ...], ...]
  for (const name of ruleNames) {
    const alts = parsedGrammar.rules.get(name);
    const classifiedAlts = [];
    for (const alt of alts) {
      const classified = [];
      for (const tok of alt.tokens) {
        if (tok.kind === 'punct') {
          classified.push({ kind: KIND_PUNCT, index: internPunct(tok.value) });
        } else if (ruleNameToIndex.has(tok.value)) {
          classified.push({ kind: KIND_RULE_REF, index: ruleNameToIndex.get(tok.value) });
        } else {
          classified.push({ kind: KIND_NAME_REF, index: internName(tok.value) });
        }
      }
      classifiedAlts.push({ weight: alt.weight | 0, tokens: classified });
      totalTokens += classified.length;
    }
    ruleAlts.push(classifiedAlts);
    totalAlts += classifiedAlts.length;
  }

  // String pool: rule names + punct strings + name-ref strings.
  const stringMap = new Map();
  const stringChunks = [];
  let stringPoolLen = 0;
  function intern(s) {
    let entry = stringMap.get(s);
    if (entry) return entry;
    const bytes = ENCODER.encode(s);
    if (bytes.length > 0xFFFF) {
      throw new Error(`grammar-pack: string "${s.slice(0, 40)}..." exceeds u16 length`);
    }
    entry = { offset: stringPoolLen, length: bytes.length };
    stringMap.set(s, entry);
    const prefix = new Uint8Array(POOL_LEN_PREFIX_SIZE);
    prefix[0] = bytes.length & 0xFF;
    prefix[1] = (bytes.length >> 8) & 0xFF;
    stringChunks.push(prefix);
    stringChunks.push(bytes);
    stringPoolLen += POOL_LEN_PREFIX_SIZE + bytes.length;
    return entry;
  }
  const ruleNameOffsets = ruleNames.map((n) => intern(n).offset);
  const punctOffsets = new Array(punctIndex.size);
  for (const [s, i] of punctIndex) punctOffsets[i] = intern(s).offset;
  const nameOffsets = new Array(nameIndex.size);
  for (const [s, i] of nameIndex) nameOffsets[i] = intern(s).offset;

  // Section offsets.
  const R = ruleNames.length;
  const A = totalAlts;
  const P = punctIndex.size;
  const N = nameIndex.size;
  const ruleTableOff = HEADER_SIZE;
  const altTableOff = ruleTableOff + R * RULE_ENTRY_SIZE;
  const altTokensOff = altTableOff + A * ALT_ENTRY_SIZE;
  const punctsOff = altTokensOff + totalTokens * 4;
  const namesOff = punctsOff + P * NAME_ENTRY_SIZE;
  const stringPoolOff = namesOff + N * NAME_ENTRY_SIZE;
  const totalSize = stringPoolOff + stringPoolLen;

  let sab;
  try {
    sab = new SharedArrayBuffer(totalSize);
  } catch {
    sab = new ArrayBuffer(totalSize);
  }
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);

  // Header.
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, R, true);
  view.setUint32(12, A, true);
  view.setUint32(16, P, true);
  view.setUint32(20, N, true);
  view.setUint32(24, startRuleIndex, true);
  view.setUint32(28, ruleTableOff, true);
  view.setUint32(32, altTableOff, true);
  view.setUint32(36, altTokensOff, true);
  view.setUint32(40, punctsOff, true);
  view.setUint32(44, namesOff, true);
  view.setUint32(48, stringPoolOff, true);
  view.setUint32(52, stringPoolLen, true);

  // Walk rules, writing rule-table entries and alt-table entries plus
  // tokens. Track the current alt index and current token byte offset.
  let nextAltIdx = 0;
  let nextTokenByteOff = altTokensOff;
  for (let r = 0; r < R; r++) {
    const alts = ruleAlts[r];
    // Rule-table entry.
    const rOff = ruleTableOff + r * RULE_ENTRY_SIZE;
    view.setUint32(rOff + 0, ruleNameOffsets[r], true);
    view.setUint32(rOff + 4, nextAltIdx, true);
    view.setUint32(rOff + 8, alts.length, true);
    // Alt-table entries + token writes.
    for (const alt of alts) {
      const aOff = altTableOff + nextAltIdx * ALT_ENTRY_SIZE;
      view.setUint32(aOff + 0, alt.weight, true);
      view.setUint32(aOff + 4, nextTokenByteOff, true);
      view.setUint32(aOff + 8, alt.tokens.length, true);
      for (let k = 0; k < alt.tokens.length; k++) {
        const t = alt.tokens[k];
        const encoded = (t.kind << TOKEN_KIND_SHIFT) | (t.index & TOKEN_INDEX_MASK);
        view.setUint32(nextTokenByteOff + k * 4, encoded, true);
      }
      nextTokenByteOff += alt.tokens.length * 4;
      nextAltIdx++;
    }
  }

  // Puncts and names.
  for (let i = 0; i < P; i++) {
    view.setUint32(punctsOff + i * NAME_ENTRY_SIZE, punctOffsets[i], true);
  }
  for (let i = 0; i < N; i++) {
    view.setUint32(namesOff + i * NAME_ENTRY_SIZE, nameOffsets[i], true);
  }

  // String pool.
  let writePos = stringPoolOff;
  for (const chunk of stringChunks) {
    bytes.set(chunk, writePos);
    writePos += chunk.length;
  }

  return sab;
}
