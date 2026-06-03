// .def grammar parser. Recursive-descent over a small token set.
// Port of OG-NiceText-C++/nicetext-1.0/babble/src/{lexgram.l, yaccgram.y}.
//
// Grammar:
//   grammar       := rule+
//   rule          := IDENT ':' alternatives ';'
//   alternatives  := alternative ('|' alternative)*
//   alternative   := token+ ('@' DIGITS)?
//   token         := IDENT | PUNCT
//
// Lexical:
//   IDENT   = [A-Za-z_-][A-Za-z_0-9+,-]*   (commas allowed for merged-type refs)
//   PUNCT   = '{' ... '}'                  (literal contents kept; {^x^} is quoted-literal)
//   WEIGHT  = '@' [0-9]+
//   comments: '//' to end of line
//   whitespace: skipped (but newlines tracked for errors)
//
// First rule's name is the start symbol.
//
// Output:
//   { startSymbol, rules: Map<name, [{tokens: [{kind, value}], weight}]> }
//
// Browser-safe ESM. No Node deps.

const T_IDENT = 'ident';
const T_PUNCT = 'punct';
const T_COLON = 'colon';
const T_SEMI  = 'semi';
const T_PIPE  = 'pipe';
const T_WEIGHT = 'weight';
const T_EOF   = 'eof';

function tokenize(src) {
  const out = [];
  let pos = 0;
  let line = 1;
  while (pos < src.length) {
    const c = src[pos];
    if (c === ' ' || c === '\t' || c === '\r') { pos++; continue; }
    if (c === '\n') { line++; pos++; continue; }
    if (c === '/' && src[pos + 1] === '/') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      continue;
    }
    if (c === ':') { out.push({ type: T_COLON, line }); pos++; continue; }
    if (c === ';') { out.push({ type: T_SEMI, line });  pos++; continue; }
    if (c === '|') { out.push({ type: T_PIPE, line });  pos++; continue; }
    if (c === '{') {
      const start = pos + 1;
      let end = start;
      while (end < src.length && src[end] !== '}') {
        if (src[end] === '\n') line++;
        end++;
      }
      if (end >= src.length) throw new SyntaxError(`unterminated { at line ${line}`);
      out.push({ type: T_PUNCT, value: src.slice(start, end), line });
      pos = end + 1;
      continue;
    }
    if (c === '@') {
      let end = pos + 1;
      while (end < src.length && src[end] >= '0' && src[end] <= '9') end++;
      if (end === pos + 1) throw new SyntaxError(`@ without digits at line ${line}`);
      out.push({ type: T_WEIGHT, value: parseInt(src.slice(pos + 1, end), 10), line });
      pos = end;
      continue;
    }
    if (/[A-Za-z_\-]/.test(c)) {
      let end = pos + 1;
      while (end < src.length && /[A-Za-z0-9_+,\-]/.test(src[end])) end++;
      out.push({ type: T_IDENT, value: src.slice(pos, end), line });
      pos = end;
      continue;
    }
    throw new SyntaxError(`unexpected '${c}' at line ${line}`);
  }
  out.push({ type: T_EOF, line });
  return out;
}

export function parseGrammar(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat  = (type) => {
    const t = toks[i];
    if (t.type !== type) throw new SyntaxError(`expected ${type}, got ${t.type} ("${t.value ?? ''}") at line ${t.line}`);
    i++;
    return t;
  };

  const rules = new Map();
  let startSymbol = null;

  while (peek().type !== T_EOF) {
    const nameTok = eat(T_IDENT);
    eat(T_COLON);
    const alternatives = [];
    for (;;) {
      const tokens = [];
      while (peek().type === T_IDENT || peek().type === T_PUNCT) {
        const t = peek(); i++;
        tokens.push(t.type === T_PUNCT
          ? { kind: 'punct', value: t.value }
          : { kind: 'ref', value: t.value });
      }
      let weight = 1;
      if (peek().type === T_WEIGHT) { weight = peek().value; i++; }
      if (tokens.length === 0) {
        throw new SyntaxError(`empty RHS in rule "${nameTok.value}" at line ${peek().line}`);
      }
      alternatives.push({ tokens, weight });
      if (peek().type === T_PIPE) { i++; continue; }
      break;
    }
    eat(T_SEMI);
    rules.set(nameTok.value, alternatives);
    if (startSymbol === null) startSymbol = nameTok.value;
  }

  if (!startSymbol) throw new SyntaxError('grammar contains no rules');
  return { startSymbol, rules };
}
