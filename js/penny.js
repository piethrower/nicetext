// Penny. Minimal tutorial guide character. Inspired by the Penny in
// the Span-It! project (https://piethrower.github.io/spanit) but
// written fresh: one speech bubble, one character image, a Next
// button to advance. Free-flow narration: no gating, no validation.
//
// Trusted Types: nicetext.html ships with `require-trusted-types-for
// 'script'`, so any innerHTML assignment must go through a registered
// TrustedTypePolicy. The tutorial steps are hand-authored HTML
// fragments (controlled by us, never sourced from outside), so a
// passthrough policy is appropriate. ROE rule 26 sanctions hard-coded
// markup; the policy lives only in this module so a future regression
// elsewhere still throws.

const __pennyTrust = (typeof window !== 'undefined' && window.trustedTypes)
  ? window.trustedTypes.createPolicy('penny-tutorial', { createHTML: (s) => s })
  : { createHTML: (s) => s };
//
// Usage:
//   import { Penny } from './penny.js';
//   const steps = [
//     { narrative: '<p>Hi! ... <button class="penny-next">Next</button></p>' },
//     { narrative: '<p>Nice. <button class="penny-next">Next</button></p>' },
//   ];
//   new Penny(document.getElementById('penny-anchor'), steps).start();
//
// Step shape: { narrative: htmlString }
//   - The narrative HTML may contain a <button class="penny-next"> to
//     advance, and/or a <button class="penny-skip"> to dismiss the
//     whole tutorial. Click handlers are wired automatically.
//
// Bubble behavior:
//   - Word-by-word typewriter reveal of each step. Clicking Next or
//     anywhere outside the buttons reveals the rest immediately.
//   - Bubble height is capped to its container; if content overflows
//     it scrolls internally with a thin scrollbar. A snap-to-line
//     pass trims the cap to a whole-line boundary so partial lines
//     don't peek above the scroll-thumb.
//   - .penny-has-overflow class is toggled when there's content
//     below the fold; CSS uses it to show a "scroll for more" hint.

export class Penny {
  constructor(anchorEl, steps, opts = {}) {
    this.anchor = anchorEl;
    this.steps = steps;
    this.onComplete = opts.onComplete || (() => {});
    this.imageSrc = opts.imageSrc || 'img/penny.svg';
    this.idx = -1;
    this._timers = [];
    this._scrollListener = null;
    this._build();
  }

  _build() {
    this.anchor.classList.add('penny-anchor');
    this.anchor.classList.remove('penny-hidden');
    this.anchor.replaceChildren();

    // Wrap the bubble + tail so the tail's `bottom` anchors to the
    // bubble's bottom (the wrap's height = the bubble's height) rather
    // than the anchor's bottom (which extends down to where the figure
    // sits). The tail is a sibling of .penny-bubble inside the wrap
    // so the bubble's overflow-y: auto can't clip it (which would
    // happen if it were a pseudo-element on .penny-bubble, per CSS
    // spec, overflow-y: auto forces overflow-x to clip).
    this.bubbleWrap = document.createElement('div');
    this.bubbleWrap.className = 'penny-bubble-wrap';

    this.bubble = document.createElement('div');
    this.bubble.className = 'penny-bubble';
    this.bubbleWrap.appendChild(this.bubble);

    // In-bubble close button. Sits at the bubble's top-right corner
    // and triggers the navbar's tutorial toggle, which is the single
    // source of truth for open/close (tutorial-script.js's
    // setCollapsed flips the dock).
    this.bubbleClose = document.createElement('button');
    this.bubbleClose.type = 'button';
    this.bubbleClose.className = 'penny-bubble-close';
    this.bubbleClose.setAttribute('aria-label', 'Close tutorial');
    this.bubbleClose.textContent = '×';
    this.bubbleClose.addEventListener('click', () => {
      const tutorialToggle = document.getElementById('topbar-tutorial-toggle');
      if (tutorialToggle) tutorialToggle.click();
    });
    this.bubbleWrap.appendChild(this.bubbleClose);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    this.bubbleTail = document.createElementNS(SVG_NS, 'svg');
    this.bubbleTail.setAttribute('class', 'penny-bubble-tail');
    this.bubbleTail.setAttribute('viewBox', '0 0 12 18');
    this.bubbleTail.setAttribute('aria-hidden', 'true');
    this.bubbleTail.setAttribute('focusable', 'false');
    const tailPath = document.createElementNS(SVG_NS, 'path');
    // Path is open on the left so only the slanted edges get stroked,
    // the visible result is the bubble's right border continuing
    // into the triangle.
    tailPath.setAttribute('d', 'M0 1 L11 9 L0 17');
    // fill + stroke routed through CSS vars so the tail tracks the
    // bubble's surface bg and accent border across light/dark/hacker.
    tailPath.setAttribute('stroke-width', '2');
    tailPath.setAttribute('stroke-linejoin', 'miter');
    this.bubbleTail.appendChild(tailPath);
    this.bubbleWrap.appendChild(this.bubbleTail);

    this.figure = document.createElement('div');
    this.figure.className = 'penny-figure';
    const img = document.createElement('img');
    img.alt = 'Penny, your tutorial guide';
    img.style.visibility = 'hidden';
    img.addEventListener('load', () => { img.style.visibility = ''; });
    img.src = this.imageSrc;
    if (img.complete) img.style.visibility = '';
    this.figure.appendChild(img);

    this.anchor.appendChild(this.bubbleWrap);
    this.anchor.appendChild(this.figure);

    // Delegate button clicks inside the bubble. A click anywhere else
    // in the bubble (other than next/skip) skips the typewriter to
    // the end of the current step.
    this.bubble.addEventListener('click', (e) => {
      if (e.target.closest('.penny-next')) this.next();
      else if (e.target.closest('.penny-skip')) this.dismiss();
      else this._revealAll();
    });

    // Refresh overflow state on resize so the scroll hint accurately
    // reflects whether the bubble can show more.
    window.addEventListener('resize', () => this._updateOverflow());
  }

