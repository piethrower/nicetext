// Helper: load a corpus text file. Thin wrapper kept for encapsulation
// so future changes (e.g. range/marker handling, alternate I/O) have a
// single seam to land at.
//
// Glob support: when the path contains '*', resolves the wildcard
// against the parent directory, sorts matches lexicographically, and
// concatenates them with newline separators. Use for multi-file
// corpora like `fixture-src/texts/texting-teen*.txt`. The byos.build.corpus
// string is the source of truth; no intermediate concat file required.
//
// texting-teen newline -> U+2028 + \n substitution: teen-text source
// files store one message per line with no trailing punctuation
// (natural teen style). To make each line a sentence boundary without
// polluting the cover with periods, every run of newlines (within a
// file and at inter-file join seams) is collapsed to U+2028 LINE
// SEPARATOR followed by \n. The lexer folds U+2028 into the EOS
// terminator class alongside . ! ?, and its existing trailing-
// whitespace slurp absorbs the \n into the same EOS token. The \n is
// what makes the cover render as visible line breaks in plaintext
// surfaces (textareas, terminals) where U+2028 alone is not honored.
// The collapse-runs rule prevents doubling up at file boundaries
// when a shard ends with a trailing newline.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const TEEN_PATTERN = /^texting-teen.*\.txt$/;
const LINE_SEP = '\u2028\n';  // U+2028 LINE SEPARATOR + LF (visible break)

export function loadCorpusText(corpusPath) {
  const isTeen = TEEN_PATTERN.test(basename(corpusPath));

  let text;
  if (!corpusPath.includes('*')) {
    text = readFileSync(corpusPath, 'utf8');
  } else {
    const dir = dirname(corpusPath);
    const pattern = basename(corpusPath);
    const re = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    const files = readdirSync(dir).filter(f => re.test(f)).sort();
    if (files.length === 0) {
      throw new Error(`loadCorpusText: glob ${corpusPath} matched no files`);
    }
    process.stderr.write(`  glob matched ${files.length} files: ${files.join(', ')}\n`);
    text = files.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  }

  if (isTeen) {
    text = text.replace(/\n+/g, LINE_SEP);
  }
  return text;
}
