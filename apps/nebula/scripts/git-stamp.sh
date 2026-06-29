# shellcheck shell=bash
# git-stamp.sh — the SINGLE canonical home for the deploy build-stamp compute + the nested
# Wrangler `--define` escaping (Phase 1/2, tasks/nebula-release-process.md).
#
# SOURCE it (don't exec) from a bash context, BEFORE any build/bundle step touches the tree, so
# a clean checkout never stamps `dirty`:
#
#     source "$(dirname "$0")/git-stamp.sh"
#     wrangler deploy ... "${WRANGLER_DEFINE_ARGS[@]}"
#
# Both deploy.sh (prod) and the `deploy:test-worker` npm script source this, so the two deploys
# bake the SAME stamp shape into their two separately-bundled workers. Never re-type the nested
# escaping inline anywhere else (Phase 1 forbids it).

GIT_SHA="$(git rev-parse HEAD)"
if [ -z "$(git status --porcelain)" ]; then DIRTY="clean"; else DIRTY="dirty"; fi
BUILD_TIME="$(date -u +%FT%TZ)"

# Wrangler/esbuild `--define KEY:VALUE` does TEXTUAL identifier replacement, so each VALUE must be
# a quoted JS string LITERAL: the inner \"...\" makes `__GIT_SHA__` substitute to `"abc123"` (a JS
# string), not the bare token `abc123` (an undefined identifier that would ReferenceError at
# request time). Passed as an array so each `--define` flag + its value is one argv element.
WRANGLER_DEFINE_ARGS=(
  --define "__GIT_SHA__:\"$GIT_SHA\""
  --define "__DIRTY__:\"$DIRTY\""
  --define "__BUILD_TIME__:\"$BUILD_TIME\""
)
