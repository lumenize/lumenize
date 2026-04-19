#!/usr/bin/env bash
set -e

# Run coverage for all packages/* and apps/* that define a "coverage" script.
# Deliberately skips tooling/* (no coverage scripts) and doc-test/*/* (those measure
# coverage of the test code itself, not the package under test — useless signal).

echo "📊 Running package coverage..."

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PACKAGES=()
for pkg_json in packages/*/package.json apps/*/package.json; do
  if [ -f "$pkg_json" ]; then
    if node -e "const pkg = require('./$pkg_json'); process.exit(pkg.scripts?.coverage ? 0 : 1);" 2>/dev/null; then
      pkg_name=$(node -e "console.log(require('./$pkg_json').name)")
      PACKAGES+=("$pkg_name")
    fi
  fi
done

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No packages with coverage scripts found in packages/ or apps/"
  exit 1
fi

echo "Found ${#PACKAGES[@]} package(s) with coverage:"
for pkg in "${PACKAGES[@]}"; do
  echo "  - $pkg"
done
echo ""

WORKSPACE_ARGS=""
for pkg in "${PACKAGES[@]}"; do
  WORKSPACE_ARGS="$WORKSPACE_ARGS -w $pkg"
done

npm run coverage $WORKSPACE_ARGS
