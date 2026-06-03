#!/usr/bin/env node
// fixture-src/rewriters/xanax/derive-exceptions.js -- Phase-1 analysis
// for proper a/an agreement driven by CMU pronunciations.
//
// The strict-orthographic rule classifies the next word by its
// leading LETTER (vowel / h / consonant / non-letter). That over-fits
// English orthography. The true rule is phonological: "an" before a
// vowel PHONEME onset, "a" otherwise.
//
// This tool reads the CMU Pronouncing Dictionary, classifies each
// word's first phoneme as vowel-onset or consonant-onset, and lists
// the WORDS where the orthographic rule disagrees with phonology.
// Those disagreements are the candidate twlist entries.
//
// Two orthographic-rule variants reported:
//   strict   : "an" if word starts with [aeiou], else "a"
//   liberal  : "an" if word starts with [aeiouh], else "a"
//   (inspect.js puts h in its own bucket; that's a no-rule midway
//    between strict and liberal. Reporting both bounds the impact
//    of either policy choice.)
//
// Exception lists per orthography variant:
//   an-exceptions : ortho says "an", phonology says "a"
//                   (e.g. united, european, one, hour-not, ...)
//   a-exceptions  : ortho says "a",  phonology says "an"
//                   (e.g. honest, hour, heir, honor, ...)
//
// Each exception is annotated with its norvig frequency rank and
// bucketed (top-1k / top-10k / top-100k / rest-of-norvig /
// not-in-norvig) so the developer can see how much usage volume the
// exception set represents.
//
// Output:
//   tmp/xanax-derive-exceptions-report.json
//   tmp/xanax-derive-exceptions-strict-an.tsv
//   tmp/xanax-derive-exceptions-strict-a.tsv
//   tmp/xanax-derive-exceptions-liberal-an.tsv
//   tmp/xanax-derive-exceptions-liberal-a.tsv
//
// Also a short summary to stdout.
//
// Zero deps; Node built-ins only.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCmuMap, VOWEL_PHONEMES } from './lib.js';
import { loadSABfromFile } from '../../../js/src/sab.js';
import { unpackFreqFromSAB } from '../../../js/src/builder/freq-pack.js';

const HERE      = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CMU_PATH  = join(REPO_ROOT, 'fixture-src', 'pron', 'cmu', 'cmudict.dict.gz');
const NORVIG    = join(REPO_ROOT, 'fixtures', 'norvig.freq.sab.gz');
const TMP       = join(REPO_ROOT, 'tmp');

async function loadNorvigRanks(path) {
  // The fixture is sorted by UTF-8 bytes (post sab pack freq), so we
  // recompute rank from counts ourselves: sort all entries by count
  // descending, then number them 1..N. Ties get adjacent ranks in
  // unspecified order.
  const sab = await loadSABfromFile(path);
  const { counts } = unpackFreqFromSAB(sab);
  const entries = [];
  for (const [w, c] of counts) entries.push([w.toLowerCase(), c]);
  entries.sort((a, b) => b[1] - a[1]);
  const ranks = new Map();
  for (let i = 0; i < entries.length; i++) {
    ranks.set(entries[i][0], { count: entries[i][1], rank: i + 1 });
  }
  return ranks;
}

function freqTier(rank) {
  if (rank === null) return 'not-in-norvig';
  if (rank <= 1000) return 'top-1k';
  if (rank <= 10000) return 'top-10k';
  if (rank <= 100000) return 'top-100k';
  return 'rest-of-norvig';
}

const TIER_ORDER = ['top-1k', 'top-10k', 'top-100k', 'rest-of-norvig', 'not-in-norvig'];

