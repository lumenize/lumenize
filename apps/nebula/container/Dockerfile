# DevContainer image — real vite (5173, public preview + HMR) + a command-server
# (9000, host-DO-only). The command-server is PID 1 / supervisor: it spawns vite as
# a child so DevStudio can start/stop/restart the dev server over the command channel.
#
# Baked-vs-pushed split (nebula-dev-flows.md § First-run scaffold):
#   - FRAMEWORK layer is BAKED here (vite config, index.html, main.ts, the nebula.ts
#     bootstrap, HMR wiring, the curated UI-lib deps). Same for every app, version-
#     coupled to this image. Deps baked → ZERO `npm install` on cold boot (CF
#     containers have no persistent volume — baking is the only durable store).
#   - APP layer is PUSHED by DevStudio (`applyChanges`): App.vue, components, the
#     ontology .d.ts. A trivial seed App.vue is baked so vite boots before the first
#     push; DevStudio overwrites it on session start (Flow 1c).
#
# Deploy: `wrangler deploy` pushes this image via Docker Desktop + WARP
# ([[cf-container-deploy-proxy]]); CI is the headless fallback.
FROM node:22-slim

# node:22-slim ships no git; DevStudio's optional Artifacts `git pull` (future) and
# general tooling need it (container-vite spike finding).
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/app

# Optional sandbox-proxy CA hook (PROD-INERT). Some build environments — e.g. Claude
# Code on the web — route container-build egress through a TLS-terminating proxy whose
# CA the base image doesn't trust, so the `npm install` below fails
# SELF_SIGNED_CERT_IN_CHAIN. When such a lane drops a `ccr-ca.crt` into the build context
# (apps/nebula/test/ui-smoke/global-setup.ts does this ONLY in that lane; the file is
# gitignored and ABSENT in prod/CI), trust it for this build's npm. The glob makes the
# COPY a no-op when the CA is absent — `app/package.json` is the always-present sibling
# that keeps COPY legal with zero matches (a lone non-matching glob would error). In
# prod nothing is staged → no `cafile` is set → npm behaves exactly as before. This
# never ships a CA into the prod image. (--network host does NOT help: the proxy
# intercepts host-network builds too; only CA trust fixes it.)
COPY app/package.json ccr-ca.crt* /ccr/
RUN if [ -f /ccr/ccr-ca.crt ]; then \
      npm config set cafile /ccr/ccr-ca.crt && echo "ui-smoke: trusting sandbox proxy CA for build npm"; \
    fi

# Install the baked UI-lib set first for layer caching (package.json changes rarely
# vs. source). This is the curated dependency surface — "remove a lib" = stop
# importing it (vite tree-shakes); pulling a NON-baked package is the only thing
# that would need runtime egress (deferred; deps are fully baked for the demo).
COPY app/package.json app/package-lock.json* ./
RUN npm install

# Framework skeleton (baked) + the command-server. The per-app source (App.vue,
# components, ontology.d.ts) is pushed by DevStudio at runtime via applyChanges.
COPY app/ ./
COPY command-server.mjs /workspace/command-server.mjs

# 5173 = vite (public preview proxy); 9000 = command-server (DO-only, server-side).
EXPOSE 5173 9000

WORKDIR /workspace
# The command-server boots, listens on 9000, then spawns vite (5173) itself.
CMD ["node", "/workspace/command-server.mjs"]
