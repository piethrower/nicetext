#!/usr/bin/env node
// build-twlist-fixtures.js: emit per-source TW-list fixtures for the
// session-base-dictionary feature in nicetext.html. Each fixture is the
// raw post-expansion TW-list for one base-dict checkbox category.
// Vowel augmentation is NOT baked here; the worker applies it post-concat.

import { writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadResource } from '../js/src/resource-loader.js';

import {
  parseTwlistLines, expandMitlist, expandNumeric,
} from '../js/src/builder/sources.js';
import { tokenize, TOKEN } from '../js/src/lexer.js';

import { FIXTURES_PREFIX } from '../js/src/byos.js';
import { getRedactedSingles, redactTwlistEntries } from '../js/src/builder/redaction.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPORA = join(ROOT, 'fixture-src', 'twlist');
const OUT = join(ROOT, FIXTURES_PREFIX);

// ──────────────────────────────────────────────────────────────────────
// Source metadata table, single source of truth for the BYOS UI.
//
// Each row binds a per-fixture `key` to the human-facing checkbox
// label, the group it belongs to in the (eventual) tabular BYOS list,
// and the one-line description shown as hint text. writeFixture()
// looks up this table by key and emits `# group:`, `# label:`,
// `# description:` lines into the fixture header. After every fixture
// is written, the build emits `fixtures/twlist-sources.meta.json`, a
// consolidated index of the same data plus the computed (types, words)
// counts for each fixture. UI code loads that JSON instead of
// hand-maintaining a parallel label map in share.js / app.js.
//
// Groups are short (Connectors, Morphology, Names, Numbers, Parts of
// Speech, Phrases, Rhymes, Synonyms, Vocabulary, Other). Custom is
// not a source and is rendered separately by the UI.
const SOURCE_META = {
  // Morphology
  impkimmo: {
    group: 'Morphology',
    label: 'Word tags (small set)',
    description: 'Parts of speech plus inflection tags (tense, number, person, ...).',
  },
  impkimmo2026: {
    group: 'Morphology',
    label: 'Word tags (large set)',
    description: 'Parts of speech plus inflection tags, with fuller coverage of inflected and contracted forms.',
  },
  'impkimmo2026-cform': {
    group: 'Morphology',
    label: 'Contractions',
    description: "Distinguishes the seven contracted clitic forms: cat's (genitive) vs cat's (has) vs cat's (is) vs they'll vs they'd vs you'd've.",
  },
  // Word roots fits the Synonyms group's "preserve meaning" use case,
  // every inflection / derivation of the same root cluster together.
  'impkimmo2026-root': {
    group: 'Synonyms',
    label: 'Word roots',
    description: "Groups every inflection and derivation under its root morpheme, cat/cats/cat's share a type, run/running/runner share a type.",
  },
  // Root part of speech + Built-from-suffix flag are structural-only
  // (no clean semantic / grammatical / poetic use case), they live
  // in the Experimentation group at the bottom of the picker.
  'impkimmo2026-rootpos': {
    group: 'Experimentation',
    label: 'Root part of speech',
    description: "The part of speech of the word's root before suffixes were added. Example: 'happiness' was built from 'happy' (an adjective), so it gets tagged adjective. 'Runner' was built from 'run' (a verb), tagged verb. 'Nationalize' was built from 'nation' (a noun), tagged noun.",
  },
  'impkimmo2026-drvstem': {
    group: 'Experimentation',
    label: 'Built-from-suffix flag',
    description: 'A simple yes/no tag: was this word built by adding a suffix to a root (happiness, runner), or is it the bare root (cat, run)?',
  },

  // Parts of Speech
  'moby-pos': {
    group: 'Parts of Speech',
    label: 'Parts of speech (broad)',
    description: 'Flat part-of-speech tags (noun, verb, adjective, ...) for ~110K words.',
  },
  wordnet: {
    group: 'Parts of Speech',
    label: 'Parts of speech (standard)',
    description: 'Flat part-of-speech tags (noun, verb, adjective, adverb).',
  },
  // Only meaningful when a card's CFG grammar references these words as
  // _UNIQUE_<word> tokens (today: just MIT/mit-names.def). Any card that
  // includes kimmo or a POS source already covers these words with
  // richer tags, and sortDict's _UNIQUE_ drop-rule strips this fixture's
  // contribution. Stays in Experimentation rather than POS.
  connectors: {
    group: 'Experimentation',
    label: 'Example Connector Words',
    description: 'Short grammatical joiners (and, of, to, from, in, ...) required by the Names and Places (MIT) card\'s grammar rules. Other cards don\'t need this; kimmo (morphology) and POS sources already cover these words with richer types that sortDict prefers.',
  },

  // Synonyms
  impf2p: {
    group: 'Synonyms',
    label: 'Synonyms (small set)',
    description: 'Synonym clusters, interchangeable substitutes within each cluster.',
  },
  'moby-thesaurus': {
    group: 'Synonyms',
    label: 'Synonyms (very large)',
    description: 'Synonym clusters from a very large public-domain thesaurus.',
  },
  'wordnet-synonyms': {
    group: 'Synonyms',
    label: 'Synonyms (standard)',
    description: 'Synonym sets (synsets), fine-grained word meanings grouped by sense.',
  },

  // Poetry/Song (was: Rhymes). All four entries derive from the CMU
  // Pronouncing Dictionary's ARPABET phoneme transcriptions: rhyme is
  // the OG NiceText artifact (end-rhyme groups), the three cmu-* are
  // metrical-features siblings (syllable count, stress pattern, first
  // phoneme). Cards aiming at a specific poetic form (haiku, limerick,
  // sonnet, ...) opt into the subset their structure constrains.
  rhyme: {
    group: 'Poetry/Song',
    label: 'Rhymes',
    description: 'Rhyme groups, words that share an end-rhyme cluster together.',
  },
  'cmu-syllable': {
    group: 'Poetry/Song',
    label: 'Syllable count',
    description: 'Buckets words by syllable count (syl_1 through syl_12). Enables fixed-syllable forms like haiku (5-7-5) and meter-aware sentence models.',
  },
  'cmu-stress': {
    group: 'Poetry/Song',
    label: 'Stress pattern',
    description: 'Groups words by their full stress sequence. Iambic words ("be-LOW") under stress_01, trochaic ("GAR-den") under stress_10, anapestic under stress_001, dactylic under stress_100, and so on. Enables iambic pentameter, anapestic limericks, and other metrical forms.',
  },
  'cmu-alliteration': {
    group: 'Poetry/Song',
    label: 'Alliteration',
    description: 'Groups words by their first phoneme (allit_K, allit_S, allit_TH, ...). Enables alliterative runs within a sentence model, useful for tongue twisters and rhetorical emphasis.',
  },

  // Names
  mit: {
    group: 'Names',
    label: 'Names and places',
    description: 'First names, last names, and place names.',
  },

  // Numbers
  'num-form-preserved': {
    group: 'Numbers',
    label: 'Numbers (keep original form)',
    description: 'Cardinal, ordinal, percent, and year values keep their original surface form: 47 stays a digit, forty-seven stays a word.',
  },
  'num-form-interchangeable': {
    group: 'Numbers',
    label: 'Numbers (swap digits and words)',
    description: 'Cardinal, ordinal, percent, and year values can swap between digit and word form: 47 and forty-seven are picked from the same slot.',
  },
  'num-roman': {
    group: 'Numbers',
    label: 'Roman numerals',
    description: 'Numeric values written as Roman numerals (I, IV, X, MCMLXXXIV, ...).',
  },

  // Emoji: single emojis, the curated keyword filter (used by the
  // cross-modal aug), and the two multi-token phrase fixtures. All
  // four sit in one group so the picker presents emoji-related
  // choices side by side.
  emoji16: {
    group: 'Emoji',
    label: 'Emoji',
    // Description renders rich in app.js (appendSourceRow uses
    // EMOJI_ITEM_RICH_DESCRIPTIONS for these four items). The plain
    // string here is the fallback for tooling that reads the meta
    // directly.
    description: 'Adds emoji glyphs to the dictionary, sorted into 97 categories. Within a category, any emoji can substitute for another.',
  },
  'emoji16-curated-keywords': {
    group: 'Emoji',
    label: 'Filter weird emoji matches',
    description: 'Only affects "Emoji into words" and "Words into emoji". Without it, an emoji can swap in via any tangential keyword (the classic example: 💩 has "face" as a keyword, so "his face turned red" can become "his 💩 turned red"). With it on, only natural keyword pivots are used.',
  },
  'emoji-curated-phrases-16': {
    group: 'Emoji',
    label: 'Common emoji combinations',
    description: 'A small library of common emoji combinations humans actually use ("love 😍", "🌹 💐", "coffee ☕"). When the sample text contains one of these combos as adjacent tokens, the engine recognizes the whole phrase as one unit and can substitute it with another phrase from the same category.',
  },
  'emoji-cldr-names-16': {
    group: 'Emoji',
    label: 'Emoji inspired word-only phrases',
    description: 'Adds written-out emoji names as multi-word phrases under the same categories. The engine treats these as phrases when they appear in the sample text. Used alone, covers stay text-only; paired with Emoji, categories mix glyphs and phrases.',
  },

  // Jargon (was: Vocabulary)
  claude2026: {
    group: 'Jargon',
    label: 'Modern words',
    description: 'A small set of contemporary vocabulary (AI terms, modern brands, recent slang).',
  },
  'proglang-keywords': {
    group: 'Jargon',
    label: 'Programming keywords',
    description: 'Reserved words and built-in identifiers from common programming languages and shells (C, Python, Bash, JS, ...).',
  },
};