function classify(map) {
  const stats = {
    total: map.size,
    vowelOnset: 0,
    consonantOnset: 0,
    hStarts: { total: 0, vowelOnset: 0, consonantOnset: 0 },
    uStarts: { total: 0, vowelOnset: 0, consonantOnset: 0 },
  };
  const exceptions = {
    strict:  { anExc: [], aExc: [] },
    liberal: { anExc: [], aExc: [] },
  };
  for (const [word, firstPh] of map) {
    const vowelOnset = VOWEL_PHONEMES.has(firstPh);
    if (vowelOnset) stats.vowelOnset++; else stats.consonantOnset++;

    const leading = word[0];
    if (leading === 'h') {
      stats.hStarts.total++;
      if (vowelOnset) stats.hStarts.vowelOnset++;
      else            stats.hStarts.consonantOnset++;
    }
    if (leading === 'u') {
      stats.uStarts.total++;
      if (vowelOnset) stats.uStarts.vowelOnset++;
      else            stats.uStarts.consonantOnset++;
    }

    const orthoStrictVowel  = 'aeiou'.includes(leading);
    const orthoLiberalVowel = 'aeiouh'.includes(leading);

    // ortho says "an", phonology says "a" -> an-exception
    if (orthoStrictVowel  && !vowelOnset) exceptions.strict.anExc.push({  word, firstPh });
    if (orthoLiberalVowel && !vowelOnset) exceptions.liberal.anExc.push({ word, firstPh });
    // ortho says "a", phonology says "an" -> a-exception
    if (!orthoStrictVowel  && vowelOnset) exceptions.strict.aExc.push({  word, firstPh });
    if (!orthoLiberalVowel && vowelOnset) exceptions.liberal.aExc.push({ word, firstPh });
  }
  return { stats, exceptions };
}

function annotate(items, ranks) {
  return items
    .map(({ word, firstPh }) => {
      const r = ranks.get(word);
      return {
        word,
        firstPh,
        norvigRank:  r ? r.rank  : null,
        norvigCount: r ? r.count : 0,
        tier: freqTier(r ? r.rank : null),
      };
    })
    .sort((a, b) => b.norvigCount - a.norvigCount);
}

function tierBreakdown(items) {
  const out = {};
  for (const t of TIER_ORDER) out[t] = 0;
  for (const it of items) out[it.tier]++;
  return out;
}

function freqWeightedShare(items, totalNorvigCount) {
  // Sum of norvig counts in this exception set, divided by total
  // unigram volume. A rough upper bound on how often the orthographic
  // rule gets it wrong (overstates, because not every occurrence of an
  // exception word is preceded by an article -- Phase 2 measures that).
  const sum = items.reduce((s, it) => s + it.norvigCount, 0);
  return { sum, share: totalNorvigCount > 0 ? sum / totalNorvigCount : 0 };
}

function coverageCurve(items) {
  // Assumes items is already sorted by norvigCount desc. Returns the
  // cumulative share of total exception volume covered by the top N
  // entries, at the named cut points. Answers "how short can a
  // ship-quality twlist be?"
  const total = items.reduce((s, it) => s + it.norvigCount, 0);
  if (total === 0) return { total, byTopN: {} };
  const cuts = [5, 10, 25, 50, 100, 200, items.length];
  const byTopN = {};
  let acc = 0;
  let idx = 0;
  for (const n of cuts) {
    while (idx < Math.min(n, items.length)) { acc += items[idx].norvigCount; idx++; }
    byTopN[`top${n === items.length ? 'All' : n}`] = {
      count: Math.min(n, items.length),
      cumulativeShare: acc / total,
    };
  }
  return { total, byTopN };
}

