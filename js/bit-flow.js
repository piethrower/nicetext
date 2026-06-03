// NiceText conceptual mini-animation. Builds a 4-phase
// (Conceal / Share Style / Share Cover / Reveal) bit-flow demo
// inside a given root element and runs it on a loop. Designed as
// the engine for the splash slideshow's NiceText slide; the slide
// shows ONE sub-phase at a time (the .bf-pair-staged wrapper hides
// non-active phase boxes via CSS).
//
// Each cycle draws from a different style + word-bit mapping in
// CYCLES so the same secret bits visibly produce different cover
// stories. After Reveal completes, the secret rows flash to confirm
// the round-trip; a "✓ Match!" badge rides alongside.
//
// Usage:
//   import { mountNiceTextAnim } from './bit-flow.js';
//   const handle = mountNiceTextAnim(document.getElementById('slot'));
//   // later, to tear down:
//   handle.stop();
//
// prefers-reduced-motion: renders the static end-state once, no loop.

const CYCLES = [
  {
    style: "Aesop's Fables",
    pairs: [
      { bits: '10',  word: 'once'  },
      { bits: '1',   word: 'upon'  },
      { bits: '0',   word: 'a'     },
      { bits: '110', word: 'time'  },
      { bits: '01',  word: 'there' },
      { bits: '1',   word: 'was'   },
    ],
  },
  {
    style: 'Shakespeare',
    pairs: [
      { bits: '1',   word: 'hark'  },
      { bits: '01',  word: 'a'     },
      { bits: '01',  word: 'voice' },
      { bits: '10',  word: 'rises' },
      { bits: '01',  word: 'in'    },
      { bits: '1',   word: 'song'  },
    ],
  },
  {
    style: 'Civic Oratory',
    pairs: [
      { bits: '1',   word: 'my'      },
      { bits: '010', word: 'friends' },
      { bits: '11',  word: 'the'     },
      { bits: '0',   word: 'time'    },
      { bits: '0',   word: 'has'     },
      { bits: '11',  word: 'come'    },
    ],
  },
];

const STEP_MS    = 700;
const PULSE_MS   = 600;
const SHARE_MS   = 2200;
const HOLD_MS    = 800;   // hold after each sub-phase

// Build the bf-pair DOM inside `root`, then return refs to the rows
// that get content mutated during animation. Callers may add the
// `bf-pair-staged` class on the root to enable single-phase visibility
// (used by mountStaticPhase); mountNiceTextAnim leaves it off so all
// four phase boxes remain visible while the active one is highlighted.
function buildDom(root) {
  root.replaceChildren();

  const pair = document.createElement('div');
  pair.className = 'bf-pair';

  function box(id, captionText, rows) {
    const box = document.createElement('div');
    box.className = 'bit-flow';
    box.id = id;
    box.setAttribute('aria-hidden', 'true');
    const caption = document.createElement('p');
    caption.className = 'bf-caption';
    caption.id = `${id}-caption`;
    caption.textContent = captionText;
    box.appendChild(caption);
    for (const r of rows) box.appendChild(r);
    return box;
  }
  function row(id, labelText, opts = {}) {
    const r = document.createElement('div');
    r.className = 'bf-row';
    if (opts.styleRow) r.classList.add('bf-row-style');
    if (opts.share) r.classList.add('bf-share-row');
    r.id = id;
    const lab = document.createElement('span');
    lab.className = 'bf-row-label';
    lab.textContent = labelText;
    r.appendChild(lab);
    return r;
  }
  function connector(text) {
    const c = document.createElement('div');
    c.className = 'bf-connector';
    c.textContent = text;
    return c;
  }

  const conceal = box('bf-conceal', 'Conceal', [
    row('bf-conceal-source', 'Secrets or Silliness:'),
    connector('with'),
    row('bf-conceal-style',  'Story Style:', { styleRow: true }),
    connector('to make'),
    row('bf-conceal-output', 'The Cover Story:'),
  ]);

  const shareStyle = box('bf-share-style-box', 'Share Style', [
    row('bf-share-style-row', 'Story Style:', { share: true }),
  ]);

  const shareCover = box('bf-share-cover-box', 'Share Cover Story', [
    row('bf-share-cover-row', 'The Cover Story:', { share: true }),
  ]);

  const reveal = box('bf-reveal', 'Reveal', [
    row('bf-reveal-source', 'The Cover Story:'),
    connector('with'),
    row('bf-reveal-style',  'Story Style:', { styleRow: true }),
    connector('to recover'),
    row('bf-reveal-output', 'Secrets or Silliness:'),
  ]);
  // Match badge rides inside reveal-output, hidden until flashSecrets.
  const badge = document.createElement('span');
  badge.className = 'bf-match-badge';
  badge.id = 'bf-match-badge';
  badge.hidden = true;
  badge.textContent = '✓ Match!';
  reveal.querySelector('#bf-reveal-output').appendChild(badge);

  pair.append(conceal, shareStyle, shareCover, reveal);
  root.appendChild(pair);

  return {
    conceal, shareStyle, shareCover, reveal, badge,
    captions: {
      conceal:     conceal.querySelector('.bf-caption'),
      shareStyle:  shareStyle.querySelector('.bf-caption'),
      shareCover:  shareCover.querySelector('.bf-caption'),
      reveal:      reveal.querySelector('.bf-caption'),
    },
    rows: {
      concealSource: conceal.querySelector('#bf-conceal-source'),
      concealStyle:  conceal.querySelector('#bf-conceal-style'),
      concealOutput: conceal.querySelector('#bf-conceal-output'),
      shareStyle:    shareStyle.querySelector('#bf-share-style-row'),
      shareCover:    shareCover.querySelector('#bf-share-cover-row'),
      revealSource:  reveal.querySelector('#bf-reveal-source'),
      revealStyle:   reveal.querySelector('#bf-reveal-style'),
      revealOutput:  reveal.querySelector('#bf-reveal-output'),
    },
  };
}

