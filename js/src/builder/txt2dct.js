// txt2dct: convert (typeName, wordsFromFile) pairs into a flat TWLIST.
// Port of OG-NiceText-C++/nicetext-1.0/gendict/src/txt2dct.cc.
//
// Input shape: array of { typeName, words: string[] } (or one big string per file).
// Output: TWLIST = array of { type, word }.
//
// Browser-safe ESM. No Node deps.

export function parseWordList(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const w = line.trim();
    if (!w || w.startsWith('#')) continue;
    out.push(w);
  }
  return out;
}

export function txtToTwlist(fileWordLists) {
  const twlist = [];
  for (const { typeName, words } of fileWordLists) {
    if (!typeName) throw new Error('typeName required');
    if (typeName.includes(',') || /\s/.test(typeName)) {
      throw new Error(`Invalid type name "${typeName}": no commas or whitespace allowed`);
    }
    for (const word of words) {
      const w = typeof word === 'string' ? word.trim() : '';
      if (!w || w.startsWith('#')) continue;
      twlist.push({ type: typeName, word: w });
    }
  }
  return twlist;
}
