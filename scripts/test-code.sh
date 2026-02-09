#!/usr/bin/env bash
set -e

# Run tests for all packages in packages/ that have a test script
# Auto-discovers packages - no need to maintain an explicit list

echo "🧪 Running package tests..."

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Find all packages with test scripts
PACKAGES=()
for pkg_json in packages/*/package.json; do
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

# Build npm workspace args
WORKSPACE_ARGS=""
for pkg in "${PACKAGES[@]}"; do
  WORKSPACE_ARGS="$WORKSPACE_ARGS -w $pkg"
done

# Run tests
npm run test $WORKSPACE_ARGS