// Manifest collected during build; written out as
// fixtures/twlist-sources.meta.json at the end.
const FIXTURE_MANIFEST = [];

// WordNet 3.0 license text. Princeton's terms require the notice
// "appear on ALL copies of the software, database and documentation,
// including modifications." Emitted as `# attribution: ...` header
// comment lines at the top of the TSV fixture so any downstream reader
// inspecting the file sees the notice. The same text is reproduced on
// attributions.html which is the page-level attribution surface.
const WORDNET_LICENSE = [
  'This software and database is being provided to you, the LICENSEE, by Princeton University under the following license. By obtaining, using and/or copying this software and database, you agree that you have read, understood, and will comply with these terms and conditions.:',
  '',
  'Permission to use, copy, modify and distribute this software and database and its documentation for any purpose and without fee or royalty is hereby granted, provided that you agree to comply with the following copyright notice and statements, including the disclaimer, and that the same appear on ALL copies of the software, database and documentation, including modifications that you make for internal use or for distribution.',
  '',
  'WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.',
  '',
  'THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANT-ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.',
  '',
  'The name of Princeton University or Princeton may not be used in advertising or publicity pertaining to distribution of the software and/or database. Title to copyright in this software, database and any associated documentation shall at all times remain with Princeton University and LICENSEE agrees to preserve same.',
].join('\n');

// All file reads route through the shared resource-loader. The
// loader's `raw-bytes` kind returns gunzipped bytes for .gz URLs
// transparently; non-.gz URLs come back verbatim. TextDecoder
// can't read SharedArrayBuffer-backed views, so we copy through
// a private ArrayBuffer first.
async function readMaybeGz(path) {
  // fixture:false routes the URL through the raw-bytes channel
  // instead of treating it as a fixtures/<name> prefix.
  const sab = await loadResource(pathToFileURL(path), 'raw-bytes', { fixture: false });
  const view = new Uint8Array(sab);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new TextDecoder('utf-8').decode(copy);
}

// Parse Moby Part-of-Speech II's "word\codes" format. Each character
// of the codes field is a POS tag from the source's legend (N, p, h,
// V, t, i, A, v, C, P, !, r, D, I, o); we emit "moby_<code>" verbatim
// per the chosen prefix scheme. Multiple codes per word produce one
// entry per (word, code) combination, deduped within a row.
function parseMobyPos(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf('\\');
    if (idx < 0) continue;
    const word = line.slice(0, idx).trim();
    const codes = line.slice(idx + 1);
    if (!word || !codes) continue;
    const seen = new Set();
    for (const ch of codes) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push({ type: `moby_${ch}`, word });
    }
  }
  return out;
}

