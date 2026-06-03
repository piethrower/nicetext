#!/usr/bin/env bash
# Serve the NiceText web UI from the repo root with cross-origin
# isolation enabled (so SharedArrayBuffer is available). Then open:
#   http://localhost:8888/nicetext.html
# Implementation lives in tools/serve.py.
set -euo pipefail
exec python3 "$(dirname "$0")/serve.py" "${1:-8888}"
