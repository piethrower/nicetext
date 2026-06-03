#!/usr/bin/env python3
"""Local dev server for the NiceText web UI, with cross-origin
isolation enabled so SharedArrayBuffer is available in the browser.
Serves the repo root over HTTP and adds three headers to every
response:

  Cross-Origin-Opener-Policy:  same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

The first two enable cross-origin isolation, which makes
`new SharedArrayBuffer(n)` work. The third lets same-origin
sub-resources (modules, JSON, fonts, fetched dicts) load under that
isolation. Without these headers, the engine falls back to plain
ArrayBuffer copies per worker (functional but not shared) and the
SAB-only browser test skips.

Usage: tools/serve.py [PORT]   (default 8888)
"""

import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8888

# Serve from the repo root (the parent of tools/).
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(repo_root)


class CoiHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()


# ThreadingHTTPServer (Python 3.7+) handles concurrent fetches —
# workers fetch their own modules in parallel with the main page.
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('', PORT), CoiHandler) as httpd:
    print(f"Serving {repo_root}")
    print(f"  on http://localhost:{PORT}/")
    print("  with cross-origin isolation (COOP/COEP)")
    httpd.serve_forever()
