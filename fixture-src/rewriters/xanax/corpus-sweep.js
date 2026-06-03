#!/usr/bin/env node
// fixture-src/rewriters/xanax/corpus-sweep.js -- Phase-2 corpus
// comparison.
//
// For every shipped corpus (and optionally a random sample of local
// Project Gutenberg books), walk all standalone "a"/"an" tokens and
// score what each of three rules would predict against what the
// author actually wrote:
//
//   1. strict_ortho   : 'an' if next word starts with [aeiou], else 'a'
//   2. liberal_ortho  : 'an' if next word starts with [aeiouh], else 'a'
//   3. cmu_phonology  : 'an' if next word's first CMU phoneme is a vowel,
//                       else 'a'. Falls back to strict_ortho when the
//                       next word isn't in the CMU dict.
//
// Headline interpretation:
//   - "Disagreement with author" rate = naturalness cost. Lower is
//     better; cmu_phonology should win.
//   - When cmu_phonology and strict_ortho disagree on which article
//     to emit, the fraction of cases where the author chose CMU's
//     prediction is the empirical justification for the swap.
//
// Inputs (relative to repo root):
//   fixtures/*.txt.gz             shipped corpora
//   fixture-src/pron/cmu/cmudict.dict.gz   pronouncing dictionary
//   fixture-src/freq/gutenberg/raw/**/*.txt   optional random sample
//
// Output:
//   tmp/xanax-corpus-sweep-report.json   structured per-corpus + totals
//   tmp/xanax-corpus-sweep-disagreements.tsv  per-decision rows where
//     cmu_phonology and strict_ortho disagree (the value-add cases)
//
// Args:
//   --gutenberg-sample=N   include N random Gutenberg books (default 0)
//   --gutenberg-seed=S     PRNG seed for reproducible sampling
//   --max-snippets=N       cap per-rule example snippets (default 5)
//
// Zero deps; Node built-ins only.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { argv } from 'node:process';
import { scanArticles, classifyByLetter, classifyByPhoneme,
         loadCmuMap, makeSnippet } from './lib.js';

const HERE      = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURES  = join(REPO_ROOT, 'fixtures');
const CMU_PATH  = join(REPO_ROOT, 'fixture-src', 'pron', 'cmu', 'cmudict.dict.gz');
const GUT_RAW   = join(REPO_ROOT, 'fixture-src', 'freq', 'gutenberg', 'raw');
const TMP       = join(REPO_ROOT, 'tmp');

// ---- arg parsing --------------------------------------------------