function writeTsv(path, items) {
  const lines = ['word\tcmuFirstPhoneme\tnorvigRank\tnorvigCount\ttier'];
  for (const it of items) {
    lines.push(`${it.word}\t${it.firstPh}\t${it.norvigRank ?? ''}\t${it.norvigCount}\t${it.tier}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

// ---- main ----------------------------------------------------------

mkdirSync(TMP, { recursive: true });

const cmu = loadCmuMap(CMU_PATH);
const ranks = await loadNorvigRanks(NORVIG);
const totalNorvigCount = [...ranks.values()].reduce((s, r) => s + r.count, 0);

const { stats, exceptions } = classify(cmu);

const strictAn  = annotate(exceptions.strict.anExc,  ranks);
const strictA   = annotate(exceptions.strict.aExc,   ranks);
const liberalAn = annotate(exceptions.liberal.anExc, ranks);
const liberalA  = annotate(exceptions.liberal.aExc,  ranks);

const report = {
  inputs: {
    cmu:    { path: CMU_PATH,  wordsClassified: cmu.size },
    norvig: { path: NORVIG,    wordsRanked: ranks.size, totalCount: totalNorvigCount },
  },
  phonologicalSplit: {
    vowelOnset: stats.vowelOnset,
    consonantOnset: stats.consonantOnset,
  },
  hStarts: {
    note: "Words spelled with leading 'h'. Phonology bucket determines correct article: an-takers (silent h: honest, hour) vs a-takers (pronounced h: happy, historic).",
    total: stats.hStarts.total,
    anTakers_vowelOnset: stats.hStarts.vowelOnset,
    aTakers_consonantOnset: stats.hStarts.consonantOnset,
  },
  uStarts: {
    note: "Words spelled with leading 'u'. Phonology bucket determines correct article: an-takers (true vowel: umbrella, undo) vs a-takers (consonant Y onset: united, university).",
    total: stats.uStarts.total,
    anTakers_vowelOnset: stats.uStarts.vowelOnset,
    aTakers_consonantOnset: stats.uStarts.consonantOnset,
  },
  strictOrthography_aeiou: {
    note: "Rule: 'an' if leading letter in [aeiou], else 'a'.",
    anExceptions: {
      meaning: "Ortho says 'an', phonology says 'a'. Candidate 'an-exceptions' twlist (words pretending to be vowel-led).",
      total: strictAn.length,
      byTier: tierBreakdown(strictAn),
      freqWeighted: freqWeightedShare(strictAn, totalNorvigCount),
      coverageCurve: coverageCurve(strictAn),
      top30: strictAn.slice(0, 30),
    },
    aExceptions: {
      meaning: "Ortho says 'a', phonology says 'an'. Candidate 'a-exceptions' twlist (silent-h, etc.).",
      total: strictA.length,
      byTier: tierBreakdown(strictA),
      freqWeighted: freqWeightedShare(strictA, totalNorvigCount),
      coverageCurve: coverageCurve(strictA),
      top30: strictA.slice(0, 30),
    },
  },
  liberalOrthography_aeiouh: {
    note: "Rule: 'an' if leading letter in [aeiouh], else 'a'. Treats every h-word as an-taking (so h-starts that are actually consonant-onset become an-exceptions).",
    anExceptions: {
      meaning: "Ortho says 'an', phonology says 'a'.",
      total: liberalAn.length,
      byTier: tierBreakdown(liberalAn),
      freqWeighted: freqWeightedShare(liberalAn, totalNorvigCount),
      coverageCurve: coverageCurve(liberalAn),
      top30: liberalAn.slice(0, 30),
    },
    aExceptions: {
      meaning: "Ortho says 'a', phonology says 'an'.",
      total: liberalA.length,
      byTier: tierBreakdown(liberalA),
      freqWeighted: freqWeightedShare(liberalA, totalNorvigCount),
      coverageCurve: coverageCurve(liberalA),
      top30: liberalA.slice(0, 30),
    },
  },
  notes: {
    norvigFixtureCaveat: "norvig.freq.tsv.gz is a curated subset (~99K entries) intersected with the build's base dictionary, so the 'rest-of-norvig' tier (rank >100k) is structurally empty.",
    freqWeightedShareInterpretation: "freqWeightedShare is the fraction of all norvig unigram occurrences that fall on exception words. Upper bound on how often the orthographic rule misclassifies an article in real text (overstates: not every occurrence is preceded by a/an).",
  },
};

writeFileSync(join(TMP, 'xanax-derive-exceptions-report.json'), JSON.stringify(report, null, 2));
writeTsv(join(TMP, 'xanax-derive-exceptions-strict-an.tsv'),  strictAn);
writeTsv(join(TMP, 'xanax-derive-exceptions-strict-a.tsv'),   strictA);
writeTsv(join(TMP, 'xanax-derive-exceptions-liberal-an.tsv'), liberalAn);
writeTsv(join(TMP, 'xanax-derive-exceptions-liberal-a.tsv'),  liberalA);

// Compact stdout summary.
const summary = {
  cmuEntries: cmu.size,
  phonologicalSplit: report.phonologicalSplit,
  hStarts: report.hStarts,
  uStarts: report.uStarts,
  strict:  {
    anExceptions: { total: strictAn.length, byTier: tierBreakdown(strictAn), freqWeightedShare: report.strictOrthography_aeiou.anExceptions.freqWeighted.share },
    aExceptions:  { total: strictA.length,  byTier: tierBreakdown(strictA),  freqWeightedShare: report.strictOrthography_aeiou.aExceptions.freqWeighted.share },
  },
  liberal: {
    anExceptions: { total: liberalAn.length, byTier: tierBreakdown(liberalAn), freqWeightedShare: report.liberalOrthography_aeiouh.anExceptions.freqWeighted.share },
    aExceptions:  { total: liberalA.length,  byTier: tierBreakdown(liberalA),  freqWeightedShare: report.liberalOrthography_aeiouh.aExceptions.freqWeighted.share },
  },
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.stderr.write(`\nWrote ${TMP}/xanax-derive-exceptions-report.json + 4 TSVs.\n`);
