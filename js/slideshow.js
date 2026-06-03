// Self-contained slideshow component. Mounts into a target element,
// sizes to its parent container, auto-advances through a list of
// slides, with rw / play-pause / ff transport in the footer, and
// infinite loop. No assumptions about the surrounding page layout
// (navbar, viewport, etc.), every dimension and breakpoint
// resolves via CSS container queries against the mount element.
//
// Usage:
//   import { Slideshow } from './slideshow.js';
//   const slides = [
//     { id: 'intro', durationMs: 6000, render: (root) => { ... } },
//     ...
//   ];
//   new Slideshow(document.getElementById('slideshow-mount'), slides).start();
//
// Slide shape: { id, mode, durationMs, render(root) }
//   - id: stable string used as a DOM hook + debug label
//   - mode: CSS class suffix that picks the stage's grid template
//   - durationMs: how long this slide holds before auto-advance
//   - render(root): paints the slide content into the provided
//     stage element. Called fresh on every entry; previous content
//     wiped first. If render returns a function, that function is
//     called when the slide leaves (cleanup hook).
//
// Behavior:
//   - Stage A and stage B trade visibility on each transition so
//     the leaving slide can crossfade with the entering one.
//   - rw / play-pause / ff transport in the footer steps the
//     slideshow and pauses auto-advance until play is tapped again.

export class Slideshow {
  constructor(mountEl, slides, opts = {}) {
    if (!mountEl) throw new Error('Slideshow: mount element is required');
    if (!Array.isArray(slides) || slides.length === 0) {
      throw new Error('Slideshow: at least one slide is required');
    }
    this.mount = mountEl;
    this.slides = slides;
    this.loop = opts.loop !== false;
    this.idx = -1;
    this._timer = null;
    this._paused = false;
    this._buildShell();
    this._activeStage = this.stageA;
    this._idleStage = this.stageB;
  }

