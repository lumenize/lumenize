#!/usr/bin/env bash
#
# apps/nebula/scripts/deployed-sweep.sh — the whole scenario registry against `test-nebula`, deployed
# from what is COMMITTED. Meant for a night with no build running (Larry, 2026-10-14):
#
#   bash apps/nebula/scripts/deployed-sweep.sh            # sweeps the `pre-alpha` head
#   bash apps/nebula/scripts/deployed-sweep.sh <ref>      # or any branch, tag or commit
#   bash apps/nebula/scripts/deployed-sweep.sh --force    # even when another drive.ts is running
#
# It keeps a checkout of its own beside this one, `../lumenize-deployed-sweep`, detached at the ref
# and never written to, so the sweep tests exactly the commit and a session editing this checkout
# meanwhile changes nothing it runs. It deploys `test-nebula` from that checkout, runs
# `drive.ts all --concurrency=2` against it under `caffeinate`, then reads the target's Workers
# Issues since the run began. Everything it prints goes to
# `$TMPDIR/lumenize-deployed-sweep-<time>.log`, and `$TMPDIR/lumenize-deployed-sweep-latest.log`
# points at the newest, which is what the next morning's triage reads. A failed scenario's whole
# capture is a file of its own, named in that log.
#
# Why not on a build night: a build's close-out deploys `test-nebula` too, and a deploy in the middle
# of a sweep resets every object and mixes two versions' results. So it refuses while any other
# `drive.ts` runs, unless told `--force`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SWEEP_DIR="$(dirname "$REPO")/lumenize-deployed-sweep"
TARGET="https://platform.lumenize-test.dev"

REF="pre-alpha"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) echo "unknown flag $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done

# Stay awake for the whole run: a sleeping Mac reads as every scenario timing out at once.
if [ -z "${DEPLOYED_SWEEP_AWAKE:-}" ]; then
  export DEPLOYED_SWEEP_AWAKE=1
  exec caffeinate -i bash "$0" "$@"
fi

if [ "$FORCE" = 0 ] && pgrep -f 'harness/drive\.ts' >/dev/null; then
  echo "❌ another drive.ts is running (a build's scenarios?), and this would redeploy test-nebula under it." >&2
  echo "   pgrep -fl 'harness/drive.ts' shows which; pass --force to sweep anyway." >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="${TMPDIR:-/tmp}/lumenize-deployed-sweep-${STAMP}.log"
ln -sf "$LOG" "${TMPDIR:-/tmp}/lumenize-deployed-sweep-latest.log"
exec > >(tee "$LOG") 2>&1

SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SHA="$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")"
echo "▸ Deployed sweep of ${REF} @ ${SHA}, started ${SINCE}; this log: ${LOG}"

# The checkout: created once, then moved to the commit. Never cleaned, so node_modules survives.
if [ ! -d "$SWEEP_DIR/.git" ] && [ ! -f "$SWEEP_DIR/.git" ]; then
  git -C "$REPO" worktree prune   # a checkout deleted by hand is still registered until pruned
  git -C "$REPO" worktree add --detach "$SWEEP_DIR" "$SHA"
else
  git -C "$SWEEP_DIR" checkout --detach --force "$SHA"
fi
# Secrets stay in this checkout's gitignored .dev.vars; the sweep's postinstall links them onward.
ln -sf "$REPO/.dev.vars" "$SWEEP_DIR/.dev.vars"

cd "$SWEEP_DIR"
# Install only when the lockfile moved: `npm ci` takes minutes and starts from nothing.
LOCK_HASH="$(shasum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.deployed-sweep-lock 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  echo "▸ npm ci (the lockfile changed since the last sweep)"
  npm ci
  echo "$LOCK_HASH" > node_modules/.deployed-sweep-lock
fi

echo "▸ Deploying test-nebula from ${SHA}"
( cd apps/nebula && npm run deploy:test )

echo "▸ drive.ts all --concurrency=2 against ${TARGET}"
STATUS=0
( cd apps/nebula && HARNESS_TARGET_URL="$TARGET" npx tsx harness/drive.ts all --concurrency=2 ) || STATUS=$?

echo ""
echo "▸ Workers Issues on test-nebula since ${SINCE} (scope-deleted and the scanners' probes are standing):"
node scripts/issues.mjs --worker test-nebula --since "$SINCE" || true

echo ""
echo "▸ Done: ${REF} @ ${SHA}, sweep exit ${STATUS}. This log: ${LOG}"
exit "$STATUS"
