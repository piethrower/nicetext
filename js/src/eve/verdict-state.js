// Eve verdict-state primitive. Step 1 of the verdict meta-rule
// refactor.
//
// Every knob Eve tracks starts at 'unknown'. Named rules fire in
// priority order and can promote the verdict to 'likely' or
// 'unlikely'. A reversing rule (likely <-> unlikely) is loud:
// `contradiction` flips true so the UI can surface a contradiction
// the developer should review.
//
// Each accepted promotion is recorded in `history` so the UI can
// render "knob X is likely because rule R fired" and offer per-rule
// overrides.
//
// Browser-safe ESM, zero deps. Detectors call applyRule; nothing
// else mutates state.

export function createVerdictState(knob) {
  return {
    knob,
    verdict: 'unknown',
    rule: null,
    confidence: 0,
    why: '',
    history: [],
    contradiction: false,
  };
}

// Apply a rule's decision to a verdict state. `decision` shape:
//   { rule: string, verdict: 'likely' | 'unlikely' | 'unknown',
//     confidence?: number, why?: string }
//
// Returns the same state object, mutated. Transitions:
//   incoming 'unknown'                      -> no-op (rule abstained).
//   state 'unknown', incoming likely/unlikely -> quiet promotion.
//   state and incoming agree                -> keep first-firing rule
//                                              as attribution, raise
//                                              confidence to the max,
//                                              record in history.
//   state and incoming disagree              -> reversal: contradiction
//                                              flips true, attribution
//                                              moves to the reversing
//                                              rule, history records
//                                              the transition.
export function applyRule(state, decision) {
  const incoming = decision.verdict;
  if (incoming === 'unknown') return state;
  if (incoming !== 'likely' && incoming !== 'unlikely') {
    throw new Error(`applyRule: invalid verdict ${incoming}`);
  }
  if (!decision.rule || typeof decision.rule !== 'string') {
    throw new Error('applyRule: decision.rule is required');
  }

  const confidence = decision.confidence ?? 0;
  const why = decision.why ?? '';
  const prev = state.verdict;

  if (prev === 'unknown') {
    state.verdict = incoming;
    state.rule = decision.rule;
    state.confidence = confidence;
    state.why = why;
    state.history.push({ rule: decision.rule, from: prev, to: incoming, why, confidence });
    return state;
  }

  if (prev === incoming) {
    if (confidence > state.confidence) state.confidence = confidence;
    state.history.push({ rule: decision.rule, from: prev, to: incoming, why, confidence });
    return state;
  }

  state.verdict = incoming;
  state.rule = decision.rule;
  state.confidence = confidence;
  state.why = why;
  state.contradiction = true;
  state.history.push({ rule: decision.rule, from: prev, to: incoming, why, confidence });
  return state;
}