  start() { this.runStep(0); }

  runStep(i) {
    if (i < 0 || i >= this.steps.length) {
      this.dismiss();
      return;
    }
    this.idx = i;
    this._cancelTimers();
    const step = this.steps[i];
    this.bubble.innerHTML = __pennyTrust.createHTML(step.narrative || '');
    // Restart slide-in animation.
    this.bubble.style.animation = 'none';
    void this.bubble.offsetWidth;
    this.bubble.style.animation = '';
    this.bubble.scrollTop = 0;

    // Defer one frame so layout has settled before the typewriter
    // measures and reveals; otherwise the snap-to-line pass uses
    // stale dimensions.
    requestAnimationFrame(() => {
      this._snapBubbleHeight();
      this._typewriterReveal(this.bubble);
      this._updateOverflow();
    });
  }

  next() { this.runStep(this.idx + 1); }

  dismiss() {
    this._cancelTimers();
    this.anchor.classList.add('penny-hidden');
    setTimeout(() => { this.anchor.replaceChildren(); }, 250);
    this.onComplete();
  }

  // ── Typewriter reveal engine ───────────────────────────────────
  // Wraps every text word in a <span class="penny-tw"> hidden via
  // visibility:hidden, then reveals them one at a time on a timer.
  // Buttons inside the narrative are also hidden until reveal time so
  // they appear with the rest of their sentence. visibility:hidden
  // preserves layout space, so the bubble doesn't resize during reveal.

  _typewriterReveal(container) {
    const units = []; // ordered list of elements to reveal

    const wrapTextNodes = (el) => {
      const childNodes = Array.from(el.childNodes);
      for (const node of childNodes) {
        if (node.nodeType === 3) {
          const text = node.textContent;
          if (!text.trim()) continue;
          const words = text.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          for (const w of words) {
            if (!w) continue;
            if (/^\s+$/.test(w)) {
              frag.appendChild(document.createTextNode(w));
            } else {
              const span = document.createElement('span');
              span.className = 'penny-tw';
              span.textContent = w;
              span.style.visibility = 'hidden';
              frag.appendChild(span);
              units.push(span);
            }
          }
          el.replaceChild(frag, node);
        } else if (node.nodeType === 1) {
          const tag = node.tagName.toLowerCase();
          if (tag === 'button' || tag === 'a' || tag === 'input') {
            node.style.visibility = 'hidden';
            units.push(node);
          } else {
            wrapTextNodes(node);
          }
        }
      }
    };
    wrapTextNodes(container);

    if (units.length === 0) return;

    let idx = 0;
    const baseDelay = 35;

    const revealNext = () => {
      if (idx >= units.length) return;
      const el = units[idx];
      el.style.visibility = 'visible';
      idx++;
      this._updateOverflow();
      // Pause after sentence-ending punctuation so the reveal feels
      // like speech rather than a constant-rate ticker.
      const text = el.textContent || '';
      let delay = baseDelay;
      if (/[.!?]$/.test(text))      delay = 220;
      else if (/[,;:]$/.test(text)) delay = 110;
      else if (/…$/.test(text))     delay = 200;
      const tid = setTimeout(revealNext, delay);
      this._timers.push(tid);
    };
    const tid = setTimeout(revealNext, 120);
    this._timers.push(tid);
  }

  _revealAll() {
    if (!this.bubble) return;
    this._cancelTimers();
    const hidden = this.bubble.querySelectorAll('[style*="visibility"]');
    for (const el of hidden) el.style.visibility = 'visible';
    this._updateOverflow();
  }

  _cancelTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  // ── Bubble sizing ─────────────────────────────────────────────────
  // CSS sets max-height to the available dock space. When the
  // content overflows that cap, snap the height to a whole-line
  // boundary so the visible region ends at a complete line.

  _snapBubbleHeight() {
    if (!this.bubble) return;
    this.bubble.style.maxHeight = ''; // reset to CSS-defined cap
    const cs = window.getComputedStyle(this.bubble);
    if (cs.maxHeight === 'none') return;

    const lineH = parseFloat(cs.lineHeight);
    if (!lineH || isNaN(lineH)) return;

    if (this.bubble.scrollHeight <= this.bubble.clientHeight) return; // fits

    const padTop = parseFloat(cs.paddingTop);
    const padBot = parseFloat(cs.paddingBottom);
    const padding = padTop + padBot;
    const contentH = this.bubble.clientHeight - padding;
    const snapped = Math.floor(contentH / lineH) * lineH;
    this.bubble.style.maxHeight = (snapped + padding) + 'px';
  }

  _updateOverflow() {
    if (!this.bubble) return;
    const threshold = 8;
    const has =
      this.bubble.scrollHeight > this.bubble.clientHeight &&
      (this.bubble.scrollTop + this.bubble.clientHeight) <
        (this.bubble.scrollHeight - threshold);
    this.bubble.classList.toggle('penny-has-overflow', has);

    if (!this._scrollListener) {
      this._scrollListener = () => this._updateOverflow();
      this.bubble.addEventListener('scroll', this._scrollListener);
    }
  }
}