function makeBit(c) {
  const s = document.createElement('span');
  s.className = 'bf-bit';
  s.textContent = c;
  return s;
}
function makeWord(c) {
  const s = document.createElement('span');
  s.className = 'bf-word';
  s.textContent = c;
  return s;
}
function makeStyleValue(s) {
  const el = document.createElement('span');
  el.className = 'bf-style-value';
  el.textContent = s;
  return el;
}
function setRowContent(row, items) {
  if (!row) return;
  const label = row.querySelector('.bf-row-label');
  const badge = row.querySelector('.bf-match-badge');
  row.replaceChildren();
  if (label) row.appendChild(label);
  for (const it of items) row.appendChild(it);
  if (badge) row.appendChild(badge);
}

export function mountNiceTextAnim(root) {
  if (!root) throw new Error('mountNiceTextAnim: root element required');
  const refs = buildDom(root);
  const SECRET = CYCLES[0].pairs.flatMap(p => p.bits.split(''));

  let stopped = false;
  const timers = new Set();
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });
  function pulse(el) {
    if (!el) return;
    el.classList.add('bf-pulse');
    const t = setTimeout(() => { el.classList.remove('bf-pulse'); timers.delete(t); }, PULSE_MS);
    timers.add(t);
  }

  let cycleIdx = 0;
  const currentCycle = () => CYCLES[cycleIdx];
  const currentStyle = () => currentCycle().style;
  const currentCover = () => currentCycle().pairs.map(p => p.word);

  function setActivePhase(id) {
    for (const [name, el] of Object.entries({
      conceal: refs.conceal,
      'share-style': refs.shareStyle,
      'share-cover': refs.shareCover,
      reveal: refs.reveal,
    })) {
      const on = name === id;
      el.classList.toggle('bf-active', on);
      const cap = el.querySelector('.bf-caption');
      cap?.classList.toggle('bf-active', on);
    }
  }

  function reset() {
    setRowContent(refs.rows.concealSource, SECRET.map(makeBit));
    setRowContent(refs.rows.concealOutput, []);
    setRowContent(refs.rows.concealStyle,  [makeStyleValue(currentStyle())]);
    setRowContent(refs.rows.shareStyle,    []);
    setRowContent(refs.rows.shareCover,    []);
    refs.rows.shareStyle.classList.remove('bf-share-active');
    refs.rows.shareCover.classList.remove('bf-share-active');
    setRowContent(refs.rows.revealSource,  []);
    setRowContent(refs.rows.revealStyle,   []);
    // Re-append the badge after row rebuild.
    const out = refs.rows.revealOutput;
    setRowContent(out, []);
    refs.badge.classList.remove('bf-match-show');
    refs.badge.hidden = true;
    out.appendChild(refs.badge);
    refs.rows.concealSource.classList.remove('bf-flash');
    refs.rows.revealOutput.classList.remove('bf-flash');
    setActivePhase(null);
  }

  async function runConceal() {
    const bits = refs.rows.concealSource.querySelectorAll('.bf-bit');
    const out = refs.rows.concealOutput;
    let offset = 0;
    for (const pair of currentCycle().pairs) {
      if (stopped) return;
      for (let j = 0; j < pair.bits.length; j++) pulse(bits[offset + j]);
      const w = makeWord(pair.word);
      out.appendChild(w);
      pulse(w);
      offset += pair.bits.length;
      await sleep(STEP_MS);
    }
  }

  async function runShareStyle() {
    const r = refs.rows.shareStyle;
    setRowContent(r, [makeStyleValue(currentStyle())]);
    void r.offsetWidth;
    r.classList.add('bf-share-active');
    await sleep(SHARE_MS);
    setRowContent(refs.rows.revealStyle, [makeStyleValue(currentStyle())]);
  }

  async function runShareCover() {
    const r = refs.rows.shareCover;
    setRowContent(r, currentCover().map(makeWord));
    void r.offsetWidth;
    r.classList.add('bf-share-active');
    await sleep(SHARE_MS);
    setRowContent(refs.rows.revealSource, currentCover().map(makeWord));
  }

  async function runReveal() {
    const pairs = currentCycle().pairs;
    const words = refs.rows.revealSource.querySelectorAll('.bf-word');
    const out = refs.rows.revealOutput;
    for (let i = 0; i < pairs.length; i++) {
      if (stopped) return;
      if (words[i]) pulse(words[i]);
      const newBits = [];
      for (const c of pairs[i].bits) {
        const b = makeBit(c);
        out.appendChild(b);
        newBits.push(b);
      }
      for (const b of newBits) pulse(b);
      await sleep(STEP_MS);
    }
  }

  async function flashSecrets() {
    const rows = [refs.rows.concealSource, refs.rows.revealOutput];
    refs.badge.hidden = false;
    requestAnimationFrame(() => refs.badge.classList.add('bf-match-show'));
    const ON_MS  = 400;
    const OFF_MS = 350;
    for (let i = 0; i < 3; i++) {
      if (stopped) return;
      rows.forEach(r => r.classList.add('bf-flash'));
      await sleep(ON_MS);
      rows.forEach(r => r.classList.remove('bf-flash'));
      await sleep(OFF_MS);
    }
    rows.forEach(r => r.classList.add('bf-flash'));
  }

  function renderStaticEndState() {
    reset();
    setRowContent(refs.rows.concealOutput, currentCover().map(makeWord));
    setRowContent(refs.rows.shareStyle,    [makeStyleValue(currentStyle())]);
    setRowContent(refs.rows.shareCover,    currentCover().map(makeWord));
    setRowContent(refs.rows.revealSource,  currentCover().map(makeWord));
    setRowContent(refs.rows.revealStyle,   [makeStyleValue(currentStyle())]);
    const out = refs.rows.revealOutput;
    setRowContent(out, SECRET.map(makeBit));
    refs.badge.hidden = false;
    refs.badge.classList.add('bf-match-show');
    out.appendChild(refs.badge);
    setActivePhase('reveal');
  }

  async function loop() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      renderStaticEndState();
      return;
    }
    while (!stopped) {
      reset();
      setActivePhase('conceal');
      await runConceal();        if (stopped) return;
      await sleep(HOLD_MS);      if (stopped) return;
      setActivePhase('share-style');
      await runShareStyle();     if (stopped) return;
      await sleep(HOLD_MS);      if (stopped) return;
      setActivePhase('share-cover');
      await runShareCover();     if (stopped) return;
      await sleep(HOLD_MS);      if (stopped) return;
      setActivePhase('reveal');
      await runReveal();         if (stopped) return;
      setActivePhase(null);
      await sleep(800);          if (stopped) return;
      await flashSecrets();      if (stopped) return;
      await sleep(1200);
      cycleIdx = (cycleIdx + 1) % CYCLES.length;
    }
  }

  loop();

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

