#!/usr/bin/env bash
set -e

# Shared package-test runner for BOTH local dev and CI, so test DISCOVERY can
# never drift between them. (It drifted once: local discovered by "package.json
# has a test script" while CI's inline loop keyed on `vitest.config.js` — so
# `@lumenize/email` + `@lumenize/debug`, which use `vitest.config.ts`, ran
# locally but were SILENTLY skipped in CI → false green. One discovery rule,
# used everywhere, prevents that whole class of silent-drop.)
#
# Discovery rule (the single source of truth): a workspace is tested iff its
# package.json has a `test` script.
#
# Flags (all optional; defaults reproduce the previous local-dev behavior):
#   --scope "packages apps tooling"  dir prefixes to search (default: all three)
#   --coverage                       pass --coverage through to vitest
#   --retry N                        pass --retry N through to vitest
#   --run-all                        run every package, collect failures, fail at
#                                    the end (default: abort on first failure, so
#                                    the offending package is last on screen)
#   --list                           print the discovered packages and exit (dry run)
#
# Local:  scripts/test-code.sh                                           (npm run test:code)
# CI:     scripts/test-code.sh --scope packages --coverage --retry 2 --run-all

SCOPE="packages apps tooling"
VITEST_ARGS=()
RUN_ALL=0
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --scope)    SCOPE="$2"; shift 2 ;;
    --coverage) VITEST_ARGS+=("--coverage"); shift ;;
    --retry)    VITEST_ARGS+=("--retry" "$2"); shift 2 ;;
    --run-all)  RUN_ALL=1; shift ;;
    --list)     LIST_ONLY=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "🧪 Running package tests (scope: $SCOPE)..."

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Pre-flight: TEST_MODE leak audit. Fail fast before running test suites if any
# *_TEST_MODE pattern leaked into wrangler configs, npm scripts, shell scripts,
# CI workflows, or .dev.vars files. (Harmless if CI also runs it as its own job.)
"$ROOT_DIR/scripts/audit-test-mode.sh"
echo ""

# Discover workspaces with a test script (the single discovery rule).
PACKAGES=()
for prefix in $SCOPE; do
  for pkg_json in "$prefix"/*/package.json; do
    [ -f "$pkg_json" ] || continue
    if node -e "process.exit(require('./$pkg_json').scripts?.test ? 0 : 1)" 2>/dev/null; then
      PACKAGES+=("$(node -e "console.log(require('./$pkg_json').name)")")
    fi
  done
done

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No packages with test scripts found (scope: $SCOPE)"
  exit 1
fi

echo "Found ${#PACKAGES[@]} package(s) with tests:"
for pkg in "${PACKAGES[@]}"; do echo "  - $pkg"; done
echo ""

if [ "$LIST_ONLY" = 1 ]; then exit 0; fi

# Run tests one package at a time. Abort-on-first by default (offending package
# stays last on screen); --run-all collects failures and fails at the end so a
# flake can't mask the packages after it (CI uses this with --retry).
failed=""
for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🧪 Testing $pkg..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ok=1
  if [ ${#VITEST_ARGS[@]} -gt 0 ]; then
    npm run test -w "$pkg" -- "${VITEST_ARGS[@]}" || ok=0
  else
    npm run test -w "$pkg" || ok=0
  fi
  if [ "$ok" = 0 ]; then
    failed="$failed $pkg"
    if [ "$RUN_ALL" != 1 ]; then
      echo ""
      echo "❌ Tests failed in $pkg — aborting."
      echo "   Re-run individually with:  npm run test -w $pkg"
      exit 1
    fi
  fi
done

if [ -n "$failed" ]; then
  echo ""
  echo "❌ Failed packages:$failed"
  exit 1
fi

echo ""
echo "✅ All package tests passed"