// Parse Moby Thesaurus II's comma-separated synonym groups. The first
// token on each line is the headword; the type is "moby_<headword>"
// verbatim. Every member of the group (head + synonyms) becomes a
// word entry under that type.
function parseMobyThesaurus(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const type = `moby_${parts[0]}`;
    for (const w of parts) out.push({ type, word: w });
  }
  return out;
}

// Parse a WordNet 3.0 data.<pos> file into per-synset entries. Data
// lines (skipping the license header lines that start with a space)
// have the shape:
//   "<offset> <lex_filenum> <ss_type> <w_cnt(hex)> <word> <lex_id> [...] <p_cnt> ..."
// followed by pointers, optional verb frames, and a " | <gloss>"
// trailer. We take only the (offset, ss_type, words) and emit one
// entry per (synset, word) pair under type "wordnet_<ss_type>_<offset>"
// (the 8-digit synset_offset is the stable identifier within
// data.<pos>; offsets repeat across pos files but the ss_type prefix
// disambiguates). Lemmas use "_" for word-internal spaces, restored
// here.
function parseWordnetSynsets(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith(' ')) continue;
    const parts = raw.split(' ');
    if (parts.length < 5) continue;
    const offset = parts[0];
    const ssType = parts[2];
    const wCnt = parseInt(parts[3], 16);
    if (!Number.isFinite(wCnt) || wCnt <= 0) continue;
    const type = `wordnet_${ssType}_${offset}`;
    for (let i = 0; i < wCnt; i++) {
      const word = parts[4 + i * 2];
      if (!word) break;
      out.push({ type, word: word.replace(/_/g, ' ') });
    }
  }
  return out;
}

// Parse a WordNet 3.0 index.<pos> file. Lines that start with a space
// are part of the 29-line license header. Data lines are
// "<lemma> <pos> <synset_cnt> ..." where <pos> is a single character
// (n, v, a, r, s). Lemmas use "_" for word-internal spaces. Type is
// "wordnet_<pos>" verbatim, including 's' (adjective satellite) kept
// separate from 'a'.
function parseWordnetIndex(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith(' ')) continue;
    const space = raw.indexOf(' ');
    if (space < 0) continue;
    const lemma = raw.slice(0, space);
    const pos = raw.charAt(space + 1);
    if (!pos) continue;
    out.push({ type: `wordnet_${pos}`, word: lemma.replace(/_/g, ' ') });
  }
  return out;
}

async function loadTwlistFile(path, label) {
  if (!existsSync(path)) { process.stderr.write(`(skip: ${label} not found)\n`); return []; }
  const entries = parseTwlistLines(await readMaybeGz(path));
  process.stderr.write(`  ${label}: ${entries.length} entries\n`);
  return entries;
}

async function loadTwlistDir(dir, label) {
  if (!existsSync(dir)) { process.stderr.write(`(skip: ${label} not found)\n`); return []; }
  const files = readdirSync(dir).filter(f => f.endsWith('.twlist') || f.endsWith('.twlist.gz')).sort();
  const out = [];
  for (const f of files) out.push(...await loadTwlistFile(join(dir, f), `${label}/${f}`));
  return out;
}

// proglang-keywords loader. Per-language source files use the convention
// `<lang>_<keyword><TAB><keyword>`. We deliberately author the full
// keyword set including underscore-bearing forms (`php_is_array`,
// `python___init__`, `c++_size_t`) even though today's lexer punctuates
// `_` and so rule 2 rejects those values at fixture-write time. The
// originals are preserved in source as future-proofing: any lexer change
// that admits underscore-inside-WORD reactivates them automatically.
//
// Alongside the originals, we synthesize per-WORD split-fragment rows
// for any value rule 2 would reject: lex the value, extract its WORD
// tokens, and emit `<lang>_split_<word><TAB><word>` for each unique
// WORD. Today those fragments are the only way the language's
// underscore-bearing identifiers contribute vocabulary to a session
// dict built with the proglang-keywords source. `<lang>` is the
// substring of the type column up to the first `_` (so `php_is_array`
// → `php`, `linux-commands_some_thing` → `linux-commands`).
//
// Originals and fragments are both passed to writeFixture as raw
// entries. writeFixture's parseTwlistLines round-trip is the single
// admission gate: rejected originals fall away with a logged drop
// count, fragments admit by construction.
async function loadProglangKeywordsDir(dir, label) {
  if (!existsSync(dir)) { process.stderr.write(`(skip: ${label} not found)\n`); return []; }
  const files = readdirSync(dir).filter(f => f.endsWith('.twlist') || f.endsWith('.twlist.gz')).sort();
  const out = [];
  for (const f of files) {
    const path = join(dir, f);
    const text = await readMaybeGz(path);
    let originals = 0;
    let rejectedOriginals = 0;
    let fragmentsBeforeDedup = 0;
    const fragmentKeySeen = new Set();
    let fragmentsAfterDedup = 0;
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line || line.startsWith('#')) continue;
      const m = /^(\S+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const type = m[1];
      const value = m[2];
      out.push({ type, word: value });
      originals++;
      // Decide rule-2 admission by hand so we can decide whether to
      // also emit fragments.
      const wordTokens = [];
      let ruleTwoOk = true;
      for (const tok of tokenize(value)) {
        if (tok.type === TOKEN.WORD) wordTokens.push(tok.value);
        else if (tok.type !== TOKEN.WHITESPACE) { ruleTwoOk = false; }
      }
      if (ruleTwoOk) continue;
      rejectedOriginals++;
      const lang = type.split('_')[0];
      const perRowSeen = new Set();
      for (const w of wordTokens) {
        if (perRowSeen.has(w)) continue;
        perRowSeen.add(w);
        fragmentsBeforeDedup++;
        const fragType = `${lang}_split_${w}`;
        const key = `${fragType}\t${w}`;
        if (fragmentKeySeen.has(key)) continue;
        fragmentKeySeen.add(key);
        fragmentsAfterDedup++;
        out.push({ type: fragType, word: w });
      }
    }
    process.stderr.write(`  ${label}/${f}: ${originals} originals (${rejectedOriginals} rule-2-rejected by today's lexer); ${fragmentsAfterDedup} split fragments (from ${fragmentsBeforeDedup} pre-dedup)\n`);
  }
  return out;
}

