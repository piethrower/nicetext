// Eve orchestrator. Step 3 of the multi-worker scheduler arc.
//
// Builds the Phase I job DAG from a suspected + fixture lists, runs
// `runScheduler` with a caller-supplied `dispatchJob`, and emits
// the Eve-flavored event stream the page renderer (or the node
// CLI) already understands:
//   { kind: 'banner', text }
//   { kind: 'progress', test, what, count?, total? }
//   { kind: 'verdict', knob, title, call?, detail?, verdict, why,
//                      rule, contradiction, history, data? }
//   { kind: 'detail', text }
//   { kind: 'cancelled' }
//   { kind: 'done' }
//   { kind: 'error', message }
//
// Pure ESM, no I/O, no worker spawn. Callers (browser eve-worker.js,
// node tools/eve/run-pool.mjs) own the worker pool + fixture I/O
// and hand the orchestrator a single `dispatchJob` callback.
//
// Browser-safe and node-safe.

import { runScheduler } from '../scheduler.js';
import { tokenize as eveTokenize, TOKEN } from '../lexer.js';
import { aggregateMonotypedModelVerdicts } from './monotyped-model-check.js';
import { parseTwlistLines } from '../builder/sources.js';
import { getStubVerdicts } from './stub-verdicts.js';
import { countCombinations } from './combinations.js';