// Animated single-phase mount. Builds the bf-pair-staged scaffold,
// activates the named phase, and loops just that phase's animation
// (e.g. the Conceal bit-to-word reveal) until stop() is called.
// Used by the slideshow's per-phase NiceText slides where each
// phase gets its own full slide of attention while still animating.
//
// phase: 'conceal' | 'share-style' | 'share-cover' | 'reveal'
// opts.cycleIdx: which CYCLES entry (defaults to 0)
//
// Returns { stop }.
export function mountPhaseAnim(root, phase, opts = {}) {
  if (!root) throw new Error('mountPhaseAnim: root required');
  const cycleIdx = opts.cycleIdx ?? 0;
  const cycle = CYCLES[cycleIdx];
  const SECRET = cycle.pairs.flatMap(p => p.bits.split(''));
  const cover = cycle.pairs.map(p => p.word);

  const refs = buildDom(root);
  root.classList.add('bf-pair-staged');

  const boxMap = {
    'conceal':     refs.conceal,
    'share-style': refs.shareStyle,
    'share-cover': refs.shareCover,
    'reveal':      refs.reveal,
  };
  const box = boxMap[phase];
  if (!box) throw new Error(`mountPhaseAnim: unknown phase ${phase}`);
  box.classList.add('bf-active');
  box.querySelector('.bf-caption')?.classList.add('bf-active');

  let stopped = false;
  const timers = new Set();
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });
  function pulse(el) {
    if (!el) return;
    el.classList.add('bf-pulse');
    const t = setTimeout(() => { el.classList.remove('bf-pulse'); timers.delete(t); }, PULSE_MS);
    timers.add(t);
  }

  // Reduced-motion: fill the box with end-state content once, no loop.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    if (phase === 'conceal') {
      setRowContent(refs.rows.concealSource, SECRET.map(makeBit));
      setRowContent(refs.rows.concealStyle,  [makeStyleValue(cycle.style)]);
      setRowContent(refs.rows.concealOutput, cover.map(makeWord));
    } else if (phase === 'share-style') {
      setRowContent(refs.rows.shareStyle, [makeStyleValue(cycle.style)]);
    } else if (phase === 'share-cover') {
      setRowContent(refs.rows.shareCover, cover.map(makeWord));
    } else if (phase === 'reveal') {
      setRowContent(refs.rows.revealSource, cover.map(makeWord));
      setRowContent(refs.rows.revealStyle,  [makeStyleValue(cycle.style)]);
      setRowContent(refs.rows.revealOutput, SECRET.map(makeBit));
    }
    return { stop() { stopped = true; } };
  }

  async function loop() {
    while (!stopped) {
      if (phase === 'conceal') {
        // Reset, then pulse bits and append words.
        setRowContent(refs.rows.concealSource, SECRET.map(makeBit));
        setRowContent(refs.rows.concealStyle,  [makeStyleValue(cycle.style)]);
        setRowContent(refs.rows.concealOutput, []);
        const bits = refs.rows.concealSource.querySelectorAll('.bf-bit');
        const out  = refs.rows.concealOutput;
        let offset = 0;
        for (const pair of cycle.pairs) {
          if (stopped) return;
          for (let j = 0; j < pair.bits.length; j++) pulse(bits[offset + j]);
          const w = makeWord(pair.word);
          out.appendChild(w);
          pulse(w);
          offset += pair.bits.length;
          await sleep(STEP_MS);
        }
      } else if (phase === 'share-style') {
        const r = refs.rows.shareStyle;
        setRowContent(r, [makeStyleValue(cycle.style)]);
        r.classList.remove('bf-share-active');
        void r.offsetWidth;
        r.classList.add('bf-share-active');
        await sleep(SHARE_MS);
      } else if (phase === 'share-cover') {
        const r = refs.rows.shareCover;
        setRowContent(r, cover.map(makeWord));
        r.classList.remove('bf-share-active');
        void r.offsetWidth;
        r.classList.add('bf-share-active');
        await sleep(SHARE_MS);
      } else if (phase === 'reveal') {
        // Reset, pre-populate source + style (handed from upstream),
        // then pulse cover words and append recovered bits.
        setRowContent(refs.rows.revealSource, cover.map(makeWord));
        setRowContent(refs.rows.revealStyle,  [makeStyleValue(cycle.style)]);
        setRowContent(refs.rows.revealOutput, []);
        const words = refs.rows.revealSource.querySelectorAll('.bf-word');
        const out   = refs.rows.revealOutput;
        for (let i = 0; i < cycle.pairs.length; i++) {
          if (stopped) return;
          if (words[i]) pulse(words[i]);
          for (const c of cycle.pairs[i].bits) {
            const b = makeBit(c);
            out.appendChild(b);
            pulse(b);
          }
          await sleep(STEP_MS);
        }
      }
      if (stopped) return;
      await sleep(HOLD_MS * 2); // longer hold so viewer can read the end state
    }
  }
  loop();
  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

