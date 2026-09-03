#!/usr/bin/env bash
#
# apps/nebula/scripts/deploy-test.sh — deploy the app under a TEST worker name, so the
# deploy-only properties can actually be exercised. It deploys from a GENERATED config
# that is `wrangler.jsonc` minus `routes` (custom domains are exclusive — see the ⚠️
# below), overriding `--name` and the email-provider var; everything else cannot drift
# from the real config because it is derived from it at run time.
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
# The 2026-08-28 deploy blockers are both FIXED (first successful deploy 2026-08-29):
#   1. `kv_namespaces` carried a placeholder id (`code: 10042`) — a real namespace is
#      provisioned and wrangler.jsonc names it.
#   2. `Script startup exceeded CPU time limit [code: 10021]` — the two compilers (tsc
#      ~9 MB + @vue/compiler-sfc) did their table-building at module scope. They left
#      the Worker for the container build job (tasks/archive/nebula-move-compilers-out-of-the-worker.md);
#      the bundle went 12,957 → ~2,343 KiB, and `scripts/check-worker-graph.mjs` (in the
#      package `test` script) reds if a compiler import ever reaches the entry graph again.
#
# ⚠️ CUSTOM DOMAINS ARE EXCLUSIVE, so this deploys from a GENERATED config that is the
# real one minus `routes`: a deploy under ANY name claims every route in its config, and
# the first successful test deploy (2026-08-29) STOLE `nebula.lumenize.com` from prod
# until an API PUT re-attached it. The generated file sits BESIDE wrangler.jsonc so every
# relative path (main, container image, assets, .dev.vars) resolves identically; only
# `routes` differs, which is exactly the field that MUST differ.
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

# The routes-stripped config (see the header: custom domains are exclusive, and a test
# deploy must never claim prod's). A real JSONC state machine, not a regex — the config's
# strings contain `//` (URLs), which a naive comment strip would truncate.
TEST_CONFIG="$APP_DIR/.wrangler-deploy-test.jsonc"
node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "\"") { // string — copy verbatim through the closing quote
      out += c; i++;
      while (i < src.length && src[i] !== "\"") { out += src[i]; if (src[i] === "\\") { out += src[i + 1]; i++; } i++; }
      out += src[i]; i++;
    } else if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; }
    else { out += c; i++; }
  }
  const cfg = JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
  delete cfg.routes; // the FIRST deliberate difference from the real config
  // …and the second: the test worker gets its own blob bucket, so a test run never writes into prod's.
  for (const b of cfg.r2_buckets ?? []) if (b.bucket_name === "nebula-blobs") b.bucket_name = "nebula-blobs-test";
  fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2) + "\n");
' "$APP_DIR/wrangler.jsonc" "$TEST_CONFIG"
trap 'rm -f "$TEST_CONFIG"' EXIT

echo "▸ R2: the test worker's blob bucket (create-if-missing)"
wrangler r2 bucket list 2>/dev/null | grep -qE 'nebula-blobs-test(\s|$)' || wrangler r2 bucket create nebula-blobs-test
echo "▸ wrangler deploy --config .wrangler-deploy-test.jsonc --name ${WORKER_NAME} (worker bundle + build-box image; NO routes)"
DEPLOY_LOG="$(mktemp)"
wrangler deploy --config "$TEST_CONFIG" --name "$WORKER_NAME" --var EMAIL_PROVIDER:resend "${WRANGLER_DEFINE_ARGS[@]}" 2>&1 | tee "$DEPLOY_LOG"

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
echo "▸ Drive the scenario registry against it (the deployed pass — live.md § Two venues, one registry):"
echo "    HARNESS_TARGET_URL=${TEST_URL} npx tsx apps/nebula/harness/drive.ts build-box"
