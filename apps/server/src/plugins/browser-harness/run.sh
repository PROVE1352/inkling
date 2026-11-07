#!/bin/bash
# Real-browser sandbox check for the Plugin API (see docs/PLUGINS.md "Verifying the sandbox").
# Prereqs: a disposable server started with
#   EXPERIMENTAL_FEATURES=plugins PLUGINS_DIR=<dir> WEB_DIST=<OUT dir below>
# where <dir> is a scratch directory holding copies of both examples/plugins/* and
# apps/server/src/plugins/fixtures/* (the test-only security-probe lives in fixtures), e.g.
#   mkdir -p /tmp/plugins && cp -R examples/plugins/* apps/server/src/plugins/fixtures/* /tmp/plugins/
# an admin "admin@example.com" / "password123", and security-probe + progress-bar approved.
# Then: run.sh <OUT dir> <server port> and, in another shell, start headless Chrome with
#   --headless=new --remote-debugging-port=9613 --user-data-dir=<tmp>
# and run: node cdp.mjs   (prints the results JSON)
set -euo pipefail
OUT=${1:?output dir}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../../.." && pwd)
mkdir -p "$OUT"
cp "$HERE/index.html" "$HERE/harness.js" "$OUT/"
ESBUILD=$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | tail -1)
"$ESBUILD" "$ROOT/apps/web/src/plugins/broker.ts" --bundle --format=iife --global-name=PB --outfile="$OUT/broker.js"
echo "harness ready in $OUT — open http://localhost:${2:-3613}/index.html"