const args = Object.fromEntries(
  argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const GUT_N    = Number(args['gutenberg-sample'] || 0);
const GUT_SEED = Number(args['gutenberg-seed'] || 1);
const MAX_SNIPPETS = Number(args['max-snippets'] || 5);

// ---- helpers ------------------------------------------------------

// Tiny seedable PRNG for reproducible Gutenberg sampling.
// Mulberry32 (Park / Tomic). Returns float in [0,1).
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Patterns mirror js/src/lexer.js (GUTENBERG_START_MODERN_RE /
// GUTENBERG_END_MODERN_RE). Inlined so this tool doesn't need to
// import the browser-side lexer for two constants.
const PG_START_RE = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*$/m;
const PG_END_RE   = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*$/m;

function stripPgBoilerplate(text) {
  let s = 0, e = text.length;
  const ms = text.match(PG_START_RE);
  if (ms) s = ms.index + ms[0].length;
  const me = text.slice(s).match(PG_END_RE);
  if (me) e = s + me.index;
  return text.slice(s, e);
}

function loadCorpusFixture(path) {
  return gunzipSync(readFileSync(path)).toString('utf8');
}

function listFixtureCorpora() {
  return readdirSync(FIXTURES)
    .filter(f => f.endsWith('.txt.gz'))
    .map(f => ({
      kind: 'fixture',
      name: f.replace(/\.txt\.gz$/, ''),
      path: join(FIXTURES, f),
      load: () => loadCorpusFixture(join(FIXTURES, f)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listGutenbergSample(n, seed) {
  if (n <= 0) return [];
  const all = [];
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(dir, ent.name));
      else if (ent.isFile() && ent.name.endsWith('.txt') && ent.name !== 'robots.txt') {
        all.push(join(dir, ent.name));
      }
    }
  }
  walk(GUT_RAW);
  // Reproducible shuffle: Fisher-Yates with seeded PRNG, take first n.
  const rng = mulberry32(seed);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n).map(p => ({
    kind: 'gutenberg',
    name: `gut/${basename(p, '.txt')}`,
    path: p,
    load: () => stripPgBoilerplate(readFileSync(p, 'utf8')),
  }));
}

// ---- per-corpus measurement --------------------------------------

function measureCorpus(corpus, cmu) {
  const text = corpus.load();
  const stats = {
    name: corpus.name,
    kind: corpus.kind,
    bytes: text.length,
    totalArticles: 0,
    skipped: { initial: 0, intervenedGap: 0 },
    // Per-letter-class distribution of next-word.
    byLetterClass: { vowel: 0, h: 0, consonant: 0, nonletter: 0 },
    // CMU coverage of the next word.
    cmuCoverage:   { inCmu: 0, notInCmu: 0, nonletter: 0 },
    // Author chose: a / an.
    authorChose:   { a: 0, an: 0 },
    // Joint (author × phoneme-class).
    joint: {
      'a_vowel-onset':       0, 'a_consonant-onset':       0, 'a_missing':       0, 'a_nonletter':       0,
      'an_vowel-onset':      0, 'an_consonant-onset':      0, 'an_missing':      0, 'an_nonletter':      0,
    },
    // Disagreement counts vs author for each rule.
    rules: {
      strict_ortho:  { evaluated: 0, agreeAuthor: 0, disagreeAuthor: 0 },
      liberal_ortho: { evaluated: 0, agreeAuthor: 0, disagreeAuthor: 0 },
      cmu_phonology: { evaluated: 0, agreeAuthor: 0, disagreeAuthor: 0 },
    },
    // The headline value-add: where cmu_phonology and strict_ortho
    // disagree on what to emit, did the author pick CMU's choice or
    // strict's choice? CMU wins the bet whenever author == CMU.
    cmuVsStrictDisagreement: {
      total: 0,
      authorChoseCmu: 0,
      authorChoseStrict: 0,
    },
    // Example snippets for human-eyeballing.
    snippets: {
      cmuAgreedAuthorVsStrictDisagreed: [],   // CMU got it right, strict wrong
      strictAgreedAuthorVsCmuDisagreed: [],   // strict got it right, CMU wrong
      missingFromCmu_authorAnomalous: [],     // missing word; author article unusual vs strict
    },
    // Phase 3 -- per-word data on what CMU is missing.
    // Map<lowercased-word, { count, capitalizedCount, authorA, authorAn, fallbackAgreesAuthor }>
    missingFromCmu: new Map(),
  };

  function pred(rule, letterClass, phonemeClass) {
    if (rule === 'strict_ortho')  return letterClass === 'vowel' ? 'an' : 'a';
    if (rule === 'liberal_ortho') return (letterClass === 'vowel' || letterClass === 'h') ? 'an' : 'a';
    if (rule === 'cmu_phonology') {
      if (phonemeClass === 'vowel-onset')      return 'an';
      if (phonemeClass === 'consonant-onset')  return 'a';
      // Missing from CMU: fall back to strict.
      return letterClass === 'vowel' ? 'an' : 'a';
    }
    throw new Error('unknown rule ' + rule);
  }

  let skippedInitial = 0;
  let skippedGap = 0;
  for (const hit of scanArticles(text)) {
    // Filter 1: uppercase "A." in source is an initial (A. M. Smith,
    // A. H. Thompson), not an article. CMU correctly knows that M and
    // H as letter names take "an", but here the surface "A" isn't an
    // article at all -- it's an abbreviated first name.
    if (text[hit.startIdx] === 'A' && text[hit.startIdx + hit.article.length] === '.') {
      skippedInitial++;
      continue;
    }
    // Filter 2: the article and the next letter-word are separated by
    // something other than whitespace (digit, punctuation, ...). The
    // author was articulating against the intervening token, not the
    // letter-word we found. Example: "a 30 H.P. motor" -- the spoken
    // form is "a thirty H P motor"; we'd otherwise mis-classify on
    // "H" being a vowel-onset letter name.
    const nextWordStart = hit.endIdx - hit.nextWord.length;
    const gap = text.slice(hit.startIdx + hit.article.length, nextWordStart);
    if (gap && /\S/.test(gap)) {
      skippedGap++;
      continue;
    }
    const author = hit.article;
    const nextW = hit.nextWord.toLowerCase();
    const letterClass = classifyByLetter(hit.nextWord);
    stats.totalArticles++;
    stats.byLetterClass[letterClass]++;
    stats.authorChose[author]++;

    let phonemeClass; // 'vowel-onset' | 'consonant-onset' | 'missing' | 'nonletter'
    if (letterClass === 'nonletter') {
      phonemeClass = 'nonletter';
      stats.cmuCoverage.nonletter++;
    } else {
      const firstPh = nextW ? cmu.get(nextW) : null;
      if (firstPh) {
        phonemeClass = classifyByPhoneme(firstPh);
        stats.cmuCoverage.inCmu++;
      } else {
        phonemeClass = 'missing';
        stats.cmuCoverage.notInCmu++;
      }
    }
    stats.joint[`${author}_${phonemeClass}`]++;

    // Skip nonletter for rule-vs-author scoring (no signal).
    if (letterClass === 'nonletter') continue;

    for (const rule of ['strict_ortho','liberal_ortho','cmu_phonology']) {
      const p = pred(rule, letterClass, phonemeClass);
      stats.rules[rule].evaluated++;
      if (p === author) stats.rules[rule].agreeAuthor++;
      else              stats.rules[rule].disagreeAuthor++;
    }

    // Value-add: CMU vs strict_ortho disagreement.
    const predStrict = pred('strict_ortho', letterClass, phonemeClass);
    const predCmu    = pred('cmu_phonology', letterClass, phonemeClass);
    if (predStrict !== predCmu) {
      stats.cmuVsStrictDisagreement.total++;
      if (author === predCmu)    stats.cmuVsStrictDisagreement.authorChoseCmu++;
      if (author === predStrict) stats.cmuVsStrictDisagreement.authorChoseStrict++;

      // Snapshot snippets (capped).
      const snip = makeSnippet(text, hit.startIdx, hit.endIdx);
      if (author === predCmu && stats.snippets.cmuAgreedAuthorVsStrictDisagreed.length < MAX_SNIPPETS) {
        stats.snippets.cmuAgreedAuthorVsStrictDisagreed.push({ nextW, snippet: snip });
      }
      if (author === predStrict && stats.snippets.strictAgreedAuthorVsCmuDisagreed.length < MAX_SNIPPETS) {
        stats.snippets.strictAgreedAuthorVsCmuDisagreed.push({ nextW, snippet: snip });
      }
    }

    if (phonemeClass === 'missing'
        && pred('strict_ortho', letterClass, phonemeClass) !== author
        && stats.snippets.missingFromCmu_authorAnomalous.length < MAX_SNIPPETS) {
      stats.snippets.missingFromCmu_authorAnomalous.push({ nextW, snippet: makeSnippet(text, hit.startIdx, hit.endIdx) });
    }

    // Phase 3 -- record missing-word occurrences with capitalization
    // signal and fallback-prediction accuracy.
    if (phonemeClass === 'missing') {
      const surface = hit.nextWord;
      const wasCapitalized = surface.length > 0 && surface[0] === surface[0].toUpperCase()
                             && surface[0] !== surface[0].toLowerCase();
      const fallbackPred = pred('strict_ortho', letterClass, phonemeClass);
      const e = stats.missingFromCmu.get(nextW) || {
        count: 0, capitalizedCount: 0, authorA: 0, authorAn: 0, fallbackAgreesAuthor: 0,
      };
      e.count++;
      if (wasCapitalized) e.capitalizedCount++;
      if (author === 'a')  e.authorA++;
      else                 e.authorAn++;
      if (fallbackPred === author) e.fallbackAgreesAuthor++;
      stats.missingFromCmu.set(nextW, e);
    }
  }

  stats.skipped.initial = skippedInitial;
  stats.skipped.intervenedGap = skippedGap;
  // Convert raw counts into rates for the report.
  const report = { ...stats };
  for (const rule of ['strict_ortho','liberal_ortho','cmu_phonology']) {
    const r = stats.rules[rule];
    report.rules[rule] = {
      evaluated: r.evaluated,
      agreeAuthor: r.agreeAuthor,
      disagreeAuthor: r.disagreeAuthor,
      agreeRate: r.evaluated ? r.agreeAuthor / r.evaluated : 0,
      disagreeRate: r.evaluated ? r.disagreeAuthor / r.evaluated : 0,
    };
  }
  const d = stats.cmuVsStrictDisagreement;
  report.cmuVsStrictDisagreement = {
    ...d,
    cmuWinShare:    d.total ? d.authorChoseCmu    / d.total : 0,
    strictWinShare: d.total ? d.authorChoseStrict / d.total : 0,
  };
  return report;
}

// ---- main ---------------------------------------------------------

mkdirSync(TMP, { recursive: true });

process.stderr.write('Loading CMU dict...\n');
const cmu = loadCmuMap(CMU_PATH);
process.stderr.write(`CMU: ${cmu.size} words.\n`);

const corpora = [
  ...listFixtureCorpora(),
  ...listGutenbergSample(GUT_N, GUT_SEED),
];
process.stderr.write(`Measuring ${corpora.length} corpora (${corpora.filter(c=>c.kind==='gutenberg').length} from Gutenberg sample, seed=${GUT_SEED}).\n`);

const perCorpus = [];
for (const c of corpora) {
  process.stderr.write(`  ${c.name}...\n`);
  perCorpus.push(measureCorpus(c, cmu));
}

// Aggregate totals across all corpora.
function aggregate(rows) {
  const sum = (k1, k2) => rows.reduce((s, r) => s + (k2 ? r[k1][k2] : r[k1]), 0);
  const ruleAgg = (rule) => {
    const ev   = rows.reduce((s,r) => s + r.rules[rule].evaluated, 0);
    const agr  = rows.reduce((s,r) => s + r.rules[rule].agreeAuthor, 0);
    return {
      evaluated: ev, agreeAuthor: agr,
      disagreeAuthor: ev - agr,
      agreeRate: ev ? agr/ev : 0,
      disagreeRate: ev ? (ev-agr)/ev : 0,
    };
  };
  const dTotal = rows.reduce((s,r) => s + r.cmuVsStrictDisagreement.total, 0);
  const dCmu   = rows.reduce((s,r) => s + r.cmuVsStrictDisagreement.authorChoseCmu, 0);
  const dStr   = rows.reduce((s,r) => s + r.cmuVsStrictDisagreement.authorChoseStrict, 0);
  return {
    totalArticles: sum('totalArticles'),
    cmuCoverage:   { inCmu: sum('cmuCoverage','inCmu'), notInCmu: sum('cmuCoverage','notInCmu'), nonletter: sum('cmuCoverage','nonletter') },
    authorChose:   { a: sum('authorChose','a'), an: sum('authorChose','an') },
    rules: {
      strict_ortho:  ruleAgg('strict_ortho'),
      liberal_ortho: ruleAgg('liberal_ortho'),
      cmu_phonology: ruleAgg('cmu_phonology'),
    },
    cmuVsStrictDisagreement: {
      total: dTotal, authorChoseCmu: dCmu, authorChoseStrict: dStr,
      cmuWinShare:    dTotal ? dCmu/dTotal : 0,
      strictWinShare: dTotal ? dStr/dTotal : 0,
    },
  };
}

const fixtureRows = perCorpus.filter(r => r.kind === 'fixture');
const gutRows     = perCorpus.filter(r => r.kind === 'gutenberg');
const totals = {
  allCorpora: aggregate(perCorpus),
  fixturesOnly: aggregate(fixtureRows),
  gutenbergOnly: gutRows.length ? aggregate(gutRows) : null,
};

// ---- Phase 3: coverage gap --------------------------------------

// Roll per-corpus missingFromCmu maps into one global map.
const globalMissing = new Map();
for (const c of perCorpus) {
  for (const [word, e] of c.missingFromCmu) {
    const g = globalMissing.get(word) || {
      count: 0, capitalizedCount: 0, authorA: 0, authorAn: 0, fallbackAgreesAuthor: 0,
    };
    g.count                += e.count;
    g.capitalizedCount     += e.capitalizedCount;
    g.authorA              += e.authorA;
    g.authorAn             += e.authorAn;
    g.fallbackAgreesAuthor += e.fallbackAgreesAuthor;
    globalMissing.set(word, g);
  }
}

// Category for a missing word. Order matters: first matching category wins.
function missingCategory(word, capRatio) {
  if (/[^\x00-\x7F]/.test(word))    return 'non-ascii';     // foreign/accented
  if (/\d/.test(word))              return 'has-digit';     // mixed alphanumeric
  if (word.includes('-'))           return 'hyphen';        // hyphenated compounds
  if (capRatio >= 0.7)              return 'proper-noun';   // mostly-capitalized in source
  return 'plain';                                           // lowercase rare/foreign/neologism
}

const categories = ['proper-noun', 'plain', 'has-digit', 'hyphen', 'non-ascii'];
const coverageGap = {
  totalMissingOccurrences: 0,
  uniqueMissingWords: globalMissing.size,
  byCategory: {},
  topMissingWords: [],
};
for (const cat of categories) {
  coverageGap.byCategory[cat] = {
    uniqueWords: 0, occurrences: 0, fallbackAgreesAuthor: 0,
    fallbackAccuracy: 0,
    sampleWords: [],
  };
}

const missingArr = [];
for (const [word, e] of globalMissing) {
  const capRatio = e.capitalizedCount / e.count;
  const cat = missingCategory(word, capRatio);
  const bucket = coverageGap.byCategory[cat];
  bucket.uniqueWords++;
  bucket.occurrences          += e.count;
  bucket.fallbackAgreesAuthor += e.fallbackAgreesAuthor;
  coverageGap.totalMissingOccurrences += e.count;
  missingArr.push({ word, ...e, capRatio, category: cat });
}
for (const cat of categories) {
  const b = coverageGap.byCategory[cat];
  b.fallbackAccuracy = b.occurrences ? b.fallbackAgreesAuthor / b.occurrences : 0;
}
missingArr.sort((a, b) => b.count - a.count);
coverageGap.topMissingWords = missingArr.slice(0, 50);
for (const cat of categories) {
  const sample = missingArr.filter(x => x.category === cat).slice(0, 10).map(x => x.word);
  coverageGap.byCategory[cat].sampleWords = sample;
}

// What share of total article slots hit a missing word?
const totalLetterSlots = totals.allCorpora.cmuCoverage.inCmu + totals.allCorpora.cmuCoverage.notInCmu;
coverageGap.missingSlotShare = totalLetterSlots ? coverageGap.totalMissingOccurrences / totalLetterSlots : 0;

// Headline: across all missing-word occurrences, what fraction does
// strict-ortho fallback get right? This is the "fallback accuracy"
// the encoder will inherit when CMU lookup misses.
const totalFallbackAgrees = [...globalMissing.values()].reduce((s, e) => s + e.fallbackAgreesAuthor, 0);
coverageGap.fallbackAgreesAuthor = totalFallbackAgrees;
coverageGap.fallbackAccuracy     = coverageGap.totalMissingOccurrences
  ? totalFallbackAgrees / coverageGap.totalMissingOccurrences : 0;

// Strip per-corpus Maps before JSON serialization (Map serializes as
// {} otherwise); keep only the aggregated global summary.
const perCorpusForReport = perCorpus.map(c => {
  const { missingFromCmu, ...rest } = c;
  return { ...rest, missingFromCmuUniqueWords: missingFromCmu.size };
});
const report = {
  inputs: { cmuPath: CMU_PATH, cmuWords: cmu.size, gutenbergSampleN: GUT_N, gutenbergSeed: GUT_SEED, corpora: corpora.length },
  totals,
  coverageGap,
  perCorpus: perCorpusForReport,
};
writeFileSync(join(TMP, 'xanax-corpus-sweep-report.json'), JSON.stringify(report, null, 2));

// TSV of all missing words, ranked by occurrence count.
const missingTsv = ['word\tcount\tcapRatio\tauthorA\tauthorAn\tfallbackAgreesAuthor\tcategory'];
for (const m of missingArr) {
  missingTsv.push([
    m.word, m.count, m.capRatio.toFixed(3), m.authorA, m.authorAn,
    m.fallbackAgreesAuthor, m.category,
  ].join('\t'));
}
writeFileSync(join(TMP, 'xanax-corpus-sweep-missing.tsv'), missingTsv.join('\n') + '\n');

// Plain-text TSV of disagreement cases for eyeballing.
const tsv = ['corpus\tauthor\tnextWord\tletterClass\tcmuFirstPhoneme\tcmuPrediction\tstrictPrediction\tauthorChose\tsnippet'];
for (const c of perCorpus) {
  for (const snip of c.snippets.cmuAgreedAuthorVsStrictDisagreed) {
    tsv.push(`${c.name}\t(cmu-right)\t${snip.nextW}\t.\t.\tcmu\tstrict-wrong\t.\t${snip.snippet}`);
  }
  for (const snip of c.snippets.strictAgreedAuthorVsCmuDisagreed) {
    tsv.push(`${c.name}\t(strict-right)\t${snip.nextW}\t.\t.\tcmu-wrong\tstrict\t.\t${snip.snippet}`);
  }
}
writeFileSync(join(TMP, 'xanax-corpus-sweep-disagreements.tsv'), tsv.join('\n') + '\n');

// Compact stdout summary table.
function pct(x) { return (100 * x).toFixed(2) + '%'; }
function row(name, r) {
  const s = r.rules;
  const d = r.cmuVsStrictDisagreement;
  return `${name.padEnd(28)}  ${String(r.totalArticles).padStart(6)}  ` +
         `strict ${pct(s.strict_ortho.disagreeRate).padStart(7)}  ` +
         `liberal ${pct(s.liberal_ortho.disagreeRate).padStart(7)}  ` +
         `cmu ${pct(s.cmu_phonology.disagreeRate).padStart(7)}  ` +
         `disagreements ${String(d.total).padStart(5)}  ` +
         `cmu-wins ${pct(d.cmuWinShare).padStart(7)}`;
}
const headerCols = [
  'corpus'.padEnd(28),
  'articles'.padStart(6),
  'strict-disagree',
  'liberal-disagree',
  'cmu-disagree',
  'cmu-vs-strict-disagreements',
  'cmu-wins',
].join('  ');
process.stdout.write(headerCols + '\n');
for (const c of perCorpus) process.stdout.write(row(c.name, c) + '\n');
process.stdout.write('-'.repeat(120) + '\n');
process.stdout.write(row('TOTAL (fixtures)',   totals.fixturesOnly) + '\n');
if (totals.gutenbergOnly) process.stdout.write(row('TOTAL (gutenberg)', totals.gutenbergOnly) + '\n');
process.stdout.write(row('TOTAL (all)',         totals.allCorpora) + '\n');

process.stderr.write(`\nWrote ${TMP}/xanax-corpus-sweep-report.json + disagreements.tsv\n`);
