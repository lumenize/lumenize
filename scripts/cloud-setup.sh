#!/usr/bin/env bash
#
# Setup script for Claude Code on the web (the "Setup script" field of a cloud
# environment). Brings a fresh, secret-less cloud container to the point where
# `npm run test:code` can run the package suite — the same steps CI performs in
# .github/workflows/ci.yml (run-packages-tests-with-coverage), minus the
# Playwright chromium install (the `browser` project is omitted in this lane via
# LUMENIZE_NO_CF_REMOTE; see packages/mesh + packages/auth vitest configs).
#
# CONFIGURE THE ENVIRONMENT (claude.ai/code → environment selector → settings):
#   Environment variables (.env format, one KEY=value per line, NO quotes):
#     RESEND_API_KEY=re_...            # auth e2e-email-resend login email
#     TEST_TOKEN=...                   # gates the deployed @lumenize/test-endpoints worker (fetch suite)
#     LUMENIZE_NO_CF_REMOTE=1          # omits the Cloudflare-Email-Sending / remote-proxy projects
#                                      #   (auth e2e-email + hono, mesh browser) — they need a
#                                      #   CLOUDFLARE_API_TOKEN this lane deliberately does NOT carry.
#   Setup script field:
#     bash scripts/cloud-setup.sh
#
# Deliberately NOT here:
#   - CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — too powerful to expose as
#     plaintext env-config; LUMENIZE_NO_CF_REMOTE omits the projects that need them.
#   - `npm run types` — worker-configuration.d.ts files are committed and used as-is.
#   - chromium — only the (omitted) mesh `browser` project needs it.
#
# Notes:
#   - Runs as root on Ubuntu before Claude Code launches; its filesystem changes
#     are cached, so later sessions start with node_modules/.dev.vars/bundle ready.
#   - `set -e`: any failure aborts session start loudly (e.g. ci-write-dev-vars
#     hard-exits if RESEND_API_KEY / TEST_TOKEN are unset — a misconfigured
#     environment fails fast instead of silently running without its secrets).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "▸ [1/4] Reconstruct .dev.vars from environment secrets (+ ephemeral JWT keys)"
# Must run BEFORE `npm ci`: postinstall (setup-symlinks.sh) symlinks the root
# .dev.vars into every package/test dir that has a wrangler.jsonc.
node scripts/ci-write-dev-vars.mjs

echo "▸ [2/4] npm ci --no-optional (skip optional deps to avoid the Rollup arm64 lockfile bug)"
npm ci --no-optional

echo "▸ [3/4] Install the Linux x64 native bindings npm ci --no-optional stripped"
# The committed lockfile carries arm64 optional deps (maintainer is on Apple
# Silicon), so the x64 Rollup + SWC native binaries are absent on this x64 box.
# Re-add them explicitly; SWC's binding must match the installed @swc/core version.
npm install --no-save @rollup/rollup-linux-x64-gnu
npm install --no-save "@swc/core-linux-x64-gnu@$(node -p 'require("@swc/core/package.json").version')"

echo "▸ [4/4] Build the gitignored ts-runtime-parser-validator dist bundle"
# dist/deps.bundle.mjs (typia + typescript) is gitignored and not produced by
# npm ci, so that package's tests fail with "Cannot find module ../dist/deps.bundle.mjs".
npm run bundle -w @lumenize/ts-runtime-parser-validator

echo "✅ cloud-setup complete — run:  npm run test:code"
