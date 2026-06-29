#!/usr/bin/env bash
#
# Setup script for Claude Code on the web (the "Setup script" field of a cloud
# environment). Brings a fresh, secret-less cloud container to the point where
# `npm run test:code` can run the package suite — the same steps CI performs in
# .github/workflows/ci.yml (run-packages-tests-with-coverage).
#
# It ALSO enables the apps/nebula `ui-smoke` lane (real Container + Workers-AI REST +
# magic-link login) when the optional ui-smoke vars below are configured: it installs
# the vite native binding (lightningcss) and starts the Docker daemon. The `.dev.vars`
# AI tokens flow through automatically (ci-write-dev-vars.mjs passes WORKERS_AI_TOKEN /
# CLOUDFLARE_ACCOUNT_ID when present). The hosted lane runs `wrangler dev --local`
# (remote bindings disabled — see test/ui-smoke/global-setup.ts), so it needs NO
# CLOUDFLARE_API_TOKEN. Chromium is pre-installed in the web image (PLAYWRIGHT_BROWSERS_PATH),
# which the lane's raw-Playwright driver uses — so no `playwright install` here.
#
# CONFIGURE THE ENVIRONMENT (claude.ai/code → environment selector → settings):
#   Environment variables (.env format, one KEY=value per line, NO quotes):
#     RESEND_API_KEY=re_...            # auth e2e-email-resend + nebula magic-link login email
#     TEST_TOKEN=...                   # gates the deployed @lumenize/test-endpoints worker (fetch suite)
#     LUMENIZE_NO_CF_REMOTE=1          # omits the Cloudflare-Email-Sending / remote-proxy projects
#                                      #   (auth e2e-email + hono, mesh browser) — they need a
#                                      #   CLOUDFLARE_API_TOKEN this lane deliberately does NOT carry.
#     # Optional — only to enable the apps/nebula ui-smoke lane (AI codegen turn):
#     WORKERS_AI_TOKEN=cfat_...        # scoped Account·Workers-AI·Read token (the only ui-smoke secret);
#                                      #   also the signal that this env is provisioned for ui-smoke.
#     CLOUDFLARE_ACCOUNT_ID=...        # non-secret identifier; the Workers-AI REST URL needs it.
#   Setup script field:
#     bash scripts/cloud-setup.sh
#
# Deliberately NOT here:
#   - CLOUDFLARE_API_TOKEN — too powerful to expose as plaintext env-config; the hosted
#     ui-smoke boot uses `wrangler dev --local` + Workers-AI REST instead, and
#     LUMENIZE_NO_CF_REMOTE omits the package projects that would need it.
#   - `npm run types` — worker-configuration.d.ts files are committed and used as-is.
#   - `playwright install` — chromium ships in the web image (do not re-fetch it).
#
# Notes:
#   - Runs as root on Ubuntu before Claude Code launches; its filesystem changes
#     are cached, so later sessions start with node_modules/.dev.vars/bundle ready.
#     The Docker daemon is a PROCESS, not a filesystem change, so it is NOT cached —
#     a warm session that skips this script comes up with no daemon (re-run `dockerd &`).
#   - `set -e`: any failure aborts session start loudly (e.g. ci-write-dev-vars
#     hard-exits if RESEND_API_KEY / TEST_TOKEN are unset — a misconfigured
#     environment fails fast instead of silently running without its secrets).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "▸ [1/2] Install deps + native bindings + bundle (shared scripts/ci-install.sh)"
# Same spine CI runs (.github/workflows/ci.yml, ui-smoke.yml) — single source so the
# install steps can't drift between lanes. --dev-vars reconstructs .dev.vars from the
# env secrets BEFORE npm ci; --lightningcss adds the vite binding the ui-smoke lane needs
# (harmless for the package suite); --bundle builds ts-runtime-parser-validator's dist.
# No --chromium: the web image pre-ships Chromium (PLAYWRIGHT_BROWSERS_PATH); the ui-smoke
# driver launches it via executablePath (test/ui-smoke/smoke.test.ts). No --cache-clean:
# the sandbox starts from a fresh image, not a shared runner cache.
bash scripts/ci-install.sh --dev-vars --lightningcss --bundle

echo "▸ [2/2] Start the Docker daemon for the apps/nebula ui-smoke lane (if configured)"
# The ui-smoke lane (`npx vitest run --project ui-smoke`) boots a real Cloudflare
# Container (DevContainer image) under `wrangler dev`, which needs a running Docker
# daemon — its gate is `docker info` (test/ui-smoke/gates.ts `HAS_DOCKER`). Docker is
# preinstalled in this image but the daemon is NOT auto-started (no systemd/PID-1 init
# here), so start `dockerd` directly. Gated on WORKERS_AI_TOKEN — the signal that this
# environment is provisioned for ui-smoke (its other gate, `HAS_AI_PATH`); package-only
# lanes skip the daemon entirely. Idempotent: skip if a daemon is already reachable.
# NOTE: this starts a PROCESS, not a filesystem change — unlike npm/.dev.vars above it is
# NOT preserved by the environment's setup-step caching, so a warm session that skips this
# script comes up with no daemon. If `docker info` fails mid-session, re-run `dockerd &`.
if [ -n "${WORKERS_AI_TOKEN:-}" ]; then
  if docker info >/dev/null 2>&1; then
    echo "   docker daemon already running — skipping"
  elif command -v dockerd >/dev/null 2>&1; then
    # setsid + </dev/null detaches dockerd into its own session so it survives this
    # setup shell exiting (more robust than a bare `nohup &` for the setup→session handoff).
    setsid dockerd >/tmp/dockerd.log 2>&1 </dev/null &
    for _ in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null 2>&1 \
      && echo "   docker daemon started ($(docker info --format '{{.ServerVersion}}'))" \
      || echo "   ⚠️  dockerd did not become ready — ui-smoke will skip (see /tmp/dockerd.log)"
  else
    echo "   ⚠️  dockerd not installed — ui-smoke will skip"
  fi
else
  echo "   WORKERS_AI_TOKEN unset — not an ui-smoke lane; skipping docker start"
fi

echo "✅ cloud-setup complete — run:  npm run test:code  (or, for the full Studio lane:  cd apps/nebula && npx vitest run --project ui-smoke)"
