// coi.js: Cross-Origin Isolation registration helper.
//
// Loaded as a regular (non-module) script at the top of HTML pages
// that need SharedArrayBuffer to work on hosts that can't set
// COOP/COEP headers server-side (GitHub Pages, etc.). On the local
// dev server (tools/serve.py) the headers are already set, so this
// script no-ops on the first visit.
//
// Behavior:
//   1. If the page is already cross-origin isolated, log "active"
//      and exit.
//   2. Otherwise, register coi-sw.js and reload once on first
//      registration so the SW can intercept this page's load too.
//   3. If the SW is already controlling this page but isolation is
//      still off (something blocked it), log a warning and exit
//      without reloading, avoid a reload loop.
//   4. If ServiceWorker isn't supported at all, log that the
//      ArrayBuffer fallback path is in use.
//
// Paths are relative throughout. The SW URL is computed from this
// script's own URL (document.currentScript.src) so deployment-root
// is wherever the deploy puts us, not a hardcoded absolute path.

(function () {
  const sabAvailable = typeof SharedArrayBuffer !== 'undefined';

  if (window.crossOriginIsolated && sabAvailable) {
    console.info('[coi] cross-origin isolated, SharedArrayBuffer active');
    return;
  }

  if (!('serviceWorker' in navigator)) {
    console.info('[coi] no service worker support; using ArrayBuffer fallback (slower per-job)');
    return;
  }

  // SW is already controlling but isolation didn't take. Avoid a
  // reload loop; let the page run in fallback mode.
  if (navigator.serviceWorker.controller) {
    console.warn('[coi] service worker active but isolation failed; using ArrayBuffer fallback');
    return;
  }

  // Compute SW URL from this script's URL via relative resolution.
  // js/coi.js → coi-sw.js at the deployment root, regardless of
  // whether the deploy is at /, /nicetext/, /myrepo/, etc.
  const myScript = document.currentScript;
  if (!myScript || !myScript.src) {
    console.warn('[coi] cannot determine script URL; ArrayBuffer fallback');
    return;
  }
  let swUrl;
  try {
    swUrl = new URL('../coi-sw.js', myScript.src);
  } catch (err) {
    console.warn('[coi] could not resolve coi-sw.js URL:', err);
    return;
  }

  // Trusted Types (CSP `require-trusted-types-for 'script'`) requires
  // a TrustedScriptURL for register(). Lazily register a passthrough
  // policy if Trusted Types is enforced; otherwise pass the URL
  // object directly (register accepts URL objects natively).
  let registerArg = swUrl;
  if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
    try {
      const policy = trustedTypes.createPolicy('coi-sw-url', {
        createScriptURL: (input) => input,
      });
      registerArg = policy.createScriptURL(swUrl.href);
    } catch (err) {
      // Policy might already exist (rare; module re-imported); fall
      // back to the URL object. register() doesn't always accept
      // strings under strict TT, so URL is the safer fallback.
    }
  }

  console.info('[coi] not isolated, registering service worker, page will reload...');
  navigator.serviceWorker.register(registerArg).then((reg) => {
    // If the SW is controlling now, no reload needed. If not, the
    // page loaded before the SW could intercept; reload to bring it
    // under control.
    if (!navigator.serviceWorker.controller) {
      window.location.reload();
    }
  }).catch((err) => {
    console.error('[coi] service worker registration failed; ArrayBuffer fallback:', err);
  });
})();
