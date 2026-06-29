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

# Packages this plain-tsc loop cannot check, by basename. nebula-studio-ui is a Vue
# SFC app: plain tsc can't resolve `.vue`, and vue-tsc can't either without the
# Cloudflare Workers type env (its @lumenize/* imports transitively pull DO source
# referencing DurableObjectState/ctx/env/Env). Its own `vite build` validates it; it
# is not gated here. Revisit if @lumenize/nebula gains browser-type-safe entries.
SKIP_PACKAGES=("nebula-studio-ui")

# Find all packages with tsconfig.json
for tsconfig in packages/*/tsconfig.json apps/*/tsconfig.json tooling/*/tsconfig.json; do
  pkg_dir="$(dirname "$tsconfig")"
  pkg_name="$(basename "$pkg_dir")"

  echo -n "  $pkg_name... "

  skip=false
  for s in "${SKIP_PACKAGES[@]}"; do
    [ "$pkg_name" = "$s" ] && skip=true && break
  done
  if [ "$skip" = true ]; then
    echo "skipped (not plain-tsc checkable)"
    continue
  fi

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
