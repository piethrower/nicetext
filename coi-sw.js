// coi-sw.js: Service Worker. Two responsibilities:
//
// 1. Cross-Origin Isolation headers on every same-origin response so
//    the page becomes cross-origin isolated and SharedArrayBuffer is
//    available. Workaround for static hosts (GitHub Pages) that don't
//    let you set COOP/COEP HTTP headers server-side.
//
// 2. Save-as-stream egress for pipeline mode. The page postMessages a
//    transferred ReadableStream with an id and filename; the SW stores
//    it. The page then triggers a navigation/download to
//    `__pipeline-save/<id>` (resolved relative to the page URL); the
//    SW intercepts that fetch and serves the stream as a
//    Content-Disposition: attachment response, so the browser saves
//    chunks to disk as they arrive, no whole-payload buffer.
//
// Lives at the deployment root next to the HTML pages so its default
// scope covers everything under that root. js/coi.js registers it for
// COI; js/pipeline.js registers it lazily for pipeline use.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// id → { stream, filename }. Populated on 'pipeline-save-register'
// messages, consumed and removed by the matching fetch.
const pendingSaves = new Map();

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'pipeline-save-register') return;
  const { id, stream, filename, ackPort } = data;
  if (!id || !stream) {
    if (ackPort) ackPort.postMessage({ type: 'error', error: 'missing id or stream' });
    return;
  }
  pendingSaves.set(id, { stream, filename: filename || id });
  if (ackPort) ackPort.postMessage({ type: 'registered' });
});

// Body is the registered ReadableStream; Content-Disposition forces a
// download with the suggested filename. Content-Type is generic binary;
// the filename's extension tells the OS what to do.
function makeSaveResponse(saved) {
  const { stream, filename } = saved;
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename).replace(/"/g, '%22')}"`,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  return new Response(stream, { status: 200, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  // Pipeline save URL? Match anywhere in the path so deployments under
  // a subdirectory (GitHub Pages /myrepo/) still work.
  const url = new URL(req.url);
  const m = url.pathname.match(/\/__pipeline-save\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const id = m[1];
    const saved = pendingSaves.get(id);
    if (saved) {
      pendingSaves.delete(id); // one-shot
      event.respondWith(makeSaveResponse(saved));
    } else {
      event.respondWith(new Response('not found', { status: 404 }));
    }
    return;
  }

  event.respondWith(
    fetch(req).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      // Frame-busting via response headers (the meta-tag CSP's
      // frame-ancestors directive is ignored by browsers, must be a
      // real header). Belt-and-braces with X-Frame-Options DENY for
      // legacy clients.
      headers.set('Content-Security-Policy', "frame-ancestors 'none'");
      headers.set('X-Frame-Options', 'DENY');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }).catch((err) => {
      console.error('[coi-sw] fetch failed:', err);
      throw err;
    })
  );
});
