// Runtime compatibility check.
//
// NiceText's encode / decode core assumes a conformant ES2024+
// JavaScript engine in the host runtime. Older browsers can load the
// page far enough to display chrome but will silently produce wrong
// answers in regex-heavy paths (the format.js emoji-cluster check is
// the first one to break, see `^💻^` + `^❤^` fusion regression in
// `tests/node/grammar.test.js`).
//
// Rather than ship a compatibility shim that lives forever as
// engine clutter, we fail loud at page-load: feature-detect what
// the engine needs, and surface a clearly visible banner if any
// check fails. The page still renders so the user can read the
// banner and decide whether to update or click around at their own
// risk.
//
// Loaded as a classic <script src="..."> from every public HTML
// page that already loads theme.js. Plain DOM APIs only;
// createElement + textContent so the banner can't trip the page's
// Content-Security-Policy / Trusted-Types defenses.

(function runtimeCheck() {
  // Each check is { name, ok: () => boolean, why: string }. ok() must
  // be synchronous, fast, and side-effect-free. why is a one-line
  // user-facing description of what the engine misses.
  const CHECKS = [
    {
      name: 'regex-v-flag',
      ok: function () {
        try { new RegExp('a', 'v'); return true; }
        catch (e) { return false; }
      },
      why: 'ES2024 regex `v` flag (used by the encoder / formatter)',
    },
  ];

  const failed = [];
  for (let i = 0; i < CHECKS.length; i++) {
    const c = CHECKS[i];
    let pass = false;
    try { pass = !!c.ok(); } catch (e) { pass = false; }
    if (!pass) failed.push(c);
  }
  if (failed.length === 0) return;

  function appendBanner() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', appendBanner, { once: true });
      return;
    }
    if (document.getElementById('runtime-check-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'runtime-check-banner';
    banner.setAttribute('role', 'alert');
    // Inline styles only: the banner has to render even if our CSS
    // didn't load (browser too old to parse some modern property).
    banner.style.background = '#a4321a';
    banner.style.color = '#ffffff';
    banner.style.padding = '0.6rem 1rem';
    banner.style.fontFamily = 'system-ui, sans-serif';
    banner.style.fontSize = '0.9rem';
    banner.style.lineHeight = '1.4';
    banner.style.position = 'sticky';
    banner.style.top = '0';
    banner.style.zIndex = '99999';
    banner.style.borderBottom = '2px solid #6b1f10';

    const headline = document.createElement('strong');
    headline.textContent = 'Browser too old. ';
    banner.appendChild(headline);

    const tail = document.createElement('span');
    tail.textContent =
      'Your browser is too old to run NiceText properly. ' +
      'Please update Chrome (≥ 116), Firefox (≥ 116), or Safari (≥ 17). ' +
      'Missing features: ' + failed.map(function (c) { return c.why; }).join('; ') + '.';
    banner.appendChild(tail);

    document.body.insertBefore(banner, document.body.firstChild);
  }
  appendBanner();
})();
