/* Matrix digital rain, canvas-based effect for hacker mode.
 *
 * Adapted from the Span-It! project
 * (https://piethrower.github.io/spanit, file: js/matrix-rain.js).
 * Differences: no auto-DOM-observer (js/theme.js drives start/stop
 * explicitly when html.hacker flips); pause/resume on tab visibility
 * to save battery on phones; canvas sits at z-index -1 behind body
 * content, panels/dialogs render their own opaque backgrounds so rain
 * only shows in margins and gaps.
 *
 * Exposes window.MatrixRain with start(), stop(). Idempotent: calling
 * start() while already running is a no-op; same for stop() while
 * already stopped.
 */

window.MatrixRain = (function () {
  'use strict';

  // Half-width katakana + digits + symbols. Same set Span-It! uses.
  const CHARS = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFZ<>*+=-';

  let canvas = null;
  let ctx = null;
  let columns = [];
  let animId = null;
  let paused = false;
  const fontSize = 28;
  let colWidth = fontSize;
  let numCols = 0;

  function randomChar() { return CHARS[Math.floor(Math.random() * CHARS.length)]; }

  function initColumn() {
    return {
      y: -Math.floor(Math.random() * 40),
      speed: 0.029 + Math.random() * 0.052,
      streamLen: 8 + Math.floor(Math.random() * 14),
      chars: [],
      prevHeadRow: null,
    };
  }

  function resize() {
    if (!canvas) return;
    // HiDPI: backing store in device pixels, CSS box in CSS pixels.
    // Without this the browser bilinear-upscales the canvas on
    // retina/4K displays and the rain reads as blurry.
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    numCols = Math.floor(cssW / colWidth);
    while (columns.length < numCols) columns.push(initColumn());
    columns.length = numCols;
  }

  function draw() {
    if (paused || !ctx) { animId = null; return; }

    // Soft black-fade for residual afterglow behind the explicitly
    // drawn trail. ctx is scaled by dpr, so we fill in CSS pixel space
    // (window.innerWidth / .innerHeight), not the device-pixel
    // canvas.width / .height.
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.font = 'bold ' + fontSize + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const maxRows = Math.ceil(cssH / fontSize) + 2;

    // Mirror glyphs left-to-right so the half-width katakana read as
    // they do in The Matrix (the film's prop department scanned a
    // sushi cookbook and flipped the characters; nominally we're
    // looking out through the back of the monitor). Wraps the
    // per-column loop only; the full-canvas black fade above is
    // symmetric so it doesn't matter which side of the transform
    // it lands on.
    ctx.save();
    ctx.scale(-1, 1);

    for (let i = 0; i < numCols; i++) {
      const col = columns[i];
      col.y += col.speed;
      const headRow = Math.floor(col.y);

      // Advance: when integer head row changes, unshift fresh chars
      // for each newly-uncovered row and trim to streamLen.
      if (col.prevHeadRow === null) {
        col.chars.unshift(randomChar());
        col.prevHeadRow = headRow;
      } else if (headRow > col.prevHeadRow) {
        const advance = headRow - col.prevHeadRow;
        for (let k = 0; k < advance; k++) col.chars.unshift(randomChar());
        if (col.chars.length > col.streamLen) col.chars.length = col.streamLen;
        col.prevHeadRow = headRow;
      }

      // Occasional in-trail glyph mutation for the scrambling look.
      if (col.chars.length > 2 && Math.random() < 0.12) {
        const idx = 1 + Math.floor(Math.random() * (col.chars.length - 1));
        col.chars[idx] = randomChar();
      }

      const x = i * colWidth + colWidth / 2;

      // Trail: draw back-to-front so head paints on top. Brightness
      // ramps from ~0.9 just behind the head down to ~0.13 at tail.
      for (let k = col.chars.length - 1; k >= 1; k--) {
        const row = headRow - k;
        if (row < 0 || row >= maxRows) continue;
        const age = k / col.streamLen;
        const alpha = Math.max(0.15, 1 - age) * 0.9;
        ctx.fillStyle = 'rgba(0, 255, 90, ' + alpha + ')';
        ctx.fillText(col.chars[k], -x, row * fontSize);
      }

      // Head: near-solid white-green with glow.
      if (headRow >= 0 && headRow < maxRows && col.chars.length > 0) {
        ctx.shadowColor = 'rgba(120, 255, 140, 0.9)';
        ctx.shadowBlur = 14;
        ctx.fillStyle = 'rgba(220, 255, 230, 1.0)';
        ctx.fillText(col.chars[0], -x, headRow * fontSize);
        ctx.shadowBlur = 0;
      }

      if (headRow - col.streamLen > maxRows) {
        columns[i] = initColumn();
        columns[i].y = -Math.floor(Math.random() * 15);
      }
    }

    ctx.restore();

    animId = requestAnimationFrame(draw);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      paused = true;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
    } else if (canvas) {
      paused = false;
      if (!animId) animId = requestAnimationFrame(draw);
    }
  }

  function start() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'matrix-rain-canvas';
    canvas.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    paused = false;
    columns = [];
    resize();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Honour an already-hidden tab: don't start the rAF loop until
    // the tab becomes visible. visibilitychange will resume.
    if (document.hidden) {
      paused = true;
    } else {
      animId = requestAnimationFrame(draw);
    }
  }

  function stop() {
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    ctx = null;
    columns = [];
    paused = false;
  }

  return { start, stop };
})();
