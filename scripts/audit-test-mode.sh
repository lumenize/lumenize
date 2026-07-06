#!/usr/bin/env bash
#
# Audit: TEST_MODE + BOOTSTRAP_EMAIL leak surfaces
#
# Test-mode env vars (NEBULA_AUTH_TEST_MODE, LUMENIZE_AUTH_TEST_MODE) bypass
# real auth — magic-link required, Turnstile, etc. They MUST only be set in
# vitest configs (in-process miniflare bindings, never deployed). If one of
# these vars ever lands in a wrangler.jsonc, a package.json script, a shell
# script, or a CI workflow, that's a production-leak risk.
#
# Bootstrap-admin emails (NEBULA_AUTH_BOOTSTRAP_EMAIL, LUMENIZE_AUTH_BOOTSTRAP_EMAIL)
# are privilege-granting (auto-admin for the first subject registering that email —
# and at nebula-platform, a `*` super-admin). A value committed in a WRANGLER CONFIG
# deploys as a prod var — a standing admin backdoor — so those are scanned too
# (wrangler configs only; the deployed test/browser/worker harness is the excepted home).
#
# This script fails CI if any *_TEST_MODE pattern appears in those high-risk
# surfaces, or any *_BOOTSTRAP_EMAIL appears in a non-excepted wrangler config.
# It's intentionally narrow — it does not flag TEST_MODE mentions in
# vitest.config.* (the only legitimate setter), in *.test.ts files, in src/
# (where the var is read with strict === 'true'), or in markdown docs; nor a
# BOOTSTRAP_EMAIL placeholder in .dev.vars.example or a secret-existence check in a deploy script.
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

# 6. Privilege-granting SECRETS in a WRANGLER CONFIG — committed here they deploy as world-readable
# prod vars (packaging.md § Environment variables). They belong in vitest miniflare.bindings (tests)
# or `wrangler secret put` (prod), NEVER a committed config:
#   *_BOOTSTRAP_EMAIL           — auto-admin for the first subject registering that email → a standing admin backdoor.
#   NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN — the shared token that skips Turnstile (router.checkTurnstile) → committed = anyone bypasses Turnstile.
# The ONLY sanctioned home is a *deployed test harness* (test/browser/worker/), which carries the
# bootstrap email with a comment — excepted below. Scanned for WRANGLER CONFIGS ONLY, deliberately NOT
# shell scripts: a deploy script that merely CHECKS a secret is set via `wrangler secret list` (e.g.
# apps/nebula/scripts/deploy.sh naming the var) sets no committed value and is legitimate.
# .dev.vars.example is the placeholder template (a value there is expected), so it's not scanned here.
PRIVILEGED_PATTERN='(NEBULA_AUTH_BOOTSTRAP_EMAIL|LUMENIZE_AUTH_BOOTSTRAP_EMAIL|NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN)'
PRIVILEGED_HITS=$(grep -rlE "$PRIVILEGED_PATTERN" "${EXCLUDE_DIRS[@]}" \
  --include='wrangler.jsonc' --include='wrangler.toml' --include='wrangler.json' \
  --exclude='audit-test-mode.sh' . 2>/dev/null | grep -vE '/test/browser/worker/' || true)
if [ -n "$PRIVILEGED_HITS" ]; then
  echo "❌ A privilege-granting secret (*_BOOTSTRAP_EMAIL / *_TURNSTILE_BYPASS_TOKEN) in a wrangler config (deploys as a prod var):"
  echo "$PRIVILEGED_HITS" | sed 's/^/   /'
  echo ""
  HITS=$((HITS + 1))
fi

if [ "$HITS" -gt 0 ]; then
  echo "❌ Audit failed: ${HITS} category(ies) above contain a *_TEST_MODE / *_BOOTSTRAP_EMAIL / *_TURNSTILE_BYPASS_TOKEN leak."
  echo ""
  echo "TEST_MODE env vars and *_BOOTSTRAP_EMAIL (privilege-granting) MUST only be set in"
  echo "vitest.config.* miniflare.bindings (or referenced in *.test.ts files). A bootstrap email in a"
  echo "committed wrangler config deploys as a prod var — a standing admin backdoor."
  echo ""
  echo "Fix the offending files, then re-run: npm run audit:test-mode"
  exit 1
fi

echo "✅ Audit clean — no *_TEST_MODE / *_BOOTSTRAP_EMAIL / *_TURNSTILE_BYPASS_TOKEN leak surfaces in wrangler configs, npm scripts, shell scripts, CI workflows, or env files."
