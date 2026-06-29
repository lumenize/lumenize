#!/usr/bin/env bash
#
# Shared install/setup spine for EVERY lane that runs the test suites — CI
# (.github/workflows/ci.yml's two jobs + ui-smoke.yml) and the hosted Claude Code
# web sandbox (scripts/cloud-setup.sh). One source of truth for the two parts that
# have drifted (or would) when each lane open-codes them:
#   1. ORDER — `.dev.vars` must be written BEFORE `npm ci`, because postinstall
#      (setup-symlinks.sh) symlinks it into every package/test dir as worker bindings.
#   2. NATIVE BINDINGS — `npm ci --no-optional` strips the x64 Rollup/SWC/lightningcss
#      binaries (the committed lockfile carries the maintainer's arm64 optionals), so
#      they must be re-added — in ONE `npm install`, because separate `--no-save`
#      installs PRUNE each other's additions (npm recomputes the tree each time).
#
# Core (always): `npm ci --no-optional` + Rollup & SWC Linux bindings.
# Opt-in flags — each lane requests only what it needs:
#   --cache-clean   `npm cache clean --force` before npm ci (CI runners do this)
#   --dev-vars      reconstruct .dev.vars from env secrets BEFORE npm ci
#                   (RESEND_API_KEY/TEST_TOKEN required by ci-write-dev-vars.mjs;
#                    optional WORKERS_AI_TOKEN/CLOUDFLARE_ACCOUNT_ID pass through)
#   --lightningcss  also re-add the lightningcss Linux binding (vite lanes: ui-smoke + hosted)
#   --chromium      `npx playwright install --with-deps chromium` (GHA; the web image pre-ships it)
#   --bundle        build the gitignored @lumenize/ts-runtime-parser-validator dist
#
# `set -e`: any step failing aborts loudly (e.g. ci-write-dev-vars.mjs hard-exits when
# its required secrets are unset — a misconfigured lane fails fast, never silently green).

set -euo pipefail

CACHE_CLEAN=0 DEV_VARS=0 LIGHTNINGCSS=0 CHROMIUM=0 BUNDLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cache-clean)  CACHE_CLEAN=1 ;;
    --dev-vars)     DEV_VARS=1 ;;
    --lightningcss) LIGHTNINGCSS=1 ;;
    --chromium)     CHROMIUM=1 ;;
    --bundle)       BUNDLE=1 ;;
    *) echo "ci-install: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 1. .dev.vars BEFORE npm ci (postinstall symlinks it into every package/test dir).
if [ "$DEV_VARS" = 1 ]; then
  echo "▸ ci-install: reconstruct .dev.vars from env secrets"
  node scripts/ci-write-dev-vars.mjs
fi

# 2. (CI) clean npm cache to avoid cross-run corruption on shared runners.
if [ "$CACHE_CLEAN" = 1 ]; then
  echo "▸ ci-install: npm cache clean --force"
  npm cache clean --force
fi

# 3. Install deps. --no-optional dodges the Rollup arm64-lockfile bug; the native
#    bindings it strips are re-added next.
echo "▸ ci-install: npm ci --no-optional"
npm ci --no-optional

# 4. Re-add the x64 native bindings in ONE install (separate --no-save installs prune
#    each other). SWC's binding must match the installed @swc/core; lightningcss's
#    `exports` blocks require() of its package.json, so read its version off disk.
BINDINGS=(
  "@rollup/rollup-linux-x64-gnu"
  "@swc/core-linux-x64-gnu@$(node -p 'require("@swc/core/package.json").version')"
)
if [ "$LIGHTNINGCSS" = 1 ]; then
  BINDINGS+=( "lightningcss-linux-x64-gnu@$(node -p "JSON.parse(require('fs').readFileSync('node_modules/lightningcss/package.json','utf8')).version")" )
fi
echo "▸ ci-install: re-add Linux native bindings — ${BINDINGS[*]}"
npm install --no-save "${BINDINGS[@]}"

# 5. (vite/browser lanes) real Chromium for Playwright. The hosted web image pre-ships
#    it (PLAYWRIGHT_BROWSERS_PATH) — do NOT pass --chromium there.
if [ "$CHROMIUM" = 1 ]; then
  echo "▸ ci-install: install Playwright chromium"
  npx playwright install --with-deps chromium
fi

# 6. Build the gitignored ts-runtime-parser-validator dist bundle (typia + typescript).
if [ "$BUNDLE" = 1 ]; then
  echo "▸ ci-install: build @lumenize/ts-runtime-parser-validator bundle"
  npm run bundle -w @lumenize/ts-runtime-parser-validator
fi

echo "✅ ci-install complete"
