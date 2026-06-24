#!/usr/bin/env bash
#
# One-command Studio dev launcher — boots the two-process Studio dev loop in titled Terminal tabs.
#
#   Tab "Nebula Worker" → apps/nebula            `wrangler dev` (:8787) + the DevContainer (Docker Desktop)
#   Tab "Studio UI"     → apps/nebula-studio-ui  `vite` (:5174), same-origin proxy → the Worker
#   → then open http://localhost:5174 and click "Log in (dev)".
#
# Prereqs:
#   • macOS Accessibility permission for your terminal (ttab drives Terminal.app / iTerm via AppleScript):
#       System Settings ▸ Privacy & Security ▸ Accessibility → enable Terminal.app / iTerm.app.
#   • Docker Desktop running (`docker context use desktop-linux`) — the Worker tab needs it for the DevContainer.
#   • The dev-login flags in the gitignored root .dev.vars (NEBULA_AUTH_TEST_MODE=true,
#     NEBULA_AUTH_BOOTSTRAP_EMAIL=dev@example.com) — see apps/nebula-studio-ui/README.md.
#
# Secret boundary (structural): this launcher NEVER names a secret/test-mode flag. The dev-login knobs live
# ONLY in .dev.vars (read by `wrangler dev` automatically). The launcher passes through ONLY a closed allowlist
# of *non-secret* switches, and only if you've set them in this shell:
#   NEBULA_WORKER_URL — vite proxy target, if wrangler picked a non-8787 port.
#   DEBUG             — @lumenize/debug namespaces.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Closed non-secret allowlist → forwarded into the Studio UI tab only if already set in this shell.
studio_env=()
[ -n "${NEBULA_WORKER_URL:-}" ] && studio_env+=("NEBULA_WORKER_URL=$NEBULA_WORKER_URL")
[ -n "${DEBUG:-}" ] && studio_env+=("DEBUG=$DEBUG")

npx ttab -t 'Nebula Worker' -d "$ROOT_DIR/apps/nebula" npm run dev

if [ ${#studio_env[@]} -gt 0 ]; then
  npx ttab -t 'Studio UI' -d "$ROOT_DIR/apps/nebula-studio-ui" env "${studio_env[@]}" npm run dev
else
  npx ttab -t 'Studio UI' -d "$ROOT_DIR/apps/nebula-studio-ui" npm run dev
fi

echo "▶ Studio dev launched — 'Nebula Worker' (:8787) + 'Studio UI' (:5174). Open http://localhost:5174"
