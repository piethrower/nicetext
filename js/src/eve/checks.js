// Eve Phase I detectors. One factory per BYOS knob.
//
// Each factory returns a detector object with the shape:
//   { knob, consume(token), verdict() }
// where verdict() returns { verdict, confidence, why, done }.
// `verdict` is one of 'likely' | 'unlikely' | 'unknown'.
// `done` true means the detector has enough evidence to stop receiving
// input; the core loop will skip it from then on.
//
// Browser-safe ESM, zero deps. Phase I never touches the decoder.

import { TOKEN } from '../lexer.js';
import { createVerdictState, applyRule } from './verdict-state.js';

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

function isEmojiWord(tok) {
  return tok.type === TOKEN.WORD && EMOJI_RE.test(tok.value);
}

// augment.wordsIntoEmoji
//
// Verdict-state shape (Step 2 of meta-rule refactor). Two rules:
//   `emoji-glyph-present`        positive, runtime: any emoji WORD
//                                seen -> promote to `likely` and
//                                mark the detector done.
//   `no-emoji-after-full-scan`   negative, finalize: stream
//                                exhausted with no emoji seen ->
//                                promote to `unlikely`. Until
//                                finalize fires, verdict stays
//                                `unknown` (cancel mid-stream
//                                surfaces honestly, not as a forced
//                                `unlikely`).
export function createWordsIntoEmojiCheck() {
  const state = createVerdictState('augment.wordsIntoEmoji');
  return {
    knob: 'augment.wordsIntoEmoji',
    consume(tok) {
      if (state.verdict !== 'unknown') return;
      if (isEmojiWord(tok)) {
        applyRule(state, {
          rule: 'emoji-glyph-present',
          verdict: 'likely',
          confidence: 0.95,
          why: 'emoji glyph present in suspected',
        });
      }
    },
    finalize() {
      if (state.verdict === 'unknown') {
        applyRule(state, {
          rule: 'no-emoji-after-full-scan',
          verdict: 'unlikely',
          confidence: 0.7,
          why: 'no emoji glyphs seen',
        });
      }
    },
    verdict() {
      return {
        verdict: state.verdict,
        confidence: state.confidence,
        why: state.why,
        done: state.verdict === 'likely',
        rule: state.rule,
        contradiction: state.contradiction,
        history: state.history,
      };
    },
  };
}

// augment.emojiIntoWords
//
// Cannot be distinguished from wordsIntoEmoji by suspected-glyph
// presence alone (both augments produce emoji in suspected output). So
// this detector mirrors the wordsIntoEmoji signal: emoji-present
// promotes to a weaker `likely` (~0.5) because disambiguation
// costs confidence; absence after full scan promotes to `unlikely`
// at finalize.
export function createEmojiIntoWordsCheck() {
  const state = createVerdictState('augment.emojiIntoWords');
  return {
    knob: 'augment.emojiIntoWords',
    consume(tok) {
      if (state.verdict !== 'unknown') return;
      if (isEmojiWord(tok)) {
        applyRule(state, {
          rule: 'emoji-glyph-present-disambig-weak',
          verdict: 'likely',
          confidence: 0.5,
          why: 'emoji glyph present (cannot disambiguate from wordsIntoEmoji)',
        });
      }
    },
    finalize() {
      if (state.verdict === 'unknown') {
        applyRule(state, {
          rule: 'no-emoji-after-full-scan',
          verdict: 'unlikely',
          confidence: 0.7,
          why: 'no emoji glyphs seen',
        });
      }
    },
    verdict() {
      return {
        verdict: state.verdict,
        confidence: state.confidence,
        why: state.why,
        done: state.verdict === 'likely',
        rule: state.rule,
        contradiction: state.contradiction,
        history: state.history,
      };
    },
  };
}

// augment.maxEmojiCluster (internal Eve knob, not a byos field)
//
// Both emoji augs (emojiIntoWords / wordsIntoEmoji) at intensity N
// can produce dict entries with N-emoji clusters (e.g. `rose 🌹🌹🌹`
// at intensity 3). The lexer's EMOJI_CLUSTER_RE collapses adjacent
// emoji glyphs into a single WORD token, so the relevant signal is
// the emoji-glyph count INSIDE one cluster. We track the max across
// all emoji-WORD tokens. A suspected with a longest cluster of L
// rules out any per-aug intensity > L; an enabled aug must have
// intensity >= L if L > 0.
const EMOJI_GLYPH_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/gu;