// Narrated 3-phase animation. Conceal / Share / Reveal (no numbers),
// each box carries an explainer caption underneath, and the Reveal
// box stays empty until the Reveal phase fires (no pre-population
// during Share). Used by the splash slideshow's CTA slide. Other
// surfaces use mountNiceTextAnim (4-phase, no narration) or
// mountPhaseAnim (single phase, animated, used by the per-phase
// slides). Returns { stop }.
export function mountNarratedAnim(root, narrationEl, opts = {}) {
  if (!root) throw new Error('mountNarratedAnim: root required');
  // narrationEl is optional; when present, its textContent gets
  // updated as the active phase changes.

  // Cycle state, rotates through CYCLES on each loop pass so the
  // viewer sees the same secret expressed in multiple styles.
  let cycleIdx = opts.cycleIdx ?? 0;
  let cycle = CYCLES[cycleIdx];
  let SECRET = cycle.pairs.flatMap(p => p.bits.split(''));
  let cover  = cycle.pairs.map(p => p.word);
  function advanceCycle() {
    cycleIdx = (cycleIdx + 1) % CYCLES.length;
    cycle  = CYCLES[cycleIdx];
    SECRET = cycle.pairs.flatMap(p => p.bits.split(''));
    cover  = cycle.pairs.map(p => p.word);
  }

  // Build DOM: 3 boxes, each with caption + rows (no per-box
  // explainer: the active phase's explainer text is pushed to the
  // shared narration element).
  root.replaceChildren();
  root.classList.add('bf-pair-narrated');
  const pair = document.createElement('div');
  pair.className = 'bf-pair';

  function row(id, labelText, opts2 = {}) {
    const r = document.createElement('div');
    r.className = 'bf-row';
    if (opts2.styleRow) r.classList.add('bf-row-style');
    if (opts2.share)    r.classList.add('bf-share-row');
    r.id = id;
    const lab = document.createElement('span');
    lab.className = 'bf-row-label';
    lab.textContent = labelText;
    r.appendChild(lab);
    return r;
  }
  function connector(text) {
    const c = document.createElement('div');
    c.className = 'bf-connector';
    c.textContent = text;
    return c;
  }
  function box(id, captionText, children) {
    const b = document.createElement('div');
    b.className = 'bit-flow';
    b.id = id;
    b.setAttribute('aria-hidden', 'true');
    const cap = document.createElement('p');
    cap.className = 'bf-caption';
    cap.textContent = captionText;
    b.appendChild(cap);
    for (const c of children) b.appendChild(c);
    return b;
  }

  const concealBox = box('bf-conceal', 'Conceal', [
    row('bf-conceal-source', 'Secrets or Silliness:'),
    connector('with'),
    row('bf-conceal-style',  'Story Style:', { styleRow: true }),
    connector('to make'),
    row('bf-conceal-output', 'The Cover Story:'),
  ]);

  const shareBox = box('bf-share', 'Share', [
    row('bf-share-style-row', 'Story Style:', { share: true }),
    row('bf-share-cover-row', 'The Cover Story:', { share: true }),
  ]);

  const revealBox = box('bf-reveal', 'Reveal', [
    row('bf-reveal-source', 'The Cover Story:'),
    connector('with'),
    row('bf-reveal-style',  'Story Style:', { styleRow: true }),
    connector('to recover'),
    row('bf-reveal-output', 'Secrets or Silliness:'),
  ]);

  // Per-phase explainer text shown in narrationEl when each phase
  // is active.
  const NARRATION = {
    conceal: 'Conceal turns bits into a cover story.',
    share:   'Share the style. Share the cover.',
    reveal:  'Reveal turns the cover story back into bits.',
  };
  function setNarration(phase) {
    if (!narrationEl) return;
    narrationEl.textContent = phase ? (NARRATION[phase] || '') : '';
  }

  pair.append(concealBox, shareBox, revealBox);
  root.appendChild(pair);

  const refs = {
    conceal: concealBox, share: shareBox, reveal: revealBox,
    rows: {
      concealSource: concealBox.querySelector('#bf-conceal-source'),
      concealStyle:  concealBox.querySelector('#bf-conceal-style'),
      concealOutput: concealBox.querySelector('#bf-conceal-output'),
      shareStyle:    shareBox.querySelector('#bf-share-style-row'),
      shareCover:    shareBox.querySelector('#bf-share-cover-row'),
      revealSource:  revealBox.querySelector('#bf-reveal-source'),
      revealStyle:   revealBox.querySelector('#bf-reveal-style'),
      revealOutput:  revealBox.querySelector('#bf-reveal-output'),
    },
  };

  let stopped = false;
  const timers = new Set();
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });
  function pulse(el) {
    if (!el) return;
    el.classList.add('bf-pulse');
    const t = setTimeout(() => { el.classList.remove('bf-pulse'); timers.delete(t); }, PULSE_MS);
    timers.add(t);
  }

  function setActive(name) {
    for (const [k, el] of Object.entries({ conceal: refs.conceal, share: refs.share, reveal: refs.reveal })) {
      const on = k === name;
      el.classList.toggle('bf-active', on);
      el.querySelector('.bf-caption')?.classList.toggle('bf-active', on);
    }
    setNarration(name);
  }

  function resetAll() {
    setRowContent(refs.rows.concealSource, SECRET.map(makeBit));
    setRowContent(refs.rows.concealStyle,  [makeStyleValue(cycle.style)]);
    setRowContent(refs.rows.concealOutput, []);
    setRowContent(refs.rows.shareStyle,    []);
    setRowContent(refs.rows.shareCover,    []);
    refs.rows.shareStyle.classList.remove('bf-share-active');
    refs.rows.shareCover.classList.remove('bf-share-active');
    setRowContent(refs.rows.revealSource,  []);
    setRowContent(refs.rows.revealStyle,   []);
    setRowContent(refs.rows.revealOutput,  []);
    setActive(null);
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    resetAll();
    setRowContent(refs.rows.concealOutput, cover.map(makeWord));
    setRowContent(refs.rows.shareStyle, [makeStyleValue(cycle.style)]);
    setRowContent(refs.rows.shareCover, cover.map(makeWord));
    setRowContent(refs.rows.revealSource, cover.map(makeWord));
    setRowContent(refs.rows.revealStyle,  [makeStyleValue(cycle.style)]);
    setRowContent(refs.rows.revealOutput, SECRET.map(makeBit));
    setActive('reveal');
    return { stop() { stopped = true; } };
  }

  async function loop() {
    while (!stopped) {
      resetAll();
      // Conceal: pulse bits, append words.
      setActive('conceal');
      {
        const bits = refs.rows.concealSource.querySelectorAll('.bf-bit');
        const out = refs.rows.concealOutput;
        let offset = 0;
        for (const pair of cycle.pairs) {
          if (stopped) return;
          for (let j = 0; j < pair.bits.length; j++) pulse(bits[offset + j]);
          const w = makeWord(pair.word);
          out.appendChild(w);
          pulse(w);
          offset += pair.bits.length;
          await sleep(STEP_MS);
        }
      }
      await sleep(HOLD_MS); if (stopped) return;

      // Share: populate share rows ONLY (no pre-fill of reveal rows),
      // trigger the traverse animation on both simultaneously.
      setActive('share');
      setRowContent(refs.rows.shareStyle, [makeStyleValue(cycle.style)]);
      setRowContent(refs.rows.shareCover, cover.map(makeWord));
      refs.rows.shareStyle.classList.remove('bf-share-active');
      refs.rows.shareCover.classList.remove('bf-share-active');
      void refs.rows.shareStyle.offsetWidth;
      void refs.rows.shareCover.offsetWidth;
      refs.rows.shareStyle.classList.add('bf-share-active');
      refs.rows.shareCover.classList.add('bf-share-active');
      await sleep(SHARE_MS); if (stopped) return;
      await sleep(HOLD_MS);  if (stopped) return;

      // Reveal: NOW populate reveal-source + reveal-style (they were
      // empty during Share so the Reveal box reads as "received here"
      // not "pre-staged"). Then pulse words and append bits.
      setActive('reveal');
      setRowContent(refs.rows.revealSource, cover.map(makeWord));
      setRowContent(refs.rows.revealStyle,  [makeStyleValue(cycle.style)]);
      setRowContent(refs.rows.revealOutput, []);
      {
        const words = refs.rows.revealSource.querySelectorAll('.bf-word');
        const out = refs.rows.revealOutput;
        for (let i = 0; i < cycle.pairs.length; i++) {
          if (stopped) return;
          if (words[i]) pulse(words[i]);
          for (const c of cycle.pairs[i].bits) {
            const b = makeBit(c);
            out.appendChild(b);
            pulse(b);
          }
          await sleep(STEP_MS);
        }
      }
      setActive(null);
      await sleep(HOLD_MS * 2);
      advanceCycle(); // rotate to next style for the next pass
    }
  }
  loop();
  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

