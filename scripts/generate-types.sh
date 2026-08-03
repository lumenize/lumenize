#!/usr/bin/env bash
set -euo pipefail

# Generate TypeScript types for all wrangler.jsonc files in packages/ and apps/
# Each wrangler.jsonc gets a worker-configuration.d.ts generated alongside it.
#
# ⚠️ Invoke wrangler by ABSOLUTE path — never bare `wrangler` from PATH.
# `npm run` seeds PATH with RELATIVE entries (`./node_modules/.bin`,
# `../node_modules/.bin`, `../../node_modules/.bin`, …) and bash caches a resolved
# command in its hash table by that literal relative string. This loop visits
# directories at differing depths, so the entry hashed in the first directory
# re-resolves against every later cwd and lands somewhere that has no wrangler —
# exit 127, reported as "failed to generate types" for a target that is perfectly
# fine. That is not hypothetical: it silently mis-reported 27 of 33 targets as
# failures while `wrangler types` run directly in the very same directories exited
# 0 and wrote correct output (diagnosed 2026-08-03). Resolving the nearest
# node_modules/.bin/wrangler to an absolute path deletes the whole class — and
# `hash -r` would only paper over it, since the relative-PATH entries remain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Generating TypeScript types from wrangler.jsonc files..."
echo ""

# Walk up from a wrangler.jsonc's directory to the nearest node_modules/.bin/wrangler
# and echo its absolute path. Empty output = no wrangler reachable (a real setup
# failure, not a types failure — reported distinctly below).
find_wrangler() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -x "$dir/node_modules/.bin/wrangler" ]; then
      echo "$dir/node_modules/.bin/wrangler"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

failed=()
generated=0

# The find scope below is DELIBERATELY packages/ + apps/ only. Do NOT widen it to
# `experiments/`: experiments are point-in-time spikes we explicitly do not maintain
# (workflow.md § Experiments), so a stale one would now fail the whole run — and
# `npm run types` is a mandatory pre-code step (critical.md), so that would block real
# work over a spike nobody intends to fix. `tooling/` (email-test, test-endpoints) DOES
# hold live workspaces with wrangler configs and is a genuine open question — decide it
# deliberately rather than by widening the glob.
while IFS= read -r wrangler_file; do
  wrangler_dir="$(dirname "$wrangler_file")"
  abs_dir="$PROJECT_ROOT/$wrangler_dir"

  echo "📦 $wrangler_dir"

  if ! wrangler_bin="$(find_wrangler "$abs_dir")"; then
    echo "   ✗ No wrangler binary found in any ancestor node_modules/.bin"
    failed+=("$wrangler_dir (no wrangler binary)")
    echo ""
    continue
  fi

  # Capture output so a success stays quiet but a REAL failure shows its reason.
  # Subshell cd: wrangler resolves its config relative to cwd, and this keeps the
  # loop's own cwd pinned to PROJECT_ROOT.
  out_file="$(mktemp)"
  if (cd "$abs_dir" && "$wrangler_bin" types) > "$out_file" 2>&1; then
    echo "   ✓ Types generated"
    generated=$((generated + 1))
  else
    status=$?
    echo "   ✗ Failed to generate types (wrangler exit $status)"
    sed 's/^/     │ /' < "$out_file" | tail -20
    failed+=("$wrangler_dir (exit $status)")
  fi
  rm -f "$out_file"

  echo ""
done < <(find packages apps -name "wrangler.jsonc" -not -path "*/node_modules/*" -not -path "*/dist/*")

if [ ${#failed[@]} -gt 0 ]; then
  echo "❌ Type generation FAILED for ${#failed[@]} target(s):"
  for f in "${failed[@]}"; do echo "   - $f"; done
  echo ""
  echo "   worker-configuration.d.ts for the above is missing or STALE."
  echo "   Code typed against the generated global \`Env\` cannot be trusted until this passes."
  exit 1
fi

echo "✅ Type generation complete — $generated target(s)"
