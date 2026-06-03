// client9-misspell-parser.js -- shared Go-literal block extractor for
// the client9/misspell `words.go` source file.
//
// Consumed by:
//   fixture-src/rewriters/typos/fetch.js     (DictMain)
//   fixture-src/rewriters/british/fetch.js   (DictAmerican + DictBritish)
//
// Both fetchers read the same sibling install at ../misspell/ (see
// either fetcher's header comment for the one-time setup block).
//
// Surface:
//   KNOWN_BLOCKS          array of every `var Dict... = []string{}`
//                         declaration name we recognize, in
//                         declaration order in words.go.
//   extractBlockPairs(source, blockName) -> [[wrong, correct], ...]
//                         pull a single block's consecutive string
//                         pairs in declaration order. Throws if the
//                         block is missing or has an odd string count.
//
// Brace-matched scan respects Go-string escapes (\" and \\) so a
// literal brace inside a string (not present in this dataset, but
// defensive) cannot terminate the block early.

export const KNOWN_BLOCKS = ['DictMain', 'DictAmerican', 'DictBritish'];

export function extractBlockPairs(source, blockName) {
  const headerRe = new RegExp(`var\\s+${blockName}\\s*=\\s*\\[\\]string\\s*\\{`);
  const headerHit = headerRe.exec(source);
  if (!headerHit) {
    throw new Error(`client9-misspell-parser: could not locate ${blockName} in words.go`);
  }
  const open = headerHit.index + headerHit[0].length - 1;       // index of '{'
  let depth = 0;
  let i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      // Skip a double-quoted Go interpreted string; honor \" and \\ so
      // a brace inside a string literal cannot close the block early.
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`client9-misspell-parser: unbalanced braces inside ${blockName}`);
  }
  const body = source.slice(open + 1, i);

  const strings = [];
  const stringRe = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = stringRe.exec(body)) !== null) strings.push(m[1]);
  if (strings.length % 2 !== 0) {
    throw new Error(
      `client9-misspell-parser: ${blockName} has odd string count ${strings.length}; expected pairs`);
  }
  const pairs = [];
  for (let k = 0; k < strings.length; k += 2) pairs.push([strings[k], strings[k + 1]]);
  return pairs;
}
