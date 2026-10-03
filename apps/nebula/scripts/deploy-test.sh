#!/usr/bin/env bash
#
# apps/nebula/scripts/deploy-test.sh — deploy the app under a TEST worker name, on its own domain
# `lumenize-test.dev`, so the deploy-only properties can actually be exercised. It deploys from a
# GENERATED config, `scripts/test-deploy-config.mjs`, which swaps every value that would otherwise
# reach production — routes, origin, the refresh-token KV namespace, the self-referencing service
# bindings, the blob bucket and the certificate zone — and the email-provider var; everything else cannot drift from the
# real config because it is derived from it at run time.
#
# WHY THIS EXISTS: the DEPLOYED PASS (live.md § *Two venues, one registry*). Local
# `wrangler dev` + Docker runs the full scenario contract, container builds included
# (corrected 2026-08-29 — "a real build cannot succeed locally" was the root-level VFS
# seeding bug), so this script is NOT the only road to the mount. What it alone can
# exercise is the deploy-only failure class: the startup CPU limit (error 10021),
# custom-domain claiming, image-rollout/propagation skew, real kernel FUSE (local has
# no `/dev/fuse`; computerd materializes the subtree instead), persist-before-abort,
# and the stuck-flag race. Run it at milestones and after container/vendor/toolchain
# changes — not in the inner loop.
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
# CERTIFICATE_API_TOKEN too, from the token .dev.vars keeps as TEST_CERTIFICATE_API_TOKEN, scoped to
# the test zone's SSL and Certificates, with which the test galaxies order and delete their packs:
#   V=$(grep "^TEST_CERTIFICATE_API_TOKEN=" .dev.vars | sed 's/^[^=]*=//; s/^"//; s/"$//')
#   printf '%s' "$V" | wrangler secret put CERTIFICATE_API_TOKEN --name test-nebula
# The 2026-08-28 deploy blockers are both FIXED (first successful deploy 2026-08-29):
#   1. `kv_namespaces` carried a placeholder id (`code: 10042`) — a real namespace is
#      provisioned and wrangler.jsonc names it.
#   2. `Script startup exceeded CPU time limit [code: 10021]` — the two compilers (tsc
#      ~9 MB + @vue/compiler-sfc) did their table-building at module scope. They left
#      the Worker for the container build job (tasks/archive/nebula-move-compilers-out-of-the-worker.md);
#      the bundle went 12,957 → ~2,343 KiB, and `scripts/check-worker-graph.mjs` (in the
#      package `test` script) reds if a compiler import ever reaches the entry graph again.
#
# ⚠️ CUSTOM DOMAINS ARE EXCLUSIVE: a deploy under ANY name claims every route in its config, and
# the first successful test deploy (2026-08-29) STOLE `nebula.lumenize.com` from prod until an
# API PUT re-attached it. The generated config carries `lumenize-test.dev`'s routes instead. It
# sits BESIDE wrangler.jsonc so every relative path (main, container image, assets, .dev.vars)
# resolves identically.
#
# ⚠️ THE TEST TARGET'S OWN REFRESH-TOKEN NAMESPACE, by id, from the root `.dev.vars` as
# `TEST_REFRESH_TOKEN_KV_ID` — the script refuses to run without it, since `wrangler.jsonc`
# names production's.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

WORKER_NAME="${TEST_WORKER_NAME:-test-nebula}"

# The test target's own KV namespace — checked before anything builds.
TEST_KV_ID="$(grep '^TEST_REFRESH_TOKEN_KV_ID=' "$APP_DIR/../../.dev.vars" 2>/dev/null | sed 's/^[^=]*=//; s/^"//; s/"$//' || true)"
if [ -z "$TEST_KV_ID" ]; then
  echo "❌ No TEST_REFRESH_TOKEN_KV_ID in the root .dev.vars." >&2
  echo "   The test target needs a refresh-token KV namespace of its own; wrangler.jsonc names production's." >&2
  exit 1
fi
# The test zone's id, where its galaxies' certificate packs are ordered.
TEST_ZONE_ID="$(grep '^TEST_CERTIFICATE_ZONE_ID=' "$APP_DIR/../../.dev.vars" 2>/dev/null | sed 's/^[^=]*=//; s/^"//; s/"$//' || true)"
if [ -z "$TEST_ZONE_ID" ]; then
  echo "❌ No TEST_CERTIFICATE_ZONE_ID in the root .dev.vars: the test zone's id, for its certificate packs." >&2
  exit 1
fi

# shellcheck source=git-stamp.sh
source "$SCRIPT_DIR/git-stamp.sh"
echo "▸ Deploying TEST worker '${WORKER_NAME}' @ ${GIT_SHA} (${DIRTY} tree)"

echo "▸ Preflight: migrations / DO-class consistency (one-way door — same gate as prod)"
node "$SCRIPT_DIR/audit-migrations.mjs"

echo "▸ Preflight: required secrets on '${WORKER_NAME}'"
SECRET_LIST="$(wrangler secret list --name "$WORKER_NAME" 2>/dev/null || echo '[]')"
# The list is scripts/required-secrets.mjs's, shared with deploy.sh: an https origin also needs
# CERTIFICATE_API_TOKEN, for the test zone's certificate packs.
TEST_ORIGIN="$(node -e "import('$SCRIPT_DIR/test-deploy-config.mjs').then((m) => console.log(m.TEST_ORIGIN))")"
if ! node "$SCRIPT_DIR/required-secrets.mjs" "$TEST_ORIGIN" "$SECRET_LIST"; then
  echo "   Set each on '${WORKER_NAME}' from the gitignored root .dev.vars (see this script's header)." >&2
  exit 1
fi

echo "▸ Building the Studio SPA (vite build → ../nebula-studio-ui/dist)"
( cd ../nebula-studio-ui && npm run build )

# The test target's config (see the header): every value that would reach production, swapped.
TEST_CONFIG="$APP_DIR/.wrangler-deploy-test.jsonc"
node "$SCRIPT_DIR/test-deploy-config.mjs" "$WORKER_NAME" "$TEST_KV_ID" "$TEST_CONFIG" "$TEST_ZONE_ID"
trap 'rm -f "$TEST_CONFIG"' EXIT

echo "▸ R2: the test worker's blob bucket (create-if-missing)"
wrangler r2 bucket list 2>/dev/null | grep -qE 'nebula-blobs-test(\s|$)' || wrangler r2 bucket create nebula-blobs-test
echo "▸ wrangler deploy --config .wrangler-deploy-test.jsonc --name ${WORKER_NAME} (worker bundle + build-box image; lumenize-test.dev routes)"
wrangler deploy --config "$TEST_CONFIG" --name "$WORKER_NAME" --var EMAIL_PROVIDER:resend "${WRANGLER_DEFINE_ARGS[@]}"

# The self-check reads the platform host, the one host every deployment has.
TEST_URL="https://platform.lumenize-test.dev"

echo "▸ Self-check: GET ${TEST_URL}/_version?sha=${GIT_SHA}"
VERSION_JSON="$(curl -fsS "${TEST_URL}/_version?sha=${GIT_SHA}" || true)"
case "$VERSION_JSON" in
  *'"match":true'*) echo "✅ Test worker live and matches HEAD: ${TEST_URL}" ;;
  *) echo "❌ Self-check failed — ${VERSION_JSON:-no response}" >&2; exit 1 ;;
esac

echo ""
echo "▸ Drive the scenario registry against it (the deployed pass — live.md § Two venues, one registry):"
echo "    HARNESS_TARGET_URL=${TEST_URL} npx tsx apps/nebula/harness/drive.ts build-box"
