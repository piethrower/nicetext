// Theme controller. Three states: light, dark, hacker.
//
// Phases:
// (1) Synchronous on script load (in <head> before <body> parses): read
//     the session cookie or fall back to OS color-scheme preference,
//     apply the chosen class on <html> so the page paints in the
//     chosen mode without flash.
// (2) DOMContentLoaded: wire up #theme-toggle. Single click cycles
//     light vs dark (or exits hacker back to whichever of light/dark
//     was active before discovery, stashed in nicetext-theme-prev).
//     Triple-tap of the toggle within HACKER_TRIGGER_MS enters hacker.
// (3) On hacker enter, MatrixRain.start() (matrix-rain.js loads
//     alongside this file). On hacker exit, MatrixRain.stop(). On
//     hacker enter, also walk every [data-hacker-text] node and swap
//     textContent to the attribute value, stashing the original; on
//     exit, restore from the stash.
//
// Cookie semantics: name "nicetext-theme", values "dark" | "light" |
// "hacker", session cookie. Companion key "nicetext-theme-prev"
// carries the pre-hacker state so a single toggle click while in
// hacker mode goes back to where the developer was before. path=/,
// SameSite=Lax.
//
// Rule 27 note: a UI preference is not a secret. Theme + theme-prev
// are the only persistence touches; secrets and covers stay in
// memory.

const COOKIE_NAME = 'nicetext-theme';
const COOKIE_PREV = 'nicetext-theme-prev';
const HACKER_TRIGGER_MS = 2000;
const HACKER_TRIGGER_CLICKS = 3;

function readCookie(name) {
  for (const part of document.cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}

function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax`;
}

function isThemeName(s) { return s === 'light' || s === 'dark' || s === 'hacker'; }

function resolveInitialTheme() {
  const saved = readCookie(COOKIE_NAME);
  if (isThemeName(saved)) return saved;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('hacker', theme === 'hacker');
}

// Phase 1: apply theme immediately so paint matches.
applyTheme(resolveInitialTheme());

// Hacker text-swap. Walks every [data-hacker-text] element. On enter,
// stashes original textContent on data-hacker-text-original and
// substitutes the attribute value; on exit, restores from the stash.
// Idempotent.
function applyHackerCopy(on) {
  const nodes = document.querySelectorAll('[data-hacker-text]');
  for (const el of nodes) {
    if (on) {
      if (el.dataset.hackerTextOriginal === undefined) {
        el.dataset.hackerTextOriginal = el.textContent;
      }
      el.textContent = el.dataset.hackerText;
    } else if (el.dataset.hackerTextOriginal !== undefined) {
      el.textContent = el.dataset.hackerTextOriginal;
    }
  }
}

// Matrix rain. js/matrix-rain.js loads alongside this file on every
// page that has the toggle, exposes window.MatrixRain. Guarded
// against load-order races: the script may parse a tick after this
// one depending on the page's <script> ordering.
function rainStart() { try { window.MatrixRain && window.MatrixRain.start(); } catch {} }
function rainStop()  { try { window.MatrixRain && window.MatrixRain.stop(); }  catch {} }

function syncSideEffects() {
  const isHacker = document.documentElement.classList.contains('hacker');
  applyHackerCopy(isHacker);
  if (isHacker) rainStart(); else rainStop();
}

// Apply side-effects on initial load too (the document may have
// landed already in hacker via the cookie). Defer to DOMContentLoaded
// so document.body exists for matrix-rain canvas insertion and
// data-hacker-text nodes are parsed.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncSideEffects);
} else {
  syncSideEffects();
}

// Phase 2: wire the toggle (if present).
function wireToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  // Triple-tap detection: track click timestamps in a sliding window.
  // On the third click within HACKER_TRIGGER_MS, enter hacker mode
  // INSTEAD of the normal toggle action.
  const recentClicks = [];

  btn.addEventListener('click', () => {
    const now = Date.now();
    recentClicks.push(now);
    while (recentClicks.length > 0 && now - recentClicks[0] > HACKER_TRIGGER_MS) {
      recentClicks.shift();
    }

    const root = document.documentElement;
    const wasHacker = root.classList.contains('hacker');
    const wasDark   = root.classList.contains('dark');
    const current   = wasHacker ? 'hacker' : (wasDark ? 'dark' : 'light');

    let next;
    if (recentClicks.length >= HACKER_TRIGGER_CLICKS && !wasHacker) {
      // Easter-egg trigger. Stash where we came from so the next
      // single click can return there.
      writeCookie(COOKIE_PREV, current);
      next = 'hacker';
      // Reset the click window so the next triple doesn't trigger
      // again immediately.
      recentClicks.length = 0;
    } else if (wasHacker) {
      // Exit: go back to the stashed pre-hacker state, falling back
      // to dark if the cookie is missing.
      const prev = readCookie(COOKIE_PREV);
      next = (prev === 'light' || prev === 'dark') ? prev : 'dark';
    } else {
      // Normal light vs dark cycle.
      next = wasDark ? 'light' : 'dark';
    }

    applyTheme(next);
    writeCookie(COOKIE_NAME, next);
    syncSideEffects();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireToggle);
} else {
  wireToggle();
}
