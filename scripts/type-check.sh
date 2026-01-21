#!/usr/bin/env bash
set -e

# Type-check all packages with their individual tsconfigs
# This handles cloudflare:test imports correctly since each package
# has its own tsconfig that includes cloudflare-test-env.d.ts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "🔍 Type-checking packages..."
echo ""

errors=0

# Find all packages with tsconfig.json
for tsconfig in packages/*/tsconfig.json; do
  pkg_dir="$(dirname "$tsconfig")"
  pkg_name="$(basename "$pkg_dir")"

  echo -n "  $pkg_name... "

  if npx tsc --noEmit -p "$tsconfig" 2>/dev/null; then
    echo "✓"
  else
    echo "✗"
    echo ""
    echo "  Errors in $pkg_name:"
    npx tsc --noEmit -p "$tsconfig" 2>&1 | sed 's/^/    /'
    echo ""
    errors=$((errors + 1))
  fi
done

echo ""
if [ $errors -eq 0 ]; then
  echo "✅ All packages type-check successfully"
else
  echo "❌ $errors package(s) have type errors"
  exit 1
fi
