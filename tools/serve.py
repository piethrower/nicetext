#!/usr/bin/env python3
"""Local dev server for the NiceText web UI. Serves the repo root over
HTTP and adds two independent sets of headers to every response:

Cross-origin isolation (the original reason this server exists):
  Cross-Origin-Opener-Policy:   same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
The first two enable cross-origin isolation, which makes
`new SharedArrayBuffer(n)` work. The third lets same-origin
sub-resources (modules, JSON, fonts, fetched dicts) load under that
isolation. Without these headers, the engine falls back to plain
ArrayBuffer copies per worker (functional but not shared) and the
SAB-only browser test skips.

No-cache (for Playwright):
  Cache-Control: no-store, must-revalidate
  Pragma:        no-cache
  Expires:       0
The stock `python3 -m http.server` replays cached If-Modified-Since
responses, so Playwright (which re-navigates per scenario) serves stale
JS/CSS between runs and masks real code changes. These headers force a
refetch every load.

Usage:
    tools/serve.py [PORT]      (default 8888)
    tools/serve.sh [PORT]      (wrapper)

Serves the repo root (the parent of tools/) regardless of the directory
it is launched from.
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
        # Cross-origin isolation: enables SharedArrayBuffer.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        # No-cache: force a refetch on every load (Playwright).
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


# ThreadingHTTPServer (Python 3.7+) handles concurrent fetches —
# workers fetch their own modules in parallel with the main page.
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('', PORT), CoiHandler) as httpd:
    print(f"Serving {repo_root}")
    print(f"  on http://localhost:{PORT}/")
    print("  with cross-origin isolation (COOP/COEP) + no-cache headers")
    httpd.serve_forever()
