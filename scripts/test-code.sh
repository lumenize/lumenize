#!/usr/bin/env bash
set -e

# Run tests for all packages in packages/ that have a test script
# Auto-discovers packages - no need to maintain an explicit list

echo "🧪 Running package tests..."

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Pre-flight: TEST_MODE leak audit. Fail fast before running test suites
# if any *_TEST_MODE pattern leaked into wrangler configs, npm scripts,
# shell scripts, CI workflows, or .dev.vars files.
"$ROOT_DIR/scripts/audit-test-mode.sh"
echo ""

# Find all packages with test scripts
PACKAGES=()
for pkg_json in packages/*/package.json apps/*/package.json; do
  if [ -f "$pkg_json" ]; then
    # Check if package has a test script
    if node -e "const pkg = require('./$pkg_json'); process.exit(pkg.scripts?.test ? 0 : 1);" 2>/dev/null; then
      # Get package name
      pkg_name=$(node -e "console.log(require('./$pkg_json').name)")
      PACKAGES+=("$pkg_name")
    fi
  fi
done

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No packages with test scripts found in packages/"
  exit 1
fi

echo "Found ${#PACKAGES[@]} package(s) with tests:"
for pkg in "${PACKAGES[@]}"; do
  echo "  - $pkg"
done
echo ""

# Run tests one package at a time so a failure aborts cleanly and the
# offending package is the last thing on the screen — no scroll-back to
# hunt for which workspace failed.
for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🧪 Testing $pkg..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if ! npm run test -w "$pkg"; then
    echo ""
    echo "❌ Tests failed in $pkg — aborting."
    echo "   Re-run individually with:  npm run test -w $pkg"
    exit 1
  fi
done

echo ""
echo "✅ All package tests passed"