async function readNamed(dir, names) {
  const out = {};
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) out[n] = await readMaybeGz(p);
    else process.stderr.write(`(skip: ${n} not found)\n`);
  }
  return out;
}

// Snake-case a CLDR/Unicode subgroup name for use as a TW-list type
// identifier. Lowercase, replace any non-`[a-z0-9]` run with a single
// '_', strip leading/trailing '_'. Examples:
//   "face-smiling"   → "face_smiling"
//   "arts & crafts"  → "arts_crafts"
//   "country-flag"   → "country_flag"
function snakeSubgroup(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Parse Unicode emoji-test.txt into per-subgroup fully-qualified entries.
// Walks the file in order; each `# group: <name>` and `# subgroup: <name>`
// line shifts the active subgroup. Data lines have shape:
//   "<HEX> [<HEX> ...] ; <status> # <emoji> E<ver> <name>"
// We keep only fully-qualified entries (the RGI set + emoji presentation
// variants); skin-tone components (1F3FB-1F3FF) and other component
// rows are excluded, they aren't usable standalone emoji. Codepoint
// hex sequences decode via String.fromCodePoint(...). Type tag is
// `em16_<snakeCase(subgroup)>`.
function parseEmojiTest(text) {
  const out = [];
  let subgroup = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('# subgroup:')) { subgroup = raw.slice(11).trim(); continue; }
    if (raw.startsWith('# group:')) { subgroup = null; continue; }
    if (!raw || raw.startsWith('#')) continue;
    const semi = raw.indexOf(';');
    if (semi < 0) continue;
    const cps = raw.slice(0, semi).trim();
    const status = raw.slice(semi + 1).trim().split(/\s+/)[0];
    if (status !== 'fully-qualified') continue;
    if (!subgroup) continue;
    const word = cps.split(/\s+/).map(h => String.fromCodePoint(parseInt(h, 16))).join('');
    out.push({ type: `em16_${snakeSubgroup(subgroup)}`, word });
  }
  return out;
}

// Parse a CLDR annotations XML file into two Maps keyed by emoji
// string: `keywords` (the pipe-separated semantic synonyms, used by
// Aug A / Aug B / Aug-mix for cross-modal lookup) and `names` (the
// type="tts" spoken-name strings, used to derive multi-word phrase
// entries under em16_<subgroup> types). Decodes the three HTML
// entities CLDR uses (&amp; &lt; &gt;). CLDR strips U+FE0F from cp
// values per its file header; consume sites should match against both
// with-VS16 and without-VS16 forms when needed.
function parseCldrAnnotations(xml) {
  const keywords = new Map();
  const names = new Map();
  const RE = /<annotation\s+cp="([^"]+)"(\s+type="tts")?>([^<]*)<\/annotation>/g;
  let m;
  while ((m = RE.exec(xml)) !== null) {
    const cp = decodeXmlEntities(m[1]);
    const body = decodeXmlEntities(m[3]);
    if (m[2]) {
      names.set(cp, body.trim());
      continue;
    }
    const ks = body.split('|').map(s => s.trim()).filter(Boolean);
    if (!ks.length) continue;
    const existing = keywords.get(cp);
    if (existing) {
      const seen = new Set(existing);
      for (const k of ks) if (!seen.has(k)) existing.push(k);
    } else {
      keywords.set(cp, ks);
    }
  }
  return { keywords, names };
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Build a fully-qualified-keyed CLDR keyword map for emoji shipped in
// emoji16.twlist. CLDR strips U+FE0F from its cp values, so for each
// fully-qualified emoji we look up keywords under the FE0F-stripped
// form. Merges base annotations and derived annotations (derived covers
// composite sequences: skin-tone variants, ZWJ families, flag pairs).
function buildEmojiCldrMap(emojiEntries, basePack, derivedPack) {
  const out = {};
  for (const e of emojiEntries) {
    const stripped = e.word.replace(/\uFE0F/g, '');
    const keywords = [];
    const seen = new Set();
    for (const pack of [basePack, derivedPack]) {
      const ks = pack.keywords.get(stripped) || pack.keywords.get(e.word);
      if (!ks) continue;
      for (const k of ks) {
        if (seen.has(k)) continue;
        seen.add(k);
        keywords.push(k);
      }
    }
    if (keywords.length) out[e.word] = keywords;
  }
  return out;
}

// CLDR-derived word phrases: for each emoji E whose CLDR tts ("spoken
// name") field is a multi-word string, emit a TW-list row
// `(em16_<subgroup-of-E>, <name>)`. Names like "alarm clock",
// "rolling on the floor laughing", "national park" land directly.
// Flag names ("flag: United States", "flag: South Korea") strip the
// "flag: " prefix \u2192 "United States". The emoji's keyword list (single-
// word synonyms) is the separate cldr.json sidecar consumed by Aug
// A/B/mix; this fixture is bake-time content for cross-modal slot
// composition. parseTwlistLines (called by writeFixture) gates
// admission via the standard rule-2 lexer round-trip; entries that
// contain non-Latin characters or non-WORD/WHITESPACE structure are
// dropped.
function buildEmojiPhraseEntries(emojiEntries, basePack, derivedPack) {
  const out = [];
  const seen = new Set();
  for (const e of emojiEntries) {
    const stripped = e.word.replace(/\uFE0F/g, '');
    let name = derivedPack.names.get(stripped)
            || derivedPack.names.get(e.word)
            || basePack.names.get(stripped)
            || basePack.names.get(e.word);
    if (!name) continue;
    name = name.replace(/^flag:\s+/i, '').trim();
    if (!/\s/.test(name)) continue;
    const key = `${e.type}\t${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: e.type, word: name });
  }
  return out;
}

// Write a JSON.gz fixture (CLDR sidecar). No header comments, the
// runtime worker fetches via fetchJSON which routes .gz through
// DecompressionStream.
function writeJsonFixture(filename, payload) {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${filename}.gz`);
  const json = JSON.stringify(payload);
  const gz = gzipSync(json, { level: zlibConstants.Z_BEST_COMPRESSION });
  writeFileSync(path, gz);
  process.stderr.write(`  wrote ${filename}.gz (${Object.keys(payload).length} entries, ${gz.length.toLocaleString()} bytes)\n`);
}

