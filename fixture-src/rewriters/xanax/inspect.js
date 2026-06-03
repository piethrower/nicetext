#!/usr/bin/env node
// fixture-src/rewriters/xanax/inspect.js -- a/an agreement inspector
// (orthographic, next-letter-class).
//
// Reads a text from stdin, scans for the standalone words "a" and "an"
// (case-insensitive), looks at the next word, and reports a breakdown
// by next-letter class. Used three ways (see whats-new.html §6):
//
//   1. Fixture curation -- measure each corpus's natural a/an error
//      rate to decide whether to ship that card with the
//      `agreement: "a-an"` byos flag on.
//   2. Eve baseline calibration -- same measurement against the source
//      corpus to learn the natural rate for that style.
//   3. Eve detection -- measure a suspected NiceText cover; an error
//      rate substantially below the source corpus's baseline is a
//      soft tell.
//
// Definitions (the post-process rule in whats-new §6's lookahead
// proposal):
//   - "ungrammatical a"  = the word `a`  followed by a word starting
//                          with [aeiouh] (case-insensitive).
//   - "ungrammatical an" = the word `an` followed by a word starting
//                          with NOT [aeiouh].
//
// Reporting: the next-word's leading letter is grouped into classes:
//   - vowel-strict ([aeiou])
//   - h            (the "an honest" / "a hot" branch -- naturally
//                   variable; reported as its own class because real
//                   corpora disagree on it)
//   - consonant-non-h
//   - non-letter   (digit, emoji, punctuation, etc. -- these don't
//                   carry agreement signal; counted separately and
//                   excluded from the error rate)
//
// Output: a single JSON object to stdout. The shape is meant to be
// machine-readable (jq-friendly) and stable.
//
// Usage:
//   cat aesop.txt | node fixture-src/rewriters/xanax/inspect.js
//   node fixture-src/rewriters/xanax/inspect.js < cover.txt | jq .errorRate
//
// Phonological (CMU-based) classification lives in derive-exceptions.js
// and corpus-sweep.js; the scan/classify primitives are shared via
// lib.js. Zero deps; Node built-ins only.

import { stdin } from 'node:process';
import { scanArticles, classifyByLetter, makeSnippet } from './lib.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function inspect(text) {
  const stats = {
    a:  { vowel: 0, h: 0, consonant: 0, nonletter: 0 },
    an: { vowel: 0, h: 0, consonant: 0, nonletter: 0 },
  };
  const examples = {
    aBeforeVowel: [],          // ungrammatical "a apple"
    aBeforeH: [],              // gray zone "a hot" / "a honest"
    anBeforeConsonant: [],     // ungrammatical "an cat"
    anBeforeH: [],             // gray zone "an honest" / "an hot"
  };
  const EXAMPLE_LIMIT = 10;

  for (const hit of scanArticles(text)) {
    const cls = classifyByLetter(hit.nextWord);
    stats[hit.article][cls]++;
    const snippet = makeSnippet(text, hit.startIdx, hit.endIdx);
    if (hit.article === 'a' && cls === 'vowel'
        && examples.aBeforeVowel.length < EXAMPLE_LIMIT) {
      examples.aBeforeVowel.push(snippet);
    } else if (hit.article === 'a' && cls === 'h'
        && examples.aBeforeH.length < EXAMPLE_LIMIT) {
      examples.aBeforeH.push(snippet);
    } else if (hit.article === 'an' && cls === 'consonant'
        && examples.anBeforeConsonant.length < EXAMPLE_LIMIT) {
      examples.anBeforeConsonant.push(snippet);
    } else if (hit.article === 'an' && cls === 'h'
        && examples.anBeforeH.length < EXAMPLE_LIMIT) {
      examples.anBeforeH.push(snippet);
    }
  }

  // Derived: error rate excludes the 'nonletter' bucket (no agreement
  // signal) and the 'h' bucket (corpora disagree). Tools that want a
  // stricter rate can include 'h' from the raw counts.
  const totalArticles = stats.a.vowel + stats.a.consonant
                      + stats.an.vowel + stats.an.consonant;
  const errors = stats.a.vowel + stats.an.consonant;
  const errorRate = totalArticles === 0 ? 0 : errors / totalArticles;

  return {
    totalArticles,
    errors,
    errorRate,
    breakdown: {
      a:  { ...stats.a,  total: stats.a.vowel + stats.a.h + stats.a.consonant + stats.a.nonletter },
      an: { ...stats.an, total: stats.an.vowel + stats.an.h + stats.an.consonant + stats.an.nonletter },
    },
    examples,
    notes: {
      hPolicy: "h is reported in its own bucket; not counted toward errors because corpora disagree (an honest vs. a historic).",
      nonletterPolicy: "Articles followed by non-letters (punctuation, digits, emoji, EOS) carry no agreement signal and are excluded from the rate.",
    },
  };
}

const text = await readStdin();
const result = inspect(text);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
