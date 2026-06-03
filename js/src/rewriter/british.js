// js/src/rewriter/british.js -- runtime for the british cover-transform
// rewriter.
//
// Architecture: see `docs/cover-transforms.md`. Sources:
// fixture-src/rewriters/british/pairs.tsv.gz (3,096 (source, target,
// direction) rows derived from client9/misspell's DictAmerican +
// DictBritish blocks, MIT-licensed).
//
// Two modes share apply():
//   us-uk  (Britishize: US -> UK). Map<american-word, Set<british>>
//   uk-us  (Americanize: UK -> US). Map<british-word,  Set<american>>
// jobs.js loads fixtures/british-{us-uk,uk-us}.rewriter.sab.gz
// before encode runs; the runtime apply() is mode-agnostic, it just
// consults whatever Map setRewriterData() handed it.
//
// The build pipeline emits a single shared twlist
// (fixtures/rewriter-british.twlist.sab.gz) containing one 0-bit
// singleton per unique word across both directions. Each type is
// `british_w_<word>`, unique per word; sortdct's merge keeps every
// entry singleton even when other twlist sources contribute the same
// word under different type names.

import { createLookupSwapRewriter } from './_lookup-swap.js';

const _ = createLookupSwapRewriter();

export const apply                       = _.apply;
export const setRewriterData             = _.setRewriterData;
export const setRewriterIntensity        = _.setRewriterIntensity;
export const setRewriterRandom           = _.setRewriterRandom;
export const _resetRewriterDataForTests  = _._resetRewriterDataForTests;