export function createMixedPhrasesCheck() {
  const state = createVerdictState('augment.maxEmojiCluster');
  let max = 0;
  return {
    knob: 'augment.maxEmojiCluster',
    consume(tok) {
      if (!isEmojiWord(tok)) return;
      const m = tok.value.match(EMOJI_GLYPH_RE);
      const count = m ? m.length : 0;
      if (count > max) max = count;
    },
    finalize() {
      if (max === 0 && state.verdict === 'unknown') {
        applyRule(state, {
          rule: 'no-emoji-runs-after-full-scan',
          verdict: 'unlikely',
          confidence: 0.7,
          why: 'longest emoji-run = 0',
        });
      }
      // max > 0: no rule fires. The observed `max` is carried in
      // the verdict's data field so the combination counter can use
      // it as an upper bound on mixedPhrases without needing a
      // verdict promotion.
    },
    verdict() {
      const why = state.why || `longest emoji-run = ${max}`;
      const data = { max };
      return {
        verdict: state.verdict,
        confidence: state.verdict === 'unknown' ? 0.5 : state.confidence,
        why,
        done: false,
        data,
        rule: state.rule,
        contradiction: state.contradiction,
        history: state.history,
      };
    },
  };
}

// sources.<name>
//
// Positive evidence: any suspected WORD matches a word in this source's
// vocabulary. One hit decides 'likely' and the detector is done.
// Negative evidence: after K suspected WORDs with zero hits, verdict
// becomes 'unlikely' and the detector is done. Until then, 'unknown'.
//
// `wordSet` is a Set<string> of lowercase words drawn from the
// source's TW-list. The caller chooses how to build it: full TW-list
// for a coarse first pass, or distinctive-only (TW-list minus the
// common-to-all-sources intersection) for sharper signal. Commit 1
// ships coarse; later commits can refine.
// Internal factory shared by sources/customCorpus/customTwlist.
// Same positive-on-first-hit / negative-after-budget semantics with
// a configurable knob name and verdict phrasing.
function createSetMembershipCheck(knob, wordSet, opts = {}) {
  const budget = opts.budget ?? 50000;
  const label = opts.label ?? 'TW-list';
  const state = createVerdictState(knob);
  let hits = 0;
  let wordsSeen = 0;
  return {
    knob,
    consume(tok) {
      if (state.verdict !== 'unknown') return;
      if (tok.type !== TOKEN.WORD) return;
      wordsSeen++;
      if (wordSet.has(tok.value.toLowerCase())) {
        hits++;
        applyRule(state, {
          rule: 'set-token-hit',
          verdict: 'likely',
          confidence: 0.6,
          why: `${hits} ${label} token hit at word ${wordsSeen}`,
        });
        return;
      }
      if (wordsSeen >= budget) {
        applyRule(state, {
          rule: 'budget-exhausted-no-set-tokens',
          verdict: 'unlikely',
          confidence: 0.8,
          why: `no ${label} tokens in ${wordsSeen} suspected words`,
        });
      }
    },
    // No finalize: stream-end before budget reach leaves verdict as
    // 'unknown' (small-suspected case; not enough evidence to commit).
    verdict() {
      const why = state.why || `${wordsSeen} suspected words scanned, no hits yet`;
      const confidence = state.verdict === 'unknown' ? 0.3 : state.confidence;
      return {
        verdict: state.verdict,
        confidence,
        why,
        done: state.verdict !== 'unknown',
        rule: state.rule,
        contradiction: state.contradiction,
        history: state.history,
      };
    },
  };
}

// customCorpus / customTwlist detectors. Same set-membership
// pattern as sources.<name>; different knob name and different
// label in the "why" string. Caller supplies the lowercase-word
// Set built from the developer-supplied corpus or TW-list. A
// custom corpus's "distinctive set" (custom-only tokens minus the
// base-corpus intersection) gives sharper signal; commit 3c ships
// coarse (all custom tokens) and refinement is a follow-up.
export function createCustomCorpusCheck(wordSet, opts = {}) {
  return createSetMembershipCheck('customCorpus', wordSet, { ...opts, label: 'custom-corpus' });
}
export function createCustomTwlistCheck(wordSet, opts = {}) {
  return createSetMembershipCheck('customTwlist', wordSet, { ...opts, label: 'custom-TW-list' });
}

export function createSourceCheck(name, wordSet, opts = {}) {
  return createSetMembershipCheck(`sources.${name}`, wordSet, { ...opts, label: 'TW-list' });
}
