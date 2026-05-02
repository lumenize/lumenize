#!/usr/bin/env bash
#
# Audit: TEST_MODE leak surfaces
#
# Test-mode env vars (NEBULA_AUTH_TEST_MODE, LUMENIZE_AUTH_TEST_MODE) bypass
# real auth — magic-link required, Turnstile, etc. They MUST only be set in
# vitest configs (in-process miniflare bindings, never deployed). If one of
# these vars ever lands in a wrangler.jsonc, a package.json script, a shell
# script, or a CI workflow, that's a production-leak risk.
#
# This script fails CI if any *_TEST_MODE pattern appears in those high-risk
# surfaces. It's intentionally narrow — it does not flag mentions in
# vitest.config.* (the only legitimate setter), in *.test.ts files, in src/
# (where the var is read with strict === 'true'), or in markdown docs.
#
# Wired into:
#   - scripts/test-code.sh (local pre-test gate)
#   - scripts/prepare-for-publish.sh (pre-publish gate)
#   - .github/workflows/ci.yml (PR gate)
#
# To run manually:
#   npm run audit:test-mode

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PATTERN='(NEBULA_AUTH_TEST_MODE|LUMENIZE_AUTH_TEST_MODE)'
HITS=0

# Common excludes for grep -r — directories that are noise (build/install
# artifacts, generated docs, screenshots, caches).
EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=coverage
  --exclude-dir=.wrangler
  --exclude-dir=__screenshots__
  --exclude-dir=.vitest-cache
  --exclude-dir=.vitest-attachments
  --exclude-dir=build
  --exclude-dir=.docusaurus
)

# Run grep -r restricted to a glob include, exclude the audit script itself
# (it mentions the pattern by definition).
scan() {
  local label="$1"
  shift
  local include_args=()
  for pattern in "$@"; do
    include_args+=("--include=$pattern")
  done
  local matched
  matched=$(grep -rlE "$PATTERN" "${EXCLUDE_DIRS[@]}" "${include_args[@]}" \
    --exclude='audit-test-mode.sh' . 2>/dev/null || true)
  if [ -n "$matched" ]; then
    echo "❌ ${label}:"
    echo "$matched" | sed 's/^/   /'
    echo ""
    HITS=$((HITS + 1))
  fi
}

# 1. wrangler configs — these go to PROD on deploy
scan "wrangler.jsonc / wrangler.toml (would deploy to prod)" \
  'wrangler.jsonc' 'wrangler.toml' 'wrangler.json'

# 2. package.json scripts — anyone running an npm script could leak it
scan "package.json (npm scripts)" \
  'package.json'

# 3. shell scripts — could be invoked by deploys, releases, etc.
scan "shell scripts" \
  '*.sh'

# 4. CI workflow YAMLs — would set the var on every PR / deploy
# Restrict to .github/ to avoid flagging unrelated YAML elsewhere.
GITHUB_HITS=$(grep -rlE "$PATTERN" "${EXCLUDE_DIRS[@]}" \
  --include='*.yml' --include='*.yaml' \
  ./.github 2>/dev/null || true)
if [ -n "$GITHUB_HITS" ]; then
  echo "❌ CI workflows (.github/):"
  echo "$GITHUB_HITS" | sed 's/^/   /'
  echo ""
  HITS=$((HITS + 1))
fi

# 5. .dev.vars / .env (gitignored normally, but worth catching if accidentally committed)
scan ".dev.vars / .env files" \
  '.dev.vars' '.dev.vars.example' '.env' '.env.example'

if [ "$HITS" -gt 0 ]; then
  echo "❌ Audit failed: ${HITS} category(ies) above contain a *_TEST_MODE reference."
  echo ""
  echo "TEST_MODE env vars MUST only be set in vitest.config.* files (in-process"
  echo "miniflare bindings) or referenced in *.test.ts files. Setting them in"
  echo "any of the surfaces above risks a production leak."
  echo ""
  echo "Fix the offending files, then re-run: npm run audit:test-mode"
  exit 1
fi

echo "✅ TEST_MODE audit clean — no leak surfaces in wrangler configs, npm scripts, shell scripts, CI workflows, or env files."
