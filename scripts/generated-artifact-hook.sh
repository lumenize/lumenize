#!/usr/bin/env bash
# PostToolUse hook: after a Write/Edit to a GENERATOR'S INPUT, re-run that generator's
# --check and report if the committed artifact is now stale. Silent when the edit touched
# nothing generated, so the cost is zero on ordinary work.
#
# Why a hook AND the checks in the test scripts / CI — they cover DISJOINT failure modes,
# not the same one three times:
#   - this hook          → an EDIT to a generator input; fires on the action, immediately
#   - `--check` in a package's `test` script → staleness from ANY cause at test time,
#     including a dependency bump, which touches no watched path and so is invisible here
#   - CI                 → the authority; the only layer that does not depend on local
#     state or on anyone reading a report
#
# Report, never block: matches scripts/prose-hook.sh and the warn-and-proceed stance in
# .claude/rules/ui-theming.md.
set -euo pipefail

path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
[ -n "$path" ] || exit 0

root=$(git -C "$(dirname "$path")" rev-parse --show-toplevel 2>/dev/null || echo .)
cd "$root"
rel=${path#"$root"/}

# Walk up from a directory to the nearest node_modules/.bin/wrangler and echo its ABSOLUTE
# path. Lifted from scripts/generate-types.sh, whose header explains why the absolute path
# is load-bearing: `npm run` seeds PATH with RELATIVE entries, bash caches the resolved
# command by that literal string, and it then re-resolves against a different cwd → exit
# 127 reported as a types failure for a target that is fine.
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

case "$rel" in
  # The tsc/typia deps bundle. Inputs are the stub shims and the bundler script itself —
  # NOT just the dependency versions, which is why its check rebuilds rather than stamps.
  packages/ts-runtime-parser-validator/scripts/*)
    exec node packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs --check
    ;;

  # The framework scaffold embedded into src/scaffold-seed.ts.
  apps/nebula/container/app/*)
    exec node apps/nebula/scripts/gen-scaffold.mjs --check
    ;;

  # The committed worker-configuration.d.ts beside each wrangler.jsonc. Scoped to
  # packages/ + apps/ for the same reason generate-types.sh is: experiments/ are
  # point-in-time spikes we explicitly do not maintain (workflow.md § Experiments), so a
  # stale one must not nag on every edit.
  #
  # `wrangler types --check` is the native primitive and it does detect drift (verified
  # 2026-08-28: exit 1 on an added var). ⚠️ Verify any future claim about it with a probe
  # that lands INSIDE the existing "vars" block — a duplicate top-level "vars" key is
  # silently overridden by the later one, so such a probe changes nothing and makes both
  # this check and a regenerate-and-diff look blind when neither is.
  packages/*/wrangler.jsonc|apps/*/wrangler.jsonc|packages/*/**/wrangler.jsonc|apps/*/**/wrangler.jsonc)
    dir=$(dirname "$rel")
    if wrangler_bin=$(find_wrangler "$root/$dir"); then
      cd "$root/$dir" && exec "$wrangler_bin" types --check
    fi
    exit 0
    ;;

  *) exit 0 ;;
esac
