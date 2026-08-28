#!/usr/bin/env bash
#
# apps/nebula/scripts/deploy-test.sh — deploy the app under a TEST worker name, so the
# deploy-only properties can actually be exercised. It reuses `wrangler.jsonc` verbatim
# and overrides only `--name`, so the test target cannot drift from the real one.
#
# WHY THIS EXISTS: local `wrangler dev` never passes `/dev/fuse` to the container it
# starts (verified 2026-08-28 by `docker inspect` on the running box: `Devices=null`,
# `CapAdd=null`, `Privileged=false`; unchanged in wrangler 4.127, and `@cloudflare/computer`
# exposes no FUSE surface at all). So `computerd`'s `FUSE_MOUNT=auto` falls back to a
# userspace shim and a real build cannot succeed locally. Anything that needs the mount —
# a real `vite build`, `dist` surviving a redeploy — is reachable ONLY deployed.
#
#   npm run deploy:test                      # deploys `test-nebula`
#   TEST_WORKER_NAME=test-nebula-foo npm run deploy:test
#
# ⚠️ STATE SURVIVES A REDEPLOY, and there is no way to drop it from the CLI: there is still
# no `wrangler durable-objects` command (checked on 4.111 AND 4.127), and `wrangler delete`
# leaves DO namespaces ORPHANED — only a DASHBOARD project-delete removes them
# ([[wrangler-delete-leaves-do-data]]). That is why this defaults to ONE stable name
# instead of a fresh `test-nebula-{uuid}` per run: unique names would strand a namespace
# set per run, each needing its own manual dashboard delete. Scenarios provision fresh
# scopes per run, so accumulated state does not collide — and when a clean slate IS wanted
# (a DO schema change, say), it costs exactly one dashboard delete of this one worker.
#
# ⚠️ SECRETS ARE PER-WORKER. A fresh test worker has none, so login mints nothing and the
# SPA bounces. Set them from the gitignored root `.dev.vars` — never echo a value:
#   for s in NEBULA_AUTH_BOOTSTRAP_EMAIL JWT_PRIVATE_KEY_BLUE JWT_PUBLIC_KEY_BLUE RESEND_API_KEY; do
#     V=$(grep "^$s=" .dev.vars | sed 's/^[^=]*=//; s/^"//; s/"$//')
#     printf '%b' "$V" | wrangler secret put "$s" --name test-nebula
#   done
# (The `%b` + quote-strip is load-bearing for the multi-line PEM keys — see deploy.sh.)
# ⚠️ BLOCKED AS OF 2026-08-28 — this script is correct, the WORKER will not deploy. Two
# blockers surfaced on the first deploy attempt since 2026-07-04, both invisible until
# someone tried:
#   1. ✅ FIXED — `kv_namespaces` carried a literal `REPLACE_WITH_REAL_KV_NAMESPACE_ID_AT_PHASE_4`,
#      so EVERY deploy died on `KV namespace ... is not valid [code: 10042]`. A real
#      namespace is provisioned and wrangler.jsonc now names it.
#   2. OPEN — `Script startup exceeded CPU time limit [code: 10021]`. The bundle is
#      12,957 KiB and its startup profile is the work-at-import signature `workflow.md`
#      describes: ~25% GC, ~45% anonymous top-level init, 4.3% in `__name` wrappers. It
#      stacks the pre-bundled tsc (~9 MB of chunks) with the collapse's computer/VFS/git
#      stack (`@platformatic/vfs`, `pako`, `isomorphic-git`, `capnweb`). A DO pays for its
#      whole Worker's import graph, so subpaths do not help while the importers share a
#      Worker. Tracked in `tasks/backlog.md`; until it is fixed nothing deploys — prod
#      included.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

WORKER_NAME="${TEST_WORKER_NAME:-test-nebula}"

# shellcheck source=git-stamp.sh
source "$SCRIPT_DIR/git-stamp.sh"
echo "▸ Deploying TEST worker '${WORKER_NAME}' @ ${GIT_SHA} (${DIRTY} tree)"

echo "▸ Preflight: migrations / DO-class consistency (one-way door — same gate as prod)"
node "$SCRIPT_DIR/audit-migrations.mjs"

echo "▸ Preflight: required secrets on '${WORKER_NAME}'"
SECRET_LIST="$(wrangler secret list --name "$WORKER_NAME" 2>/dev/null || echo '[]')"
MISSING=()
for s in NEBULA_AUTH_BOOTSTRAP_EMAIL JWT_PRIVATE_KEY_BLUE JWT_PUBLIC_KEY_BLUE RESEND_API_KEY; do
  printf '%s' "$SECRET_LIST" | grep -q "\"$s\"" || MISSING+=("$s")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ Missing secrets on '${WORKER_NAME}': ${MISSING[*]}" >&2
  echo "   Set each from the gitignored root .dev.vars (see this script's header)." >&2
  exit 1
fi

echo "▸ Building the Studio SPA (vite build → ../nebula-studio-ui/dist)"
( cd ../nebula-studio-ui && npx vite build )

echo "▸ wrangler deploy --name ${WORKER_NAME} (worker bundle + build-box image)"
DEPLOY_LOG="$(mktemp)"
wrangler deploy --name "$WORKER_NAME" --var EMAIL_PROVIDER:resend "${WRANGLER_DEFINE_ARGS[@]}" 2>&1 | tee "$DEPLOY_LOG"

TEST_URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | head -1)"
rm -f "$DEPLOY_LOG"
if [ -z "$TEST_URL" ]; then
  echo "❌ Could not read the deployed URL from wrangler's output." >&2
  exit 1
fi

echo "▸ Self-check: GET ${TEST_URL}/_version?sha=${GIT_SHA}"
VERSION_JSON="$(curl -fsS "${TEST_URL}/_version?sha=${GIT_SHA}" || true)"
case "$VERSION_JSON" in
  *'"match":true'*) echo "✅ Test worker live and matches HEAD: ${TEST_URL}" ;;
  *) echo "❌ Self-check failed — ${VERSION_JSON:-no response}" >&2; exit 1 ;;
esac

echo ""
echo "▸ Drive the deploy-only scenarios against it:"
echo "    HARNESS_TARGET_URL=${TEST_URL} npx tsx apps/nebula/harness/drive.ts build-box"