function writeFixture(filename, header, entries) {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${filename}.gz`);
  // Look up group / label / description by the source `key` if the
  // caller provided one. The key matches the filename's source stem
  // (e.g. `impkimmo2026-cform`). If a row isn't in SOURCE_META we
  // still write the fixture, just without group/description headers.
  const meta = header.key ? SOURCE_META[header.key] : null;
  const headerLines = [];
  if (header.title || meta?.label) {
    headerLines.push(`# title: ${header.title || meta.label}`);
  }
  if (meta?.group)       headerLines.push(`# group: ${meta.group}`);
  if (meta?.description) headerLines.push(`# description: ${meta.description}`);
  // Apply the redaction filter at this twlist producer seam:
  // drop entries whose word is in the redacted singles set, then
  // prepend the (REDACTED, **redacted**) marker. Same function used
  // by every twlist consumer (sortDict) and runtime producer (custom
  // upload). See js/src/builder/redaction.js.
  const redactedEntries = redactTwlistEntries(entries, _writeFixtureRedactedSingles);
  // Round-trip entries through the same parseTwlistLines the consuming
  // side uses, so the on-disk fixture cannot contain rows that would be
  // silently dropped at session-build time. One sanity check, one place.
  const candidate = redactedEntries.map(e => `${e.type}\t${e.word}`).join('\n');
  const filtered = parseTwlistLines(candidate);
  const dropped = redactedEntries.length - filtered.length;
  const redactedCount = (entries.length + 1) - redactedEntries.length;
  // Distinct (type) and (word) counts, computed from the post-filter
  // rows. These match what `awk '{print $1}' | sort -u | wc -l`
  // would report against the gzipped fixture.
  const typeSet = new Set();
  const wordSet = new Set();
  for (const e of filtered) { typeSet.add(e.type); wordSet.add(e.word); }
  headerLines.push(`# types: ${typeSet.size}`);
  headerLines.push(`# words: ${wordSet.size}`);
  if (header.attribution) {
    const attr = String(header.attribution);
    for (const line of attr.split('\n')) headerLines.push(`# attribution: ${line}`);
  }
  const body = headerLines.length ? headerLines.join('\n') + '\n' : '';
  const tsv = body + filtered.map(e => `${e.type}\t${e.word}`).join('\n') + '\n';
  const gz = gzipSync(tsv, { level: zlibConstants.Z_BEST_COMPRESSION });
  writeFileSync(path, gz);
  const noteParts = [];
  if (dropped)        noteParts.push(`${dropped} dropped by import gates`);
  if (redactedCount)  noteParts.push(`${redactedCount} dropped by redaction gate`);
  const note = noteParts.length ? ` (${noteParts.join('; ')})` : '';
  process.stderr.write(`  wrote ${filename}.gz (${filtered.length} entries, ${typeSet.size} types, ${wordSet.size} words${note}, ${gz.length.toLocaleString()} bytes)\n`);
  // Manifest entry for the consolidated meta.json.
  FIXTURE_MANIFEST.push({
    key: header.key || null,
    filename: `${filename}.gz`,
    group: meta?.group ?? null,
    label: meta?.label ?? header.title ?? null,
    description: meta?.description ?? null,
    types: typeSet.size,
    words: wordSet.size,
    rows: filtered.length,
    bytes: gz.length,
  });
  return filtered.length;
}

// Module-level cache for the redacted singles set. Loaded once at
// the start of main() and read by writeFixture for every twlist
// source. writeFixture is sync; pre-loading the async resource keeps
// it sync at the per-fixture loop.
let _writeFixtureRedactedSingles = null;

