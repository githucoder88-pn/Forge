#!/usr/bin/env bash
# Full Forge gate: build + typecheck + all tests + web syntax.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== build =="
npm run build

echo "== typecheck =="
npm run typecheck --workspaces --if-present

echo "== tests =="
npm run test --workspaces --if-present

echo "== web syntax =="
for f in apps/forge-web/public/*.js; do node --check "$f"; done
echo "WEB_JS_OK: $(ls apps/forge-web/public/*.js | wc -l) files"

echo "ALL GATES PASSED"
