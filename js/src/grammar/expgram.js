// expgram: generate m-rules from a dictionary so portable grammars can
// reference abstract types like mPERSON or mPLACE.
// Port of OG-NiceText-C++/nicetext-1.0/babble/src/expgram.cc concept.
//
// For each atomic type T mentioned in the dictionary's merged type names
// (e.g. "name_female,name_male" mentions "name_female" and "name_male"),
// this emits a rule:
//
//   mT: <merged_type_1> @<weight>
//     | <merged_type_2> @<weight>
//     | ...
//     ;
//
// Default weight = wordCount of that merged type (so the type-as-a-whole
// gets selected proportionally to how many words it carries).
//
// The 'normalize' option divides each weight by the number of atomic
// sub-types in the merged name, so a 9-word "object,place,person" entry
// contributes weight 3 to each of mOBJECT, mPLACE, mPERSON instead of 9.
//
// Browser-safe ESM. No Node deps.

export function emitMRules(dict, { normalize = false, prefix = 'm' } = {}) {
  // Build atomic-type → list of (mergedType, weight) entries.
  const atomicToMerged = new Map();
  for (const t of dict.json.types) {
    const subtypes = t.name.split(',');
    const w = normalize ? Math.max(1, Math.round(t.wordCount / subtypes.length)) : t.wordCount;
    for (const sub of subtypes) {
      if (!atomicToMerged.has(sub)) atomicToMerged.set(sub, []);
      atomicToMerged.get(sub).push({ mergedType: t.name, weight: w });
    }
  }

  // Emit one rule per atomic type, in alphabetical order.
  const lines = [];
  for (const sub of [...atomicToMerged.keys()].sort()) {
    const entries = atomicToMerged.get(sub);
    entries.sort((a, b) => (a.mergedType < b.mergedType ? -1 : 1));
    lines.push(`${prefix}${sub}:`);
    entries.forEach((e, i) => {
      const sep = i === 0 ? '\t' : '\t| ';
      lines.push(`${sep}${e.mergedType} @${e.weight}`);
    });
    lines.push('\t;');
  }
  return lines.join('\n') + '\n';
}