// runOrchestrator({
//   suspectedText,
//   observations,      optional Cover-Story-side cached findings:
//                      { detectedLayers, appliedLayers, preclean }.
//                      Eve would derive these on her own with a load
//                      pipeline; passing them through avoids
//                      recomputation and lets detectors short-circuit
//                      strongly (e.g., isNiceText 'unlikely' when the
//                      suspected bytes still carry an un-stripped
//                      wrapper residue). Source/filename/ingest event
//                      are NOT included, those would be cheating.
//   twlistMeta,        Array<{ key, filename }>  (per twlist source)
//   cardList,          Array<{ name, stem }>     (per corpus card)
//   dispatchJob,       async (job) => result
//   concurrency,       number or null (null -> Infinity)
//   signal,
//   onEvent,           (event) => void
// })
//
// All per-corpus precomputes (wlist + monotyped-model) load through
// loadResource(stem, resourceCategory, { fixture: true }), which
// auto-resolves /fixtures/ from one anchor inside the loader. No
// caller-composed URL builder is required.
export async function runOrchestrator({
  suspectedText,
  observations,
  twlistMeta,
  cardList,
  dispatchJob,
  loadResource,
  // Developer-supplied extra detectors (CLI flags or future BYOS
  // upload UI). Array<{ kind, name?, url }>:
  //   { kind: 'source',       name, url }  -> sources.<name>
  //   { kind: 'customCorpus',       url }  -> customCorpus
  //   { kind: 'customTwlist',       url }  -> customTwlist
  // The orchestrator loads each URL via `raw-bytes`, parses
  // locally to a word set, and threads the spec into the
  // suspected-token-scan job (detector functions can't cross
  // postMessage; their config can).
  extraDetectors = [],
  concurrency = null,
  signal = null,
  onEvent = () => {},
}) {
  // Capture every verdict event as it goes out so the combinations
  // counter (emitted at the end of the run) can score the surviving
  // byos space without the caller having to subscribe and tally.
  const emittedVerdicts = [];
  const emit = (e) => {
    if (e && e.kind === 'verdict') emittedVerdicts.push(e);
    try { onEvent(e); } catch {}
  };
  if (typeof loadResource !== 'function') {
    throw new Error(
      'runOrchestrator: loadResource is required. Pass the shared ' +
      'resource-loader.loadResource (node) or resource-loader-client.loadResource (worker).',
    );
  }

  try {
    emit({ kind: 'banner', text: `Progressive Loop 1: analyzing ${suspectedText.length.toLocaleString()} chars` });

    // Wrap a loadResource call with load-start / load-progress /
    // load-end events keyed by `rowId`. The page renders one row
    // per active rowId in the busy-modal's loads block, so 20
    // concurrent loads show 20 live-updating lines. `rowId` is
    // chosen by the caller so the corpus pair (vocab + monotyped-model)
    // can give each load its own row without collision.
    const loadWithRow = async (rowId, idOrPath, resourceCategory, opts = {}) => {
      emit({ kind: 'load-start', id: rowId });
      try {
        return await loadResource(idOrPath, resourceCategory, {
          ...opts,
          onProgress: (label) => emit({ kind: 'load-progress', id: rowId, label }),
        });
      } finally {
        emit({ kind: 'load-end', id: rowId });
      }
    };

    // Phase 1: preload all wlists (per twlist source AND per corpus)
    // + per-corpus monotyped-model precomputes via the shared
    // resource loader. Loads run in parallel; the loader dedupes any URL
    // that's already cached from a previous Eve run (or a sibling
    // consumer in the same realm). Each load gets its own row in
    // the busy-modal loads block via loadWithRow.
    //
    // wlistsByKey holds the wlist SAB for each twlist source (key =
    // twlist source name, e.g. 'mit', 'rhyme'). corpusByStem holds
    // the per-corpus wlist (`vocabSab`, a wlist SAB) plus the per-
    // corpus monotyped-model SAB. Naming convention: variables
    // ending in `Sab` named after a wlist concept (`vocabSab`,
    // `wlistsByKey`) hold packed-strings-SAB (NTPS) refs;
    // `monotypedModelSab` holds the NTMM monotyped-model SAB. The
    // on-disk type `twlist` (entries-SAB / NTEN) is a different
    // shape and never aliased here. See js/src/sab.js /
    // SAB_RESOURCE_CATEGORIES.
    const wlistsByKey = new Map();        // key -> wlist SAB (NTPS)
    const corpusByStem = new Map();       // stem -> {vocabSab, monotypedModelSab}

    const wlistLoads = twlistMeta.map(async ({ key }) => {
      // Per-twlist-source wlist: the wordlist projection of the
      // .twlist.tsv.gz source, shipped as /fixtures/<key>.wlist.sab.gz
      // by tools/build-twlist-wlist.js + `sab pack wlist`.
      try {
        const sab = await loadWithRow(key, key, 'wlist', { fixture: true });
        wlistsByKey.set(key, sab);
      } catch (err) {
        emit({
          kind: 'progress', test: 'load-wlist',
          what: `${key}: load failed (${err && err.message || err})`,
        });
      }
    });

    const uniqueStems = new Set();
    for (const card of cardList) if (card.stem) uniqueStems.add(card.stem);
    const corpusLoads = [...uniqueStems].map(async (stem) => {
      // Per-corpus pair: corpus wlist (the corpus-text wordlist,
      // /fixtures/<stem>.wlist.sab.gz, built by build-corpus-wlist.js)
      // plus the corpus monotyped-model (NTMM,
      // /fixtures/<stem>.monotyped-model.sab.gz, built by
      // tools/build-monotyped-models.js). The shared loader caches
      // each independently; both fetches run in parallel via the
      // worker pool. Each gets its own row id (vocab vs
      // monotyped-model) so the modal shows both lines.
      try {
        const [vocabSab, monotypedModelSab] = await Promise.all([
          loadWithRow(`${stem} (vocab)`, stem, 'wlist', { fixture: true }),
          loadWithRow(`${stem} (monotyped-model)`, stem, 'monotyped-model', { fixture: true }),
        ]);
        corpusByStem.set(stem, { vocabSab, monotypedModelSab });
      } catch (err) {
        emit({
          kind: 'progress', test: 'load-corpus-precompute',
          what: `${stem}: load failed (${err && err.message || err})`,
        });
      }
    });

    // Materialize developer-supplied extras alongside the fixture
    // twlists. Each entry's URL feeds `raw-bytes`, then we parse
    // locally into a lowercased word array that crosses postMessage
    // into the suspected-token-scan job.
    const extras = [];
    const extraLoads = extraDetectors.map(async (spec) => {
      try {
        const rowId = spec.name || spec.url;
        const sab = await loadWithRow(rowId, spec.url, 'raw-bytes', { fixture: false });
        const view = new Uint8Array(sab);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        const text = new TextDecoder('utf-8').decode(copy);
        const set = new Set();
        if (spec.kind === 'customCorpus') {
          for (const tok of eveTokenize(text)) {
            if (tok.type === TOKEN.WORD) set.add(tok.value.toLowerCase());
          }
        } else {
          // 'source' or 'customTwlist', both are TW-list-shaped.
          for (const e of parseTwlistLines(text)) {
            set.add(e.word.toLowerCase());
          }
        }
        const words = [...set];
        const out = { kind: spec.kind, words };
        if (spec.kind === 'source') out.name = spec.name;
        extras.push(out);
      } catch (err) {
        emit({
          kind: 'progress', test: `load-${spec.kind}`,
          what: `${spec.name || spec.url}: load failed (${err && err.message || err})`,
        });
      }
    });

    await Promise.all([...wlistLoads, ...corpusLoads, ...extraLoads]);

    if (signal?.aborted) {
      emit({ kind: 'cancelled' });
      return { results: null, cancelled: true };
    }

    // Phase 2: compute DAG.
    //
    // Independent:
    //   - is-nicetext
    //   - suspected-token-scan
    //   - build-suspected-monotyped-model
    //   - vocab-check       (wlistsByKey already in payload)
    //
    // Dependent:
    //   - corpus-vocab-check(card)  deps: vocab-check
    //   - monotyped-model-check-card(card)  deps: build-suspected-monotyped-model
    //
    // Per-card monotyped-model-check fans out across the worker pool; the
    // orchestrator aggregates verdicts after the scheduler
    // completes (cheap pure-derivation pass).
    const jobs = [];
    jobs.push({ id: 'is-nicetext', kind: 'is-nicetext', payload: { suspectedText, observations } });
    jobs.push({ id: 'suspected-token-scan', kind: 'suspected-token-scan', payload: { suspectedText, extras } });
    jobs.push({ id: 'build-suspected-monotyped-model', kind: 'build-suspected-monotyped-model', payload: { suspectedText } });

    jobs.push({
      id: 'vocab-check',
      kind: 'vocab-check',
      payload: { suspectedText, wlistsByKey },
    });

    for (const card of cardList) {
      if (!card.stem) continue;
      const corpus = corpusByStem.get(card.stem);
      jobs.push({
        id: `corpus-vocab-check:${card.name}`,
        kind: 'corpus-vocab-check',
        deps: ['vocab-check'],
        payload: {
          corpusName: card.name,
          vocabSab: corpus ? corpus.vocabSab : null,
        },
      });
    }

    const monotypedModelCheckCardJobIds = [];
    for (const card of cardList) {
      if (!card.stem) continue;
      const corpus = corpusByStem.get(card.stem);
      const id = `monotyped-model-check-card:${card.name}`;
      monotypedModelCheckCardJobIds.push(id);
      jobs.push({
        id,
        kind: 'monotyped-model-check-card',
        deps: ['build-suspected-monotyped-model'],
        payload: {
          _cardName: card.name,
          monotypedModelSab: corpus ? corpus.monotypedModelSab : null,
        },
      });
    }

    // Runtime payload-resolver wrapper. For compute jobs whose
    // payloads embed results from upstream compute jobs (suspected
    // unique-words from vocab-check; suspected monotyped model from
    // build-suspected-monotyped-model), fill in those values from
    // lastResults at dispatch time.
    const wrappedDispatch = async (job) => {
      let payload = job.payload;
      if (job.id.startsWith('corpus-vocab-check:')) {
        const vocabResult = lastResults.get('vocab-check');
        payload = {
          suspectedUniqueWords: new Set(vocabResult.uniqueWords),
          vocabSab: job.payload.vocabSab,
          corpusName: job.payload.corpusName,
        };
      } else if (job.id.startsWith('monotyped-model-check-card:')) {
        const buildResult = lastResults.get('build-suspected-monotyped-model');
        payload = {
          suspectedMonotypedModelSab: buildResult ? buildResult.monotypedModelSab : null,
          card: {
            name: job.payload._cardName,
            monotypedModelSab: job.payload.monotypedModelSab,
          },
        };
      }
      // emit a progress event so the page log shows what's
      // running. Same shape as the existing single-worker path.
      emit({
        kind: 'progress',
        test: job.kind,
        what: progressLabelFor(job),
      });
      return await dispatchJob({ ...job, payload });
    };

    // Tracking for payload resolution. The scheduler doesn't expose
    // its result map during a run, so the orchestrator maintains
    // its own write-through copy via the result-handlers below.
    const lastResults = new Map();

    const schedulerConcurrency = concurrency == null ? Infinity : concurrency;

    // Build a results-recording onProgress that mirrors the
    // scheduler's job-done events into lastResults. The actual
    // result lands when dispatchJob resolves; we wire that via the
    // wrappedDispatch return value too.
    const realDispatch = wrappedDispatch;
    // Retry transient resource-pressure failures. SpiderMonkey
    // sometimes surfaces concurrent-load memory pressure as "too
    // much recursion"; node and Chromium are typically fine but
    // Firefox under 23-worker concurrent load can trip. After a
    // pause (other workers may have finished and GC'd in the
    // meantime), the same job re-dispatches against the pool and
    // usually goes through. Up to MAX_ATTEMPTS, then gives up.
    const TRANSIENT_RE = /too much recursion|out of memory|InternalError|memory allocation/i;
    const MAX_ATTEMPTS = 3;
    const dispatchWithRetry = async (job) => {
      let attempt = 0;
      while (true) {
        try {
          return await realDispatch(job);
        } catch (err) {
          attempt++;
          const msg = String(err && err.message || err);
          if (attempt >= MAX_ATTEMPTS || !TRANSIENT_RE.test(msg)) throw err;
          emit({
            kind: 'progress',
            test: job.kind,
            what: `${job.id} attempt ${attempt} hit "${msg.split('\n')[0]}"; pausing then retrying...`,
          });
          // Exponential-ish backoff to give other workers time to
          // finish and the GC time to free pool memory.
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    };
    const dispatchAndRecord = async (job) => {
      const result = await dispatchWithRetry(job);
      lastResults.set(job.id, result);
      emitVerdictsForJob(job, result, emit);
      return result;
    };

    const results = await runScheduler({
      jobs,
      onJobReady: dispatchAndRecord,
      concurrency: schedulerConcurrency,
      signal,
      onProgress: (evt) => {
        // Scheduler-level events are useful for telemetry but the
        // page event surface is verdict/progress/banner, not
        // job-start/job-done. We emit a coarse progress ping per
        // job-done so the page sees activity even when a worker is
        // still computing on a job emitting nothing intermediate.
        if (evt.kind === 'job-failed') {
          emit({ kind: 'progress', test: 'error', what: `job ${evt.jobId} failed: ${evt.error?.message ?? 'unknown'}` });
        }
      },
    });

    // Emit must-literal detail + finished event.
    const vocab = results.get('vocab-check');
    if (vocab && vocab.mustLiterals && vocab.mustLiterals.length > 0) {
      const sample = vocab.mustLiterals.slice(0, 50).join(', ');
      const more = vocab.mustLiterals.length > 50
        ? `  ... (${vocab.mustLiterals.length - 50} more)`
        : '';
      emit({ kind: 'detail', text: `Sample must-literals: ${sample}${more}` });
    }

    // Aggregate per-card monotyped-model-check stats into the three verdicts
    // (story.style.<name>, phrases, story.sentence). Each per-card
    // job emits no verdicts on its own; this is the single place
    // the final shape verdicts land.
    const buildSuspected = results.get('build-suspected-monotyped-model');
    if (buildSuspected && monotypedModelCheckCardJobIds.length > 0) {
      const perCardStats = [];
      for (const id of monotypedModelCheckCardJobIds) {
        const s = results.get(id);
        if (s) perCardStats.push(s);
      }
      if (perCardStats.length > 0) {
        const monoVerdicts = aggregateMonotypedModelVerdicts(
          perCardStats, buildSuspected.totalSuspected, {},
        );
        for (const v of monoVerdicts.verdicts) {
          emit({
            kind: 'verdict',
            knob: v.knob,
            title: v.knob,
            detail: v.why,
            verdict: v.verdict,
            why: v.why,
            rule: v.rule ?? null,
            contradiction: v.contradiction ?? false,
            history: v.history ?? null,
          });
        }
      }
    }

    // Honest stubs for knobs no current strategy decides (tieBreak +
    // frequencies.<name> deferred to strategy 5). Emitted last so
    // the verdict table shows every byos knob with a named-rule
    // attribution. augment.vowel was retired with the xanax
    // rewriter migration.
    for (const v of getStubVerdicts()) {
      emit({
        kind: 'verdict',
        knob: v.knob,
        title: v.knob,
        detail: v.why,
        verdict: v.verdict,
        why: v.why,
        rule: v.rule,
        contradiction: v.contradiction,
        history: v.history,
      });
    }

    // Stats: count surviving byos combinations given every verdict
    // emitted in this run. Styles = the card names plus 'flat'. The
    // browser footer and the node CLI both consume this single event.
    {
      const styles = (cardList || []).map(c => c.name).concat(['flat']);
      const counts = countCombinations(emittedVerdicts, { styles });
      emit({
        kind: 'stats',
        combinationsAlive: counts.total,
        stylesIn: counts.stylesIn,
        stylesConsidered: counts.stylesConsidered,
        augCount: counts.augCount,
      });
    }

    emit({ kind: 'done' });
    // Hand the scheduler's full results map back to the caller so
    // node CLIs / browser glue can render aggregate summaries
    // (vocab tables, candidate-combinations, etc.) after the run
    // without re-running the engine. Browser callers can ignore
    // the return value; the event-stream surface still works.
    return { results };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
      emit({ kind: 'cancelled' });
      return { results: null, cancelled: true };
    }
    // Cross-browser format: V8's err.stack starts with the error
    // message; Firefox's omits it. Build a string that always begins
    // with the message so consumers (test assertions, UI surfaces)
    // can pattern-match on either part.
    const msg = err && err.message ? String(err.message) : '';
    const stack = err && err.stack ? String(err.stack) : '';
    const formatted = msg
      ? (stack && !stack.startsWith(msg) ? `${msg}\n${stack}` : (stack || msg))
      : (stack || String(err));
    emit({ kind: 'error', message: formatted });
    return { results: null, error: err };
  }
}

function progressLabelFor(job) {
  switch (job.kind) {
    case 'suspected-token-scan':       return 'token-level suspected scan';
    case 'is-nicetext':            return 'autoStrip + preclean idempotency on suspected slice';
    case 'vocab-check':            return 'per-TW-list coverage';
    case 'corpus-vocab-check':     return `corpus-vocab subset: ${job.id.split(':')[1]}`;
    case 'build-suspected-monotyped-model': return 'building suspected monotyped-model';
    case 'monotyped-model-check-card':  return `monotyped-model-check card: ${job.id.split(':')[1]}`;
    default:                       return job.kind;
  }
}

// Translate per-job results into the verdict-row events the page
// consumes. Mirrors the inline emissions in the legacy
// js/eve-worker.js so the page renderer stays unchanged.
function emitVerdictsForJob(job, result, emit) {
  if (!result) return;
  switch (job.kind) {
    case 'is-nicetext': {
      const v = result;
      emit({
        kind: 'verdict',
        knob: 'isNiceText',
        title: 'isNiceText: autoStrip + preclean idempotency',
        call: 'runIsNiceTextCheck(suspected)',
        detail: 'Slice of the suspected passed through autoStrip then precleanCorpus. If preclean changes any byte, the suspected almost certainly was not produced by a NiceText engine.',
        verdict: v.verdict,
        why: v.why,
        rule: v.rule ?? null,
        contradiction: v.contradiction ?? false,
        history: v.history ?? null,
      });
      break;
    }
    case 'suspected-token-scan': {
      for (const v of result.verdicts) {
        emit({
          kind: 'verdict',
          knob: v.knob,
          title: `${v.knob}: token-level scan`,
          call: `runPhase1(tokenize(suspected), [${v.knob}])`,
          detail: `Streams the suspected through the lexer and feeds WORD tokens to the ${v.knob} detector.`,
          verdict: v.verdict,
          why: v.why,
          rule: v.rule ?? null,
          contradiction: v.contradiction ?? false,
          history: v.history ?? null,
        });
      }
      break;
    }
    case 'vocab-check': {
      const vocab = result;
      emit({
        kind: 'verdict',
        title: 'Vocab check: per-TW-list coverage',
        call: 'runVocabCheck(suspected, allTwlists)',
        detail: `${vocab.twlistNames.length} TW-lists scanned against ${vocab.totalUnique} unique suspected words. 0% coverage -> the TW-list cannot have been in base.sources; other rates listed as unknown pending combination analysis (deferred).`,
      });
      const sortedCoverage = [...vocab.perTwlistCoverage.entries()]
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => b.rate - a.rate);
      for (const r of sortedCoverage) {
        const pct = (r.rate * 100).toFixed(1);
        const isUnlikely = r.rate === 0;
        emit({
          kind: 'verdict',
          knob: `sources.${r.name}`,
          title: `sources.${r.name}`,
          detail: `${pct}% coverage  (${r.hits} / ${r.total} unique suspected words in this TW-list)`,
          verdict: isUnlikely ? 'unlikely' : 'unknown',
          why: isUnlikely
            ? '0% (no suspected word in this TW-list)'
            : 'positive evidence requires combination analysis (deferred)',
          rule: isUnlikely ? 'zero-twlist-coverage' : null,
          contradiction: false,
          history: isUnlikely
            ? [{ rule: 'zero-twlist-coverage', from: 'unknown', to: 'unlikely', why: '0% (no suspected word in this TW-list)', confidence: 0.8 }]
            : [],
        });
      }
      emit({
        kind: 'verdict',
        title: 'Must-literals: suspected words in zero TW-lists',
        call: 'vocab.mustLiterals',
        detail: vocab.mustLiterals.length === 0
          ? 'Every unique suspected word is in at least one shipped TW-list. No must-literals.'
          : `${vocab.mustLiterals.length} suspected words are not in any shipped TW-list.`,
      });
      break;
    }
    case 'corpus-vocab-check': {
      const v = result;
      const total = v.data.totalUnique;
      const detail = v.data.allPresent
        ? `all ${total} unique suspected words found in ${v.knob.split('.').pop()}.corpus_vocab`
        : `${v.data.missing} of ${total} unique suspected words missing from ${v.knob.split('.').pop()}.corpus_vocab`;
      emit({
        kind: 'verdict',
        knob: v.knob,
        title: `story.vocabulary='corpus' with ${v.knob.split('.').pop()}`,
        detail,
        verdict: v.verdict,
        why: v.why,
        rule: v.rule,
        contradiction: v.contradiction,
        history: v.history,
      });
      break;
    }
    // build-suspected-monotyped-model + monotyped-model-check-card
    // jobs don't emit verdicts on their own; the orchestrator
    // aggregates the per-card stats after the scheduler completes.
    // load-* jobs don't emit verdicts; their results feed dependents.
    default: break;
  }
}

// Helper exported for the orchestrator's pre-tokenize step in
// callers that want the suspected's WORD set (e.g., to display unique-
// count before scheduler starts). Not strictly required for
// runOrchestrator, but matches the existing eve-worker UX.
export function suspectedUniqueWordSet(suspectedText) {
  const set = new Set();
  for (const tok of eveTokenize(suspectedText)) {
    if (tok.type === TOKEN.WORD) set.add(tok.value.toLowerCase());
  }
  return set;
}
