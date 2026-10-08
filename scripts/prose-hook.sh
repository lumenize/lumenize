#!/usr/bin/env bash
# PostToolUse hook: after a Write/Edit to a governed prose file, report any prose-voice
# budget THIS EDIT MADE WORSE. Regression-only against HEAD, which is what makes the wide
# scope safe: an edit that degrades nothing is silent, so the frequently-edited surfaces
# cost nothing until they actually drift. tasks/archive is excluded (frozen).
# See .claude/rules/prose-voice.md.
set -euo pipefail
path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
[ -n "$path" ] || exit 0
case "$path" in
  */tasks/archive/*|*/tasks/icebox/*|*/tasks/nightly/*) exit 0 ;;
  */docs/adr/*.md|*/docs/vision/*.md|*/tasks/*.md|*/.claude/rules/*.md|*/.claude/skills/*.md) ;;
  *) exit 0 ;;
esac
cd "$(git -C "$(dirname "$path")" rev-parse --show-toplevel 2>/dev/null || echo .)"
exec node scripts/check-prose.mjs --regression "$path"
