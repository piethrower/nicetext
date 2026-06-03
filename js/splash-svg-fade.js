// Splash hero's Penny SVG fade-in. The img used to carry an inline
// onload handler, but the page's CSP (script-src 'self') blocks
// inline handlers. This module runs once on DOMContentLoaded and
// flips the .loaded class on any img.penny-figure-img it finds, so
// the matching CSS visibility/opacity transition fires.
//
// Split out of bit-flow.js so that file can be a pure animation
// module imported by the slideshow.

function wirePennyFigureLoad() {
  for (const img of document.querySelectorAll('img.penny-figure-img')) {
    if (img.complete) img.classList.add('loaded');
    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wirePennyFigureLoad);
} else {
  wirePennyFigureLoad();
}