async function main() {
  process.stderr.write('reading sources...\n');
  _writeFixtureRedactedSingles = await getRedactedSingles();
  let total = 0;

  total += writeFixture('impf2p.twlist.tsv', {
    key: 'impf2p',
    attribution: 'Imperfect F2P synonym/inflectional list, OG NiceText 1.0 source corpora.',
  }, await loadTwlistFile(join(CORPORA, 'impf2p', 'f2p.twlist.gz'), 'impf2p'));

  total += writeFixture('impkimmo.twlist.tsv', {
    key: 'impkimmo',
    attribution: 'Imperfect Kimmo morphological tagger output, OG NiceText 1.0 source corpora.',
  }, await loadTwlistFile(join(CORPORA, 'impkimmo', 'kimmo.twlist.gz'), 'impkimmo'));

  // KIMMO2026 family, recomputed against modern PC-KIMMO + ENGLEX.
  // Built by tools/run-impkimmo2026.js (20-way parallel recognize)
  // from fixture-src/wlist/master.wlist.gz; outputs land in
  // fixture-src/twlist/impkimmo2026/. Five sibling axes the user can
  // independently opt into via BYOS.
  for (const v of [
    { key: 'impkimmo2026',           src: 'impkimmo2026.twlist.gz',
      attr: 'Re-derived against SIL PC-KIMMO 2.1.14 + ENGLEX 2.0b5 (downloaded out-of-repo at sibling pckimmo2026/). Field set matches OG impkimmo: pos + 3sg + person + number + proper + tense + vform + finite + aform + verbal + case + reflex + wh + reg + modal + neg + clitic + cform=+GEN.' },
    { key: 'impkimmo2026-cform',     src: 'impkimmo2026-cform.twlist.gz',
      attr: 'Re-derived against SIL PC-KIMMO 2.1.14 + ENGLEX 2.0b5. Captures the full 7-way pckimmo cform enum (+GEN, +have, +be, +will, +would, +will+have, +would+have); the baseline twlist only flags +GEN.' },
    { key: 'impkimmo2026-root',      src: 'impkimmo2026-root.twlist.gz',
      attr: 'Re-derived against SIL PC-KIMMO 2.1.14 + ENGLEX 2.0b5. Type column is the morphological root token (ENGLEX backtick stress-marker stripped, lowercased). One type per root (~17K distinct).' },
    { key: 'impkimmo2026-rootpos',   src: 'impkimmo2026-rootpos.twlist.gz',
      attr: 'Re-derived against SIL PC-KIMMO 2.1.14 + ENGLEX 2.0b5. Type column is the POS of the morphological root (11 distinct values: aj, aux, av, cj, dt, ij, inf, n, pp, pr, v).' },
    { key: 'impkimmo2026-drvstem',   src: 'impkimmo2026-drvstem.twlist.gz',
      attr: 'Re-derived against SIL PC-KIMMO 2.1.14 + ENGLEX 2.0b5. Type column is drvstem_plus or drvstem_minus, whether the surface form was built by attaching a derivational suffix to a root.' },
  ]) {
    const path = join(CORPORA, 'impkimmo2026', v.src);
    if (!existsSync(path)) {
      process.stderr.write(`(skip: ${v.src} not found, run tools/run-impkimmo2026.js first)\n`);
      continue;
    }
    total += writeFixture(`${v.key}.twlist.tsv`, {
      key: v.key, attribution: v.attr,
    }, await loadTwlistFile(path, v.key));
  }

  total += writeFixture('mit.twlist.tsv', {
    key: 'mit',
    attribution: "Bob Baldwin's collection from MIT, augmented by Matt Bishop and Daniel Klein. Bare flattened form (no possessive augmentor): kimmo + rhyme already provide proper-name possessives, and grammars/mit-names.def doesn't reference the _pos types.",
  }, expandMitlist(await readNamed(join(CORPORA, 'mitlist'),
    ['name_family', 'name_female', 'name_male', 'name_other', 'place'])));

  // Numeric twlists. Generated source files live under
  // fixture-src/twlist/numeric/ (regenerate with `node fixture-src/twlist/numeric/fetch.js`).
  // Three fixtures emit here, each pulling a different subset of the
  // shared per-type source files:
  //
  //   - num-form-preserved: cardinals (separate digit-form / word-form
  //     types), cardinal numeration, ordinals (separate digit / word),
  //     ordinal numeration, years, percent. Cover preserves whatever
  //     digit/word form the corpus had at each slot. Default mode.
  //   - num-form-interchangeable: cardinals + ordinals as
  //     unified-form types (one type per magnitude holds both digit
  //     and word entries), plus the same numerations / years / percent.
  //     Encoder may emit either form regardless of corpus form. Demo /
  //     stylistic alternative. Mutually exclusive with num-form-preserved.
  //   - num-roman: classical lowercase Roman numerals 1..3999. Opt-in
  //     only: lowercase 'i'/'v'/'x'/'l'/'c'/'d'/'m' collide with
  //     English single letters via sortDict's merge.
  const NUMERIC = 'numeric';
  const CARDINAL_BUCKETS = ['0', '1_9', '10_12', '13_19', '20_99', '100_999'];
  const ROMAN_BUCKETS    = ['1_9', '10_12', '13_19', '20_99', '100_999', '1000_3999'];
  const CARDINAL_NUMERATION = ['hundred', 'thousand', 'million', 'billion', 'trillion']
    .map(m => `num_cardinal_numeration_words_${m}`);
  const ORDINAL_NUMERATION  = ['hundredth', 'thousandth', 'millionth', 'billionth', 'trillionth']
    .map(m => `num_ordinal_numeration_words_${m}`);
  const YEAR_TYPES   = ['num_years_4_digit', 'num_years_bc', 'num_years_bce',
                        'num_years_ad', 'num_years_ce'];
  const PERCENT_TYPES = CARDINAL_BUCKETS.map(b => `num_percent_${b}`);

  const formPreservedTypes = [
    ...CARDINAL_BUCKETS.map(b => `num_cardinal_digits_${b}`),
    ...CARDINAL_BUCKETS.map(b => `num_cardinal_words_${b}`),
    ...CARDINAL_NUMERATION,
    ...CARDINAL_BUCKETS.map(b => `num_ordinal_digits_${b}`),
    ...CARDINAL_BUCKETS.map(b => `num_ordinal_words_${b}`),
    ...ORDINAL_NUMERATION,
    ...YEAR_TYPES,
    ...PERCENT_TYPES,
  ];
  const formInterchangeableTypes = [
    ...CARDINAL_BUCKETS.map(b => `num_cardinal_digits_words_${b}`),
    ...CARDINAL_NUMERATION,
    ...CARDINAL_BUCKETS.map(b => `num_ordinal_digits_words_${b}`),
    ...ORDINAL_NUMERATION,
    ...YEAR_TYPES,
    ...PERCENT_TYPES,
  ];
  const romanTypes = ROMAN_BUCKETS.map(b => `num_roman_digits_${b}`);

  total += writeFixture('num-form-preserved.twlist.tsv', {
    key: 'num-form-preserved',
    attribution: 'Cardinals (digit + word form as separate types), ordinals, numeration words, years (bare 4-digit + BC/BCE/AD/CE phrases), percent. Cover preserves whatever digit-vs-word form the corpus had at each slot.',
  }, expandNumeric(await readNamed(join(CORPORA, NUMERIC), formPreservedTypes)));

  total += writeFixture('num-form-interchangeable.twlist.tsv', {
    key: 'num-form-interchangeable',
    attribution: 'Cardinals and ordinals with digit and word forms unified into single types per magnitude bucket, plus numeration words, years, percent. Encoder may emit either form at any slot regardless of corpus form. Mutually exclusive with num-form-preserved.',
  }, expandNumeric(await readNamed(join(CORPORA, NUMERIC), formInterchangeableTypes)));

  total += writeFixture('num-roman.twlist.tsv', {
    key: 'num-roman',
    attribution: "Classical lowercase Roman numerals 1..3999 (subtractive notation: xl for 40, cm for 900, etc.). Opt-in only, lowercase 'i'/'v'/'x'/'l'/'c'/'d'/'m' collide with English single letters; sortDict picks one home per word, so including Roman alongside English sources classifies pronoun 'I' as Roman across the dict.",
  }, expandNumeric(await readNamed(join(CORPORA, NUMERIC), romanTypes)));

  total += writeFixture('rhyme.twlist.tsv', {
    key: 'rhyme',
    attribution: 'Rhyme classes derived from the CMU Pronouncing Dictionary, OG NiceText 1.0 source corpora.',
  }, await loadTwlistFile(join(CORPORA, 'rhyme', 'rhyme.twlist.gz'), 'rhyme'));

  total += writeFixture('cmu-syllable.twlist.tsv', {
    key: 'cmu-syllable',
    attribution: 'Syllable-count buckets derived from the CMU Pronouncing Dictionary by counting vowel phonemes per pronunciation. One type per syllable count (syl_1, syl_2, ...). Words with multiple pronunciations of differing syllable counts contribute to each applicable bucket. Build: `node fixture-src/twlist/cmu-syllable/derive.js`.',
  }, await loadTwlistFile(join(CORPORA, 'cmu-syllable', 'syllable.twlist.gz'), 'cmu-syllable'));

  total += writeFixture('cmu-stress.twlist.tsv', {
    key: 'cmu-stress',
    attribution: 'Stress patterns derived from the CMU Pronouncing Dictionary by concatenating ARPABET stress digits (0=unstressed, 1=primary, 2=secondary) across each vowel in a pronunciation. One type per distinct sequence (stress_01 = iamb, stress_10 = trochee, stress_001 = anapest, stress_100 = dactyl). Build: `node fixture-src/twlist/cmu-stress/derive.js`.',
  }, await loadTwlistFile(join(CORPORA, 'cmu-stress', 'stress.twlist.gz'), 'cmu-stress'));

  total += writeFixture('cmu-alliteration.twlist.tsv', {
    key: 'cmu-alliteration',
    attribution: 'Alliteration groups derived from the CMU Pronouncing Dictionary by taking each word\'s first ARPABET phoneme (stress digit stripped). One type per phoneme (allit_K, allit_S, allit_TH, ...). Build: `node fixture-src/twlist/cmu-alliteration/derive.js`.',
  }, await loadTwlistFile(join(CORPORA, 'cmu-alliteration', 'alliteration.twlist.gz'), 'cmu-alliteration'));

  total += writeFixture('claude2026.twlist.tsv', {
    key: 'claude2026',
    attribution: 'Claude-authored 2026 vocabulary supplement (actions, collectives, emotions, modifiers, nature, new-words, objects, people, semantic-domain, sensory, time-space).',
  }, await loadTwlistDir(join(CORPORA, 'claude2026'), 'claude2026'));

  total += writeFixture('connectors.twlist.tsv', {
    key: 'connectors',
    attribution: 'Per-grammar connector word singletons (_UNIQUE_word entries) used by CFG drop-rule semantics.',
  }, await loadTwlistDir(join(CORPORA, 'cfg-words'), 'cfg-words'));

  total += writeFixture('proglang-keywords.twlist.tsv', {
    key: 'proglang-keywords',
    attribution: 'Keywords, constants, and built-in identifiers across programming languages (C, C++, COBOL, CSS, Fortran, HTML, Java, JS, Perl, PHP, Python, SQL), shells (sh, bash, csh), and command sets (Linux, BSD, DOS, PowerShell, Windows). Type prefix `<lang>_<keyword>` per row; each language fully standalone (cross-language duplicates merge via sortDict at session-build time). Underscore-bearing identifiers (e.g., `is_array`, `__init__`, `size_t`) are authored in source for future-lexer-loosen forward compatibility but are silently rejected by today\'s rule-2 lexer gate; the builder synthesizes `<lang>_split_<word>` fragment rows so the constituent WORDs still contribute vocabulary. Not enabled in any card fixture by default; opt-in per BYOS for code-corpus sessions.',
  }, await loadProglangKeywordsDir(join(CORPORA, 'proglang-keywords'), 'proglang-keywords'));

  total += writeFixture('moby-pos.twlist.tsv', {
    key: 'moby-pos',
    attribution: 'Moby Part-of-Speech II by Grady Ward, dedicated to the public domain (1996). Distributed via Project Gutenberg eBook 3203.',
  }, parseMobyPos(await readMaybeGz(join(CORPORA, 'moby-pos', 'mobypos.txt.gz'))));

  total += writeFixture('moby-thesaurus.twlist.tsv', {
    key: 'moby-thesaurus',
    attribution: 'Moby Thesaurus II by Grady Ward, dedicated to the public domain (1996). Distributed via Project Gutenberg eBook 3202.',
  }, parseMobyThesaurus(await readMaybeGz(join(CORPORA, 'moby-thesaurus', 'mthesaur.txt.gz'))));

  {
    const wn = [];
    for (const pos of ['noun', 'verb', 'adj', 'adv']) {
      const path = join(CORPORA, 'wordnet', `index.${pos}.gz`);
      if (!existsSync(path)) { process.stderr.write(`(skip: wordnet/index.${pos}.gz not found)\n`); continue; }
      wn.push(...parseWordnetIndex(await readMaybeGz(path)));
    }
    total += writeFixture('wordnet.twlist.tsv', {
      key: 'wordnet',
      attribution: WORDNET_LICENSE,
    }, wn);
  }

  {
    let wnSyn = [];
    for (const pos of ['noun', 'verb', 'adj', 'adv']) {
      const path = join(CORPORA, 'wordnet', `data.${pos}.gz`);
      if (!existsSync(path)) { process.stderr.write(`(skip: wordnet/data.${pos}.gz not found)\n`); continue; }
      wnSyn = wnSyn.concat(parseWordnetSynsets(await readMaybeGz(path)));
    }
    total += writeFixture('wordnet-synonyms.twlist.tsv', {
      key: 'wordnet-synonyms',
      attribution: WORDNET_LICENSE,
    }, wnSyn);
  }

  // Emoji16: single-emoji TW-list (Unicode 16.0 emoji-test.txt) plus
  // the CLDR keyword sidecar consumed by Aug A / Aug B / Aug-mix at
  // runtime, plus a CLDR-derived word-phrase fixture typed under
  // emoji subgroup labels for cross-modal mixing.
  {
    const emojiTextPath = join(CORPORA, 'emoji16', 'emoji-test.txt.gz');
    const baseXmlPath   = join(CORPORA, 'emoji16', 'annotations-en.xml.gz');
    const drvXmlPath    = join(CORPORA, 'emoji16', 'annotations-derived-en.xml.gz');
    if (!existsSync(emojiTextPath) || !existsSync(baseXmlPath) || !existsSync(drvXmlPath)) {
      process.stderr.write('(skip: emoji16 inputs not found; run fixture-src/twlist/emoji16/fetch.js)\n');
    } else {
      const emojiEntries = parseEmojiTest(await readMaybeGz(emojiTextPath));
      const basePack = parseCldrAnnotations(await readMaybeGz(baseXmlPath));
      const drvPack  = parseCldrAnnotations(await readMaybeGz(drvXmlPath));
      const cldrMap = buildEmojiCldrMap(emojiEntries, basePack, drvPack);

      total += writeFixture('emoji16.twlist.tsv', {
        key: 'emoji16',
        attribution: 'Unicode® Emoji 16.0 (https://unicode.org/Public/emoji/16.0/emoji-test.txt). Subgroup headers carried verbatim, snake-cased, as em16_<subgroup> types. Each fully-qualified entry (incl. skin-tone and gender variants) is a separate bit-bearing row. © Unicode, Inc.; redistribution per the Unicode Terms of Use.',
      }, emojiEntries);

      const phraseEntries = buildEmojiPhraseEntries(emojiEntries, basePack, drvPack);
      total += writeFixture('emoji-cldr-names-16.twlist.tsv', {
        key: 'emoji-cldr-names-16',
        attribution: 'CLDR 48 English emoji annotations (https://github.com/unicode-org/cldr/tree/release-48/common/annotations). Multi-word emoji names (the CLDR tts field, e.g. "alarm clock", "United States" with the "flag: " prefix stripped from country flags), typed under each emoji\'s home Unicode subgroup so cross-modal slots compose at runtime. Licensed under Unicode-3.0; © Unicode, Inc.',
      }, phraseEntries);

      writeJsonFixture('emoji16.emoji-cldr.json', cldrMap);

      // Hand-curated multi-emoji and mixed Latin+emoji phrases under
      // em16_<subgroup> types. Step 6 (§F): structural foundation
      // landed in §D (phrases as values) and §C (emoji as WORD); this
      // is content-only.
      const phrasesPath = join(CORPORA, 'emoji-curated-phrases-16', 'phrases.twlist');
      if (existsSync(phrasesPath)) {
        const handPhrases = parseTwlistLines(await readMaybeGz(phrasesPath));
        total += writeFixture('emoji-curated-phrases-16.twlist.tsv', {
          key: 'emoji-curated-phrases-16',
          attribution: 'Hand-curated multi-emoji and mixed Latin+emoji phrases typed under em16_<subgroup> labels. Built atop Unicode Emoji 16.0 + CLDR 48 data; the phrase content itself is original to this project. License: same as the rest of the NiceText repo.',
        }, handPhrases);
      }

      // Curated CLDR keywords: optional aug-pass filter. The raw .txt
      // lives alongside fetch.js; we transform to a (curated, keyword)
      // TW-list so the worker can load it via the standard
      // parseTwlistLines path. Every value passes the rule-2 lexer
      // round-trip: the curation script already filtered for that.
      const curPath = join(CORPORA, 'emoji16', 'curated-keywords.txt');
      if (existsSync(curPath)) {
        const text = await readMaybeGz(curPath);
        const entries = [];
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          entries.push({ type: 'curated', word: line });
        }
        total += writeFixture('emoji16-curated-keywords.twlist.tsv', {
          key: 'emoji16-curated-keywords',
          attribution: 'AI-curated subset of CLDR 48 emoji keywords; see fixture-src/twlist/emoji16/curated-keywords.txt for the curation method. Source: https://github.com/unicode-org/cldr/tree/release-48/common/annotations. Licensed under Unicode-3.0; © Unicode, Inc.',
        }, entries);
      }
    }
  }

  // Emit the consolidated source-metadata index. The .js form is
  // imported synchronously by js/app.js at boot to render the tabular
  // source selector. The .json sibling carries identical content for
  // tooling that prefers JSON (tests, build scripts).
  {
    const stable = FIXTURE_MANIFEST.slice().sort((a, b) => {
      // Sort: by group (alpha, "Other" + "Experimentation" last),
      // then label (alpha).
      const ag = a.group ?? 'zzz', bg = b.group ?? 'zzz';
      if (ag !== bg) {
        if (ag === 'Other' || ag === 'Experimentation') return 1;
        if (bg === 'Other' || bg === 'Experimentation') return -1;
        return ag < bg ? -1 : 1;
      }
      const al = a.label ?? '', bl = b.label ?? '';
      return al < bl ? -1 : al > bl ? 1 : 0;
    });
    const metaPath = join(OUT, 'twlist-sources.meta.json');
    writeFileSync(metaPath, JSON.stringify({ generated: new Date().toISOString(), sources: stable }, null, 2) + '\n');
    process.stderr.write(`  wrote ${metaPath.replace(ROOT + '/', '')} (${stable.length} sources indexed)\n`);
    const jsPath = join(OUT, 'twlist-sources.meta.js');
    const jsBody =
      '// AUTO-GENERATED. Do not edit by hand.\n' +
      '//\n' +
      '// Source of truth: tools/build-twlist-fixtures.js SOURCE_METADATA.\n' +
      '// Regenerate with: node tools/build-twlist-fixtures.js (or\n' +
      '// node tools/build-all-fixtures.js for the full pipeline).\n' +
      '//\n' +
      '// Same content as fixtures/twlist-sources.meta.json, exported as an\n' +
      '// ES module so js/app.js can import it synchronously alongside\n' +
      '// fixtures/cards.data.js. The .json sibling stays for tooling.\n' +
      'export default ' + JSON.stringify(stable, null, 2) + ';\n';
    writeFileSync(jsPath, jsBody);
    process.stderr.write(`  wrote ${jsPath.replace(ROOT + '/', '')}\n`);
  }

  process.stderr.write(`\ntotal: ${total} entries across all twlist fixtures (pre vowel-aug).\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    // The shared loader's worker_threads pool holds the event loop
    // open after work completes; exit explicitly.
    () => process.exit(0),
    (err) => {
      process.stderr.write(`${err.stack || err.message || err}\n`);
      process.exit(1);
    },
  );
}
