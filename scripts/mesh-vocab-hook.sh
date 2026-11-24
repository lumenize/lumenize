#!/usr/bin/env bash
# PostToolUse hook: after a Write/Edit, report any line THIS EDIT ADDED that calls a
# `@mesh()`-decorated method or getter "marked". Regression-only against HEAD, like
# scripts/prose-hook.sh, so a file with old hits is silent until an edit adds one.
# Report, never block. See scripts/check-mesh-vocab.mjs for what counts.
set -euo pipefail
path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
[ -n "$path" ] || exit 0
case "$path" in
  *.md|*.mdx|*.ts|*.vue) ;;
  *) exit 0 ;;
esac
root=$(git -C "$(dirname "$path")" rev-parse --show-toplevel 2>/dev/null || echo .)
cd "$root"
exec node scripts/check-mesh-vocab.mjs --regression "${path#"$root"/}"
