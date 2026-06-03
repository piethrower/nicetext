// Eve honest stubs for knobs that no current strategy can decide.
//
// Each entry produces a verdict envelope of `unknown` with named-
// rule attribution explaining why no detector applies. The verdict
// table thus shows EVERY byos knob, with no silent omissions: a
// stub row is the honest answer when Eve cannot decide.
//
// See docs/eve-plan.md "Honest stubs" subsection. Adding a new
// stub here adds a row to every Eve run.
//
// Browser-safe ESM, zero deps. Built without applyRule because
// applyRule explicitly refuses incoming verdict 'unknown' (it
// treats abstention as a no-op). Stubs are abstentions WITH
// attribution: the verdict stays 'unknown' but `rule` and `why`
// carry the named explanation.

const STUBS = [
  {
    knob: 'tieBreak',
    rule: 'strategy-5-deferred',
    why: 'tieBreak effect is deterministic per byos family but not detectable from the suspected alone. Deferred to the precomputed knob-relevance fixture (strategy 5).',
  },
  {
    knob: 'frequencies.norvig',
    rule: 'strategy-5-deferred',
    why: 'Zipf-shape correlation against the Norvig (web) frequency table is noisy; deferred to the precomputed knob-relevance fixture (strategy 5).',
  },
  {
    knob: 'frequencies.google',
    rule: 'strategy-5-deferred',
    why: 'Zipf-shape correlation against the Google Books frequency table is noisy; deferred to the precomputed knob-relevance fixture (strategy 5).',
  },
  {
    knob: 'frequencies.gutenberg',
    rule: 'strategy-5-deferred',
    why: 'Zipf-shape correlation against the Project Gutenberg frequency table is noisy; deferred to the precomputed knob-relevance fixture (strategy 5).',
  },
];

// Returns an array of verdict envelopes in the same shape every
// other Eve detector emits (knob, verdict, confidence, why, done,
// rule, contradiction, history).
export function getStubVerdicts() {
  return STUBS.map((s) => ({
    knob: s.knob,
    verdict: 'unknown',
    confidence: 0,
    why: s.why,
    done: true,
    rule: s.rule,
    contradiction: false,
    history: [{ rule: s.rule, from: 'unknown', to: 'unknown', why: s.why, confidence: 0 }],
  }));
}
