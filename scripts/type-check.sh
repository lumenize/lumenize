#!/usr/bin/env bash
set -e

# Type-check all packages with their individual tsconfigs
# This handles cloudflare:test imports correctly since each package
# has its own tsconfig that includes cloudflare-test-env.d.ts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Regenerate every Worker's `Env` first. The generated `worker-configuration.d.ts` files under
# packages/ are gitignored, so nothing else refreshes them, and a stale one types a binding its
# Worker gained as nothing: `rawRpcStub` on it answers `never`, and code that no longer compiles
# against its Worker passes here. Three errors hid that way through a build (2026-10-08).
echo "⚙️  Regenerating Worker types..."
types_log="$(mktemp)"
if ! "$SCRIPT_DIR/generate-types.sh" > "$types_log" 2>&1; then
  cat "$types_log"
  rm -f "$types_log"
  echo "❌ Type generation failed; the check below would read stale types"
  exit 1
fi
rm -f "$types_log"
echo ""

echo "🔍 Type-checking packages..."
echo ""

errors=0

# fetch is out of the run: it is built on Mesh's pre-2026-10-08 bases (LumenizeDO, LumenizeWorker)
# and nobody runs it in production; its suites are kept, never deleted, for a streaming revival
# (packages/fetch/README.md).
SKIP_PACKAGES=("fetch")

# Find all packages with tsconfig.json. apps/nebula/harness and apps/nebula/container/compiler
# are nested standalone configs (plain-Node type envs — the live self-verification harness and
# the container build job) — listed explicitly since the `apps/*/tsconfig.json` glob doesn't
# reach them.
for tsconfig in packages/*/tsconfig.json apps/*/tsconfig.json apps/nebula/harness/tsconfig.json apps/nebula/container/compiler/tsconfig.json tooling/*/tsconfig.json; do
  pkg_dir="$(dirname "$tsconfig")"
  pkg_name="$(basename "$pkg_dir")"

  echo -n "  $pkg_name... "

  skip=false
  for s in "${SKIP_PACKAGES[@]}"; do
    [ "$pkg_name" = "$s" ] && skip=true && break
  done
  if [ "$skip" = true ]; then
    echo "skipped"
    continue
  fi

  # A package that declares vue-tsc has `.vue` files, which plain tsc cannot read, so it is checked
  # with vue-tsc. Vite strips types without checking them, so nothing else catches an error there.
  # nebula-studio-ui is the one today: its tsconfig includes apps/nebula's worker-configuration.d.ts,
  # regenerated above, because its imports reach Durable Object source that needs the Workers types.
  checker=tsc
  grep -q '"vue-tsc"' "$pkg_dir/package.json" 2>/dev/null && checker=vue-tsc

  if npx "$checker" --noEmit -p "$tsconfig" 2>/dev/null; then
    echo "✓"
  else
    echo "✗"
    echo ""
    echo "  Errors in $pkg_name:"
    npx "$checker" --noEmit -p "$tsconfig" 2>&1 | sed 's/^/    /'
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