  _buildShell() {
    this.mount.classList.add('slideshow-root');
    this.mount.replaceChildren();

    // Outer grid layout: header (chapter + narration + fullscreen)
    // at the top, body (stages) in the middle, footer (transport +
    // counter) at the bottom. Mode-specific grid templates apply INSIDE each
    // stage; the outer chrome (chapter / fullscreen / footer) sits
    // in its own grid cells, not absolute-positioned overlays.
    this.header = document.createElement('div');
    this.header.className = 'slideshow-header';

    this.chapterEl = document.createElement('div');
    this.chapterEl.className = 'slideshow-chapter';

    this.narrationEl = document.createElement('div');
    this.narrationEl.className = 'slideshow-narration';

    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.type = 'button';
    this.fullscreenBtn.className = 'slideshow-fullscreen-btn';
    this.fullscreenBtn.setAttribute('aria-label', 'Open slideshow full screen');
    this.fullscreenBtn.textContent = '⛶'; // ⛶ square-four-corners (expand)
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFullscreen();
    });

    this.header.append(this.chapterEl, this.narrationEl, this.fullscreenBtn);

    this.body = document.createElement('div');
    this.body.className = 'slideshow-body';

    this.stageA = document.createElement('div');
    this.stageA.className = 'slideshow-stage slideshow-stage-active';
    this.stageA.setAttribute('aria-live', 'polite');

    this.stageB = document.createElement('div');
    this.stageB.className = 'slideshow-stage';
    this.stageB.setAttribute('aria-hidden', 'true');

    this.body.append(this.stageA, this.stageB);

    this.footer = document.createElement('div');
    this.footer.className = 'slideshow-footer';

    this.prevBtn = document.createElement('button');
    this.prevBtn.type = 'button';
    this.prevBtn.className = 'slideshow-step slideshow-step-prev';
    this.prevBtn.setAttribute('aria-label', 'Previous slide');
    this.prevBtn.textContent = '⏮';
    this.prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prev();
    });

    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'slideshow-play';
    this.playBtn.setAttribute('aria-label', 'Pause slideshow');
    this.playBtn.textContent = '❚❚'; // ❚❚ (pause glyph)
    this.playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePause();
    });

    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'slideshow-step slideshow-step-next';
    this.nextBtn.setAttribute('aria-label', 'Next slide');
    this.nextBtn.textContent = '⏭';
    this.nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.next();
    });

    // Center group: transport (rw / play / ff). The footer's 3-col
    // grid (spacer | controls | counter) keeps this group visually
    // centered while the counter sits in the right column.
    this.controls = document.createElement('div');
    this.controls.className = 'slideshow-controls';
    this.controls.append(this.prevBtn, this.playBtn, this.nextBtn);

    this.counterEl = document.createElement('div');
    this.counterEl.className = 'slideshow-counter';
    this.counterEl.setAttribute('aria-hidden', 'true');

    this.footer.append(this.controls, this.counterEl);

    this.mount.append(this.header, this.body, this.footer);

    this._onEscKey = (e) => {
      if (e.key === 'Escape' && this._fullscreen) this.exitFullscreen();
    };
  }

  start() { this.show(0); }

  next() {
    let n = this.idx + 1;
    if (n >= this.slides.length) {
      if (!this.loop) return;
      n = 0;
    }
    this.show(n);
  }

  // Step backward one slide. Never wraps, regardless of `loop`,
  // the rw button is for explicit stepping, and slide-1 rw is
  // disabled in the UI.
  prev() {
    if (this.idx <= 0) return;
    this.show(this.idx - 1);
  }

  show(i) {
    if (i < 0 || i >= this.slides.length) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    this.idx = i;
    const slide = this.slides[i];

    // Render into the idle stage, then swap active/idle so the
    // crossfade lands on the freshly-painted content. If render
    // returns a function, retain it as the leave-time cleanup.
    this._idleStage.replaceChildren();
    this._idleStage.dataset.slideId = slide.id;
    // Each slide picks a mode (CSS class) that controls the stage's
    // grid template. Defaults to "transit" if unspecified.
    this._idleStage.className = `slideshow-stage mode-${slide.mode || 'transit'}`;
    // Chapter title lives in the mount's header (above stages) so
    // it doesn't get torn down per slide and doesn't compete for
    // grid cells inside the stage. Renders as <a> when chapterHref
    // is set, otherwise plain text.
    this.chapterEl.replaceChildren();
    if (slide.chapter) {
      let el;
      if (slide.chapterHref) {
        el = document.createElement('a');
        el.href = slide.chapterHref;
        el.className = 'scene-chapter scene-chapter-link';
      } else {
        el = document.createElement('p');
        el.className = 'scene-chapter';
      }
      el.textContent = slide.chapter;
      this.chapterEl.appendChild(el);
    }

    // Narration text is reset per slide; slides that drive it
    // dynamically (e.g. CTA's mountNarratedAnim) call slideshow.
    // narrationEl directly.
    this.narrationEl.textContent = '';

    let cleanup = null;
    try { cleanup = slide.render(this._idleStage, this); }
    catch (err) { console.error('slideshow render error', slide.id, err); }
    if (typeof cleanup === 'function') this._idleStage._slideCleanup = cleanup;

    // Swap stages. Fire the leaving slide's cleanup (if any) before
    // the crossfade.
    const prev = this._activeStage;
    if (typeof prev._slideCleanup === 'function') {
      try { prev._slideCleanup(); } catch (err) { console.error('slide cleanup error', err); }
      prev._slideCleanup = null;
    }
    const next = this._idleStage;
    next.classList.add('slideshow-stage-active');
    next.removeAttribute('aria-hidden');
    prev.classList.remove('slideshow-stage-active');
    prev.setAttribute('aria-hidden', 'true');
    this._activeStage = next;
    this._idleStage = prev;

    // Slide counter (right footer cell). Plain "n / total" so the
    // developer can reference slides by number.
    this.counterEl.textContent = `${i + 1} / ${this.slides.length}`;

    // rw/ff enabled state. rw off at slide 1; ff off at last slide
    // when looping is disabled (matches next()'s no-wrap behavior).
    this.prevBtn.disabled = (i <= 0);
    this.nextBtn.disabled = (i >= this.slides.length - 1) && !this.loop;

    // Schedule the next advance unless paused.
    if (!this._paused) {
      const ms = Math.max(1500, slide.durationMs || 6000);
      this._timer = setTimeout(() => { this._timer = null; this.next(); }, ms);
    }
  }

  pause() {
    if (this._paused) return;
    this._paused = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.playBtn.textContent = '▶'; // ▶ play glyph
    this.playBtn.setAttribute('aria-label', 'Resume slideshow');
    this.mount.classList.add('slideshow-paused');
  }

  play() {
    if (!this._paused) return;
    this._paused = false;
    this.playBtn.textContent = '❚❚'; // ❚❚ pause glyph
    this.playBtn.setAttribute('aria-label', 'Pause slideshow');
    this.mount.classList.remove('slideshow-paused');
    // Re-arm timer for the current slide's duration so the user
    // gets the whole slide to read after resuming.
    const slide = this.slides[this.idx];
    if (!slide) return;
    const ms = Math.max(1500, slide.durationMs || 6000);
    this._timer = setTimeout(() => { this._timer = null; this.next(); }, ms);
  }

  togglePause() {
    if (this._paused) this.play();
    else this.pause();
  }

  enterFullscreen() {
    if (this._fullscreen) return;
    this._fullscreen = true;
    this.mount.classList.add('slideshow-fullscreen');
    document.body.classList.add('slideshow-body-lock');
    this.fullscreenBtn.textContent = '✕';
    this.fullscreenBtn.setAttribute('aria-label', 'Exit full screen');
    document.addEventListener('keydown', this._onEscKey);
  }

  exitFullscreen() {
    if (!this._fullscreen) return;
    this._fullscreen = false;
    this.mount.classList.remove('slideshow-fullscreen');
    document.body.classList.remove('slideshow-body-lock');
    this.fullscreenBtn.textContent = '⛶';
    this.fullscreenBtn.setAttribute('aria-label', 'Open slideshow full screen');
    document.removeEventListener('keydown', this._onEscKey);
  }

  toggleFullscreen() {
    if (this._fullscreen) this.exitFullscreen();
    else this.enterFullscreen();
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}