// Static (no-animation) renderer for a single phase box. Builds the
// full bf-pair-staged scaffold and marks the requested phase active
// with its end-state content filled in. Used by the slideshow's per-
// phase NiceText slides where the bit-flow visual is reused without
// the cycling animation.
//
// phase: 'conceal' | 'share-style' | 'share-cover' | 'reveal'
// opts.cycleIdx: which CYCLES entry to use (defaults to 0)
export function mountStaticPhase(root, phase, opts = {}) {
  if (!root) throw new Error('mountStaticPhase: root required');
  const cycleIdx = opts.cycleIdx ?? 0;
  const cycle = CYCLES[cycleIdx];
  const SECRET = cycle.pairs.flatMap(p => p.bits.split(''));
  const cover = cycle.pairs.map(p => p.word);

  const refs = buildDom(root);
  // Stage class hides non-active phase boxes (CSS rule in
  // slideshow.css). Only mountStaticPhase opts in; the animated
  // mount keeps all 4 boxes visible per the original design.
  root.classList.add('bf-pair-staged');

  const boxMap = {
    'conceal':     refs.conceal,
    'share-style': refs.shareStyle,
    'share-cover': refs.shareCover,
    'reveal':      refs.reveal,
  };
  const box = boxMap[phase];
  if (!box) throw new Error(`mountStaticPhase: unknown phase ${phase}`);
  box.classList.add('bf-active');
  box.querySelector('.bf-caption')?.classList.add('bf-active');

  if (phase === 'conceal') {
    setRowContent(refs.rows.concealSource, SECRET.map(makeBit));
    setRowContent(refs.rows.concealStyle,  [makeStyleValue(cycle.style)]);
    setRowContent(refs.rows.concealOutput, cover.map(makeWord));
  } else if (phase === 'share-style') {
    setRowContent(refs.rows.shareStyle, [makeStyleValue(cycle.style)]);
  } else if (phase === 'share-cover') {
    setRowContent(refs.rows.shareCover, cover.map(makeWord));
  } else if (phase === 'reveal') {
    setRowContent(refs.rows.revealSource, cover.map(makeWord));
    setRowContent(refs.rows.revealStyle,  [makeStyleValue(cycle.style)]);
    setRowContent(refs.rows.revealOutput, SECRET.map(makeBit));
  }
}
