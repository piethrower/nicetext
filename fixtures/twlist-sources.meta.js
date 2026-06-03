// AUTO-GENERATED. Do not edit by hand.
//
// Source of truth: tools/build-twlist-fixtures.js SOURCE_METADATA.
// Regenerate with: node tools/build-twlist-fixtures.js (or
// node tools/build-all-fixtures.js for the full pipeline).
//
// Same content as fixtures/twlist-sources.meta.json, exported as an
// ES module so js/app.js can import it synchronously alongside
// fixtures/cards.data.js. The .json sibling stays for tooling.
export default [
  {
    "key": "emoji-curated-phrases-16",
    "filename": "emoji-curated-phrases-16.twlist.tsv.gz",
    "group": "Emoji",
    "label": "Common emoji combinations",
    "description": "A small library of common emoji combinations humans actually use (\"love 😍\", \"🌹 💐\", \"coffee ☕\"). When the sample text contains one of these combos as adjacent tokens, the engine recognizes the whole phrase as one unit and can substitute it with another phrase from the same category.",
    "types": 25,
    "words": 56,
    "rows": 56,
    "bytes": 1031
  },
  {
    "key": "emoji16",
    "filename": "emoji16.twlist.tsv.gz",
    "group": "Emoji",
    "label": "Emoji",
    "description": "Adds emoji glyphs to the dictionary, sorted into 97 categories. Within a category, any emoji can substitute for another.",
    "types": 98,
    "words": 3767,
    "rows": 3767,
    "bytes": 12813
  },
  {
    "key": "emoji-cldr-names-16",
    "filename": "emoji-cldr-names-16.twlist.tsv.gz",
    "group": "Emoji",
    "label": "Emoji inspired word-only phrases",
    "description": "Adds written-out emoji names as multi-word phrases under the same categories. The engine treats these as phrases when they appear in the sample text. Used alone, covers stay text-only; paired with Emoji, categories mix glyphs and phrases.",
    "types": 95,
    "words": 1046,
    "rows": 1046,
    "bytes": 8300
  },
  {
    "key": "emoji16-curated-keywords",
    "filename": "emoji16-curated-keywords.twlist.tsv.gz",
    "group": "Emoji",
    "label": "Filter weird emoji matches",
    "description": "Only affects \"Emoji into words\" and \"Words into emoji\". Without it, an emoji can swap in via any tangential keyword (the classic example: 💩 has \"face\" as a keyword, so \"his face turned red\" can become \"his 💩 turned red\"). With it on, only natural keyword pivots are used.",
    "types": 2,
    "words": 3574,
    "rows": 3574,
    "bytes": 13158
  },
  {
    "key": "claude2026",
    "filename": "claude2026.twlist.tsv.gz",
    "group": "Jargon",
    "label": "Modern words",
    "description": "A small set of contemporary vocabulary (AI terms, modern brands, recent slang).",
    "types": 83,
    "words": 3878,
    "rows": 4101,
    "bytes": 21448
  },
  {
    "key": "proglang-keywords",
    "filename": "proglang-keywords.twlist.tsv.gz",
    "group": "Jargon",
    "label": "Programming keywords",
    "description": "Reserved words and built-in identifiers from common programming languages and shells (C, Python, Bash, JS, ...).",
    "types": 3302,
    "words": 2022,
    "rows": 3303,
    "bytes": 19917
  },
  {
    "key": "impkimmo2026-cform",
    "filename": "impkimmo2026-cform.twlist.tsv.gz",
    "group": "Morphology",
    "label": "Contractions",
    "description": "Distinguishes the seven contracted clitic forms: cat's (genitive) vs cat's (has) vs cat's (is) vs they'll vs they'd vs you'd've.",
    "types": 8,
    "words": 393407,
    "rows": 595812,
    "bytes": 1791009
  },
  {
    "key": "impkimmo2026",
    "filename": "impkimmo2026.twlist.tsv.gz",
    "group": "Morphology",
    "label": "Word tags (large set)",
    "description": "Parts of speech plus inflection tags, with fuller coverage of inflected and contracted forms.",
    "types": 337,
    "words": 3429639,
    "rows": 4541844,
    "bytes": 16663618
  },
  {
    "key": "impkimmo",
    "filename": "impkimmo.twlist.tsv.gz",
    "group": "Morphology",
    "label": "Word tags (small set)",
    "description": "Parts of speech plus inflection tags (tense, number, person, ...).",
    "types": 143,
    "words": 94261,
    "rows": 101349,
    "bytes": 400436
  },
  {
    "key": "mit",
    "filename": "mit.twlist.tsv.gz",
    "group": "Names",
    "label": "Names and places",
    "description": "First names, last names, and place names.",
    "types": 6,
    "words": 27606,
    "rows": 28216,
    "bytes": 97796
  },
  {
    "key": "num-form-preserved",
    "filename": "num-form-preserved.twlist.tsv.gz",
    "group": "Numbers",
    "label": "Numbers (keep original form)",
    "description": "Cardinal, ordinal, percent, and year values keep their original surface form: 47 stays a digit, forty-seven stays a word.",
    "types": 46,
    "words": 14096,
    "rows": 14096,
    "bytes": 41583
  },
  {
    "key": "num-form-interchangeable",
    "filename": "num-form-interchangeable.twlist.tsv.gz",
    "group": "Numbers",
    "label": "Numbers (swap digits and words)",
    "description": "Cardinal, ordinal, percent, and year values can swap between digit and word form: 47 and forty-seven are picked from the same slot.",
    "types": 34,
    "words": 14096,
    "rows": 14096,
    "bytes": 41973
  },
  {
    "key": "num-roman",
    "filename": "num-roman.twlist.tsv.gz",
    "group": "Numbers",
    "label": "Roman numerals",
    "description": "Numeric values written as Roman numerals (I, IV, X, MCMLXXXIV, ...).",
    "types": 7,
    "words": 4000,
    "rows": 4000,
    "bytes": 6872
  },
  {
    "key": "moby-pos",
    "filename": "moby-pos.twlist.tsv.gz",
    "group": "Parts of Speech",
    "label": "Parts of speech (broad)",
    "description": "Flat part-of-speech tags (noun, verb, adjective, ...) for ~110K words.",
    "types": 15,
    "words": 232005,
    "rows": 250781,
    "bytes": 985638
  },
  {
    "key": "wordnet",
    "filename": "wordnet.twlist.tsv.gz",
    "group": "Parts of Speech",
    "label": "Parts of speech (standard)",
    "description": "Flat part-of-speech tags (noun, verb, adjective, adverb).",
    "types": 5,
    "words": 146837,
    "rows": 154807,
    "bytes": 695487
  },
  {
    "key": "cmu-alliteration",
    "filename": "cmu-alliteration.twlist.tsv.gz",
    "group": "Poetry/Song",
    "label": "Alliteration",
    "description": "Groups words by their first phoneme (allit_K, allit_S, allit_TH, ...). Enables alliterative runs within a sentence model, useful for tongue twisters and rhetorical emphasis.",
    "types": 39,
    "words": 125930,
    "rows": 127178,
    "bytes": 384462
  },
  {
    "key": "rhyme",
    "filename": "rhyme.twlist.tsv.gz",
    "group": "Poetry/Song",
    "label": "Rhymes",
    "description": "Rhyme groups, words that share an end-rhyme cluster together.",
    "types": 7357,
    "words": 47896,
    "rows": 132254,
    "bytes": 506537
  },
  {
    "key": "cmu-stress",
    "filename": "cmu-stress.twlist.tsv.gz",
    "group": "Poetry/Song",
    "label": "Stress pattern",
    "description": "Groups words by their full stress sequence. Iambic words (\"be-LOW\") under stress_01, trochaic (\"GAR-den\") under stress_10, anapestic under stress_001, dactylic under stress_100, and so on. Enables iambic pentameter, anapestic limericks, and other metrical forms.",
    "types": 300,
    "words": 125923,
    "rows": 129009,
    "bytes": 438476
  },
  {
    "key": "cmu-syllable",
    "filename": "cmu-syllable.twlist.tsv.gz",
    "group": "Poetry/Song",
    "label": "Syllable count",
    "description": "Buckets words by syllable count (syl_1 through syl_12). Enables fixed-syllable forms like haiku (5-7-5) and meter-aware sentence models.",
    "types": 11,
    "words": 125923,
    "rows": 127630,
    "bytes": 404826
  },
  {
    "key": "impf2p",
    "filename": "impf2p.twlist.tsv.gz",
    "group": "Synonyms",
    "label": "Synonyms (small set)",
    "description": "Synonym clusters, interchangeable substitutes within each cluster.",
    "types": 7063,
    "words": 48317,
    "rows": 48317,
    "bytes": 251717
  },
  {
    "key": "wordnet-synonyms",
    "filename": "wordnet-synonyms.twlist.tsv.gz",
    "group": "Synonyms",
    "label": "Synonyms (standard)",
    "description": "Synonym sets (synsets), fine-grained word meanings grouped by sense.",
    "types": 117215,
    "words": 147839,
    "rows": 205418,
    "bytes": 1462038
  },
  {
    "key": "moby-thesaurus",
    "filename": "moby-thesaurus.twlist.tsv.gz",
    "group": "Synonyms",
    "label": "Synonyms (very large)",
    "description": "Synonym clusters from a very large public-domain thesaurus.",
    "types": 25781,
    "words": 298740,
    "rows": 2550149,
    "bytes": 12178476
  },
  {
    "key": "impkimmo2026-root",
    "filename": "impkimmo2026-root.twlist.tsv.gz",
    "group": "Synonyms",
    "label": "Word roots",
    "description": "Groups every inflection and derivation under its root morpheme, cat/cats/cat's share a type, run/running/runner share a type.",
    "types": 17082,
    "words": 3429639,
    "rows": 3646107,
    "bytes": 12742422
  },
  {
    "key": "impkimmo2026-drvstem",
    "filename": "impkimmo2026-drvstem.twlist.tsv.gz",
    "group": "Experimentation",
    "label": "Built-from-suffix flag",
    "description": "A simple yes/no tag: was this word built by adding a suffix to a root (happiness, runner), or is it the bare root (cat, run)?",
    "types": 3,
    "words": 2015559,
    "rows": 2030281,
    "bytes": 6698130
  },
  {
    "key": "connectors",
    "filename": "connectors.twlist.tsv.gz",
    "group": "Experimentation",
    "label": "Example Connector Words",
    "description": "Short grammatical joiners (and, of, to, from, in, ...) required by the Names and Places (MIT) card's grammar rules. Other cards don't need this; kimmo (morphology) and POS sources already cover these words with richer types that sortDict prefers.",
    "types": 13,
    "words": 13,
    "rows": 13,
    "bytes": 415
  },
  {
    "key": "impkimmo2026-rootpos",
    "filename": "impkimmo2026-rootpos.twlist.tsv.gz",
    "group": "Experimentation",
    "label": "Root part of speech",
    "description": "The part of speech of the word's root before suffixes were added. Example: 'happiness' was built from 'happy' (an adjective), so it gets tagged adjective. 'Runner' was built from 'run' (a verb), tagged verb. 'Nationalize' was built from 'nation' (a noun), tagged noun.",
    "types": 12,
    "words": 2408343,
    "rows": 2606656,
    "bytes": 8372840
  }
];
