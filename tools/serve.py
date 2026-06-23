#!/usr/bin/env python3
"""Local dev server for the NiceText web UI. Serves the repo root over
HTTP in one of two modes, so both the SharedArrayBuffer path and the
ArrayBuffer fallback path can be exercised deterministically.

Default (isolated) mode — adds two independent sets of headers:

Cross-origin isolation (the original reason this server exists):
  Cross-Origin-Opener-Policy:   same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
The first two enable cross-origin isolation, which makes
`new SharedArrayBuffer(n)` work. The third lets same-origin
sub-resources (modules, JSON, fonts, fetched dicts) load under that
isolation.

No-cache (for Playwright):
  Cache-Control: no-store, must-revalidate
  Pragma:        no-cache
  Expires:       0
The stock `python3 -m http.server` replays cached If-Modified-Since
responses, so Playwright (which re-navigates per scenario) serves stale
JS/CSS between runs and masks real code changes. These headers force a
refetch every load.

--no-isolation mode — reproduces a host that cannot give the page
SharedArrayBuffer (e.g. archive.org, which blocks service workers):
  * omits COOP/COEP/CORP, so the page is never cross-origin isolated;
  * sends `X-NiceText-No-Isolation: 1`, which coi.js reads and obeys by
    NOT registering coi-sw.js. Without this, coi.js's service worker
    would re-inject the isolation headers and "rescue" the page back
    onto the SAB path, making this port secretly identical to the
    default one. The header is what keeps the fallback port honest.
Run both at once (they default to different ports) to test side by side:
    tools/serve.py                 # isolated -> http://localhost:8888/
    tools/serve.py --no-isolation  # fallback -> http://localhost:8889/

Usage:
    tools/serve.py [PORT] [--no-isolation]
    tools/serve.sh [PORT]            (wrapper, isolated mode)

Serves the repo root (the parent of tools/) regardless of the directory
it is launched from.
"""

import argparse
import http.server
import os

parser = argparse.ArgumentParser(description="NiceText dev server.")
parser.add_argument("port", nargs="?", type=int, default=None,
                    help="port to listen on "
                         "(default 8888 isolated, 8889 --no-isolation)")
parser.add_argument("--no-isolation", action="store_true",
                    help="omit COOP/COEP and send X-NiceText-No-Isolation so "
                         "the page runs the ArrayBuffer fallback path")
args = parser.parse_args()

ISOLATE = not args.no_isolation
PORT = args.port if args.port is not None else (8888 if ISOLATE else 8889)

# Serve from the repo root (the parent of tools/).
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(repo_root)


class CoiHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if ISOLATE:
            # Cross-origin isolation: enables SharedArrayBuffer.
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        else:
            # Tell coi.js NOT to rescue isolation via the service worker,
            # so the page genuinely stays un-isolated (no SAB) for
            # fallback testing. See the module docstring.
            self.send_header('X-NiceText-No-Isolation', '1')
        # No-cache: force a refetch on every load (Playwright).
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


# ThreadingHTTPServer (Python 3.7+) handles concurrent fetches —
# workers fetch their own modules in parallel with the main page.
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(('', PORT), CoiHandler) as httpd:
    mode = "cross-origin isolation (COOP/COEP)" if ISOLATE \
        else "NO isolation (X-NiceText-No-Isolation -> ArrayBuffer fallback)"
    print(f"Serving {repo_root}")
    print(f"  on http://localhost:{PORT}/")
    print(f"  with {mode} + no-cache headers")
    httpd.serve_forever()
