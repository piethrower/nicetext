// First-visit disclaimer modal. Shows the "use at your own risk"
// disclaimer with the NiceText hero logo and an Agree button on
// first load. Agree sets a session cookie so the modal doesn't
// re-show until the browser is closed (or the cookie is cleared).
//
// Mirrors js/theme.js's cookie pattern (readCookie/writeCookie,
// path=/, SameSite=Lax, no Max-Age → session cookie that clears
// on full browser close). UI-pref only; rule 27 covers
// payload/cover content, not chrome state.
//
// The "Learn more" link is a plain anchor to index.html, clicking
// it navigates without setting the cookie, so a return visit
// re-prompts. Close-X / ESC dismiss without writing the cookie, so
// next load shows the modal again, same disagreement-by-departure
// semantic.

import { createOptionsModal } from './options-modal.js';

const COOKIE_NAME = 'nicetext-disclaimer-agreed';

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

function wireDisclaimer() {
  const dlg = document.getElementById('first-visit-disclaimer');
  if (!dlg) return;

  // "Learn more" navigates away, clear the agreement cookie so the
  // developer has to re-agree on return.
  const learnMore = document.querySelector('.disclaimer-learn-more');
  if (learnMore) {
    learnMore.addEventListener('click', () => { writeCookie(COOKIE_NAME, ''); });
  }

  const modal = createOptionsModal({
    dialog: 'first-visit-disclaimer',
    closeX: 'first-visit-disclaimer-close',
    buttons: [
      { id: 'first-visit-disclaimer-agree', value: 'agree', primary: true },
    ],
  });

  const openDisclaimer = () => {
    modal.open().then((choice) => {
      if (choice === 'agree') writeCookie(COOKIE_NAME, '1');
    });
  };

  // First-visit auto-open.
  if (readCookie(COOKIE_NAME) !== '1') openDisclaimer();

  // Footer "Disclaimer:" trigger, re-opens the same modal instance
  // so the factory's button + close-X wiring stays in scope.
  const reopen = document.getElementById('disclaimer-reopen');
  if (reopen) reopen.addEventListener('click', openDisclaimer);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireDisclaimer);
} else {
  wireDisclaimer();
}
