#!/usr/bin/env bash
#
# apps/nebula/scripts/deploy.sh — the SINGLE home for the Nebula APP deploy (Phase 3,
# tasks/nebula-release-process.md). This is NOT the package publish: `scripts/release.sh` +
# Lerna publish the `@lumenize/*` packages and never touch Nebula (it's `private`). Nebula's
# real release is `wrangler deploy` (which also builds + pushes the DevContainer image), and
# this script is its single repeatable command. See RELEASING.md for which flow to run when.
#
# Pre-alpha runs from a laptop with Cloudflare WARP on + Docker Desktop running (the container
# image push needs both; cf-container-deploy-proxy). The headless/CI deploy is deferred
# (on-hold/nebula-release-hardening.md).
#
# Invoked via `npm run deploy` (apps/nebula) or `npm run deploy:nebula` (root).
set -euo pipefail

# Resolve the apps/nebula package dir regardless of the caller's CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

# The public origin for the post-deploy self-check. Defaults to the JWT-issuer domain
# (NEBULA_AUTH_ISSUER); override with NEBULA_PROD_URL for a workers.dev / custom-domain target.
PROD_URL="${NEBULA_PROD_URL:-https://nebula.lumenize.com}"

# 1. Compute the build stamp FIRST — before any build/bundle step mutates the tree, so a clean
#    checkout never stamps `dirty`. Sets GIT_SHA / DIRTY / BUILD_TIME / WRANGLER_DEFINE_ARGS.
#    (The nested `--define` escaping lives ONLY in git-stamp.sh — never re-typed inline.)
# shellcheck source=git-stamp.sh
source "$SCRIPT_DIR/git-stamp.sh"
echo "▸ Deploying nebula @ ${GIT_SHA} (${DIRTY} tree)"

# 2. Preflight gates — refuse BEFORE building (cheap to fix, expensive to half-deploy).
echo "▸ Preflight: migrations / DO-class consistency (one-way door)"
node "$SCRIPT_DIR/audit-migrations.mjs"   # exits non-zero on any inconsistency

echo "▸ Preflight: super-admin bootstrap secret is set"
# NAME-only check — `wrangler secret list` prints names, never values; never echo a secret.
if ! wrangler secret list 2>/dev/null | grep -q 'NEBULA_AUTH_BOOTSTRAP_EMAIL'; then
  echo "❌ NEBULA_AUTH_BOOTSTRAP_EMAIL is not set on the deployed worker." >&2
  echo "   The super-admin seed must exist before the first deploy:" >&2
  echo "     wrangler secret put NEBULA_AUTH_BOOTSTRAP_EMAIL   # then enter larry@lumenize.com" >&2
  exit 1
fi

# 3. Build the Studio SPA so the `assets` upload sees it. `dist` is gitignored AND its presence is
#    load-bearing: wrangler HARD-ERRORS if `assets.directory` is absent (an empty dir is fine, but a
#    deploy needs the REAL build). MUST precede `wrangler deploy`. NOT a wrangler `[build]` hook —
#    deploy.sh is the single deploy home.
echo "▸ Building the Studio SPA (vite build → ../nebula-studio-ui/dist)"
( cd ../nebula-studio-ui && npx vite build )

# Eyeball the magic-link from-address against the CF verified-senders list (B2). The code default
# `auth@nebula.lumenize.com` is NOT a verified CF sender — CF silently DROPS mail from it.
EMAIL_FROM=$(grep -oE '"AUTH_EMAIL_FROM"[[:space:]]*:[[:space:]]*"[^"]*"' wrangler.jsonc \
  | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' | head -1)
echo "▸ AUTH_EMAIL_FROM resolves to: ${EMAIL_FROM:-<UNSET — defaults to UNVERIFIED auth@nebula.lumenize.com; mail will silently drop>}"

# 4. Deploy (also builds + pushes the DevContainer image) with the build stamp from step 1.
#    NO `--dry-run` preflight — it HANGS on the full worker (0% CPU, >10 min; the heavy remote
#    bindings stall on account resolution). The vite-build → deploy → /_version self-check below
#    IS the validation path.
echo "▸ wrangler deploy (worker bundle + DevContainer image)"
wrangler deploy "${WRANGLER_DEFINE_ARGS[@]}"

# 5. Self-check the freshly-built worker is live AND serving the bytes we just built — the same
#    public compare endpoint (Phase 1). It discloses nothing, needs no admin token; a reply at all
#    = serving, and `match:true` = the bytes we just deployed (catches a stale cache / failed deploy).
echo "▸ Self-check: GET ${PROD_URL}/_version?sha=${GIT_SHA}"
VERSION_JSON="$(curl -fsS "${PROD_URL}/_version?sha=${GIT_SHA}" || true)"
if [ -z "$VERSION_JSON" ]; then
  echo "❌ Self-check: ${PROD_URL}/_version did not respond. Deploy may have failed, or DNS/cache isn't ready yet." >&2
  exit 1
fi
case "$VERSION_JSON" in
  *'"match":true'*) echo "✅ Deploy live and matches HEAD (${GIT_SHA}): ${VERSION_JSON}" ;;
  *) echo "❌ Self-check: deployed worker did NOT report match:true — ${VERSION_JSON}" >&2; exit 1 ;;
esac
