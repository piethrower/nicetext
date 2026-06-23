// sab-mode-badge.js: makes the runtime's SharedArrayBuffer decision
// visible, so you can confirm — at a glance, in the console, and from
// tests — whether a page is on the shared (SAB) path or the ArrayBuffer
// copy fallback. Loaded on the pages that run the engine (nicetext.html,
// the browser test, the stress test).
//
// One source of truth (sabUsable() in src/sab-support.js), three
// surfaces:
//   - a small fixed badge in the page corner,
//   - a console line on load,
//   - globalThis.__niceTextBufferMode ('shared' | 'copy'), for test
//     assertions and quick console checks.
//
// CSP note: the badge's styles are applied via the CSSOM
// (element.style.<prop> = ...), NOT a `style="..."` attribute, so the
// pages' strict `style-src 'self'` policy (no 'unsafe-inline') does not
// block them. Text is set via textContent, so `require-trusted-types-
// for 'script'` is satisfied too.

import { bufferMode } from './src/sab-support.js';

const mode = bufferMode();          // 'shared' | 'copy'
const isShared = mode === 'shared';

// Expose for tests and ad-hoc console checks (e.g. `__niceTextBufferMode`).
globalThis.__niceTextBufferMode = mode;

console.info(
  `[nicetext] buffer mode: ${isShared ? 'SHARED (SharedArrayBuffer)' : 'COPY (ArrayBuffer fallback)'}`
  + ` — crossOriginIsolated=${globalThis.crossOriginIsolated === true}`
);

// The badge is a transient peek, not page chrome: it fades in on load,
// fades out after a few seconds, and can be summoned back by hovering the
// NiceText logo. VISIBLE_OPACITY is the shown state; FADE_MS is the
// in/out transition; LINGER_MS is how long it stays before auto-hiding.
const VISIBLE_OPACITY = '0.85';
const FADE_MS = 250;
const LINGER_MS = 4000;

let badgeEl = null;
let hideTimer = null;

function showBadge() {
  if (!badgeEl) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  badgeEl.style.opacity = VISIBLE_OPACITY;
  hideTimer = setTimeout(hideBadge, LINGER_MS);
}

function hideBadge() {
  if (!badgeEl) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  badgeEl.style.opacity = '0';
}

function mountBadge() {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('sab-mode-badge')) return;

  const el = document.createElement('div');
  el.id = 'sab-mode-badge';
  el.dataset.mode = mode;                       // test hook: dataset.mode
  el.textContent = isShared ? 'Shared Memory: On' : 'Shared Memory: Off';
  el.title = isShared
    ? 'Shared memory is on (page is cross-origin isolated).'
    : 'Shared memory is off (page is not cross-origin isolated). Full functionality, just more memory.';

  const s = el.style;
  s.position = 'fixed';
  s.bottom = '8px';
  s.left = '8px';
  s.zIndex = '2147483647';
  s.font = '600 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  s.letterSpacing = '0.08em';
  s.padding = '3px 7px';
  s.borderRadius = '4px';
  s.color = '#fff';
  s.background = isShared ? '#1f7a33' : '#a85b00';   // green = shared, amber = fallback
  s.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.35)';
  s.userSelect = 'none';
  s.pointerEvents = 'none';                     // purely informational, never interactive
  s.transition = `opacity ${FADE_MS}ms ease`;
  s.opacity = '0';                              // start hidden, then fade in

  document.body.appendChild(el);
  badgeEl = el;

  // Summon the badge back by hovering the NiceText logo/wordmark, present
  // in the topbar of every page that runs the engine.
  const logo = document.querySelector('.home-link');
  if (logo) logo.addEventListener('mouseenter', showBadge);

  // Fade in on the next frame so the opacity transition actually runs
  // (setting 0 -> visible in the same frame would skip the animation),
  // then let showBadge() arm the auto-hide.
  requestAnimationFrame(showBadge);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBadge, { once: true });
  } else {
    mountBadge();
  }
}
