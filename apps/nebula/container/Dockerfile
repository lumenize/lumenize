# Build-box image — computerd (the @cloudflare/computer in-container daemon) FUSE-mounts
# the Galaxy's SQLite VFS at /workspace, and the whole job is `vite build` runs against
# that mount. NO vite dev-server, NO HMR, NO command-server: the container is a stateless,
# EPHEMERAL build box (fresh per build, destroyed after — a container that never outlives
# a build can't reach the stuck state).
#
# Base recipe is lifted from cloudflare/computer's examples/container Dockerfile
# (debian:stable-slim + nodesource node 24 + fuse3), proven by
# experiments/computer-vfs-build: the official `node:*-slim` image is bookworm-based and
# wants `libfuse2`, while the t64 transition renamed it `libfuse2t64` on trixie — this base
# is what the daemon is actually tested against. That reason is about the DEBIAN RELEASE,
# not the Node major.
#
# FUSE_MOUNT=auto: Cloudflare Containers expose /dev/fuse so the real kernel backend
# mounts; `wrangler dev` does NOT and falls back to a userspace shim — which is why every
# mount-dependent criterion is verified DEPLOYED, never locally (the shim measures itself).
#
# Baked-deps placement (the containers.md pin — node_modules stays on ext4, never the
# mount): deps are installed at the FILESYSTEM ROOT. Node resolution from /workspace walks
# /workspace/node_modules -> /node_modules, so the app in the mount resolves the baked
# tree without ~111 MB ever crossing FUSE into the DO's SQLite. The dep manifest is
# container/app/package.json — the scaffold's curated UI-lib set ("remove a lib" = stop
# importing it; a NON-baked package is the only thing needing runtime egress).
#
# BUILD CONTEXT is the REPO ROOT (wrangler.jsonc `image_build_context`), not this
# directory: the compiler stages below COPY packages/ts-runtime-parser-validator from
# outside apps/nebula/container/, which a config-dir context cannot reach. Every COPY
# is therefore repo-root-relative, and the root `.dockerignore` allowlists exactly what
# these COPYs need (staging a copy inside this dir instead would defeat the
# layer-invalidation property the compiler stages exist for: a fork edit must rebundle
# on the next image build with no manual step to forget).

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# Optional sandbox-proxy CA hook (PROD-INERT). Some build environments — e.g. Claude
# Code on the web — route container-build egress through a TLS-terminating proxy whose
# CA the base image doesn't trust, so the `npm install` below fails
# SELF_SIGNED_CERT_IN_CHAIN. When such a lane drops a `ccr-ca.crt` into the build context
# (apps/nebula/test/ui-smoke/global-setup.ts does this ONLY in that lane; the file is
# gitignored and ABSENT in prod/CI), trust it for this build's npm. The glob makes the
# COPY a no-op when the CA is absent — `app/package.json` is the always-present sibling
# that keeps COPY legal with zero matches. This never ships a CA into the prod image.
COPY apps/nebula/container/app/package.json apps/nebula/container/ccr-ca.crt* /ccr/
RUN if [ -f /ccr/ccr-ca.crt ]; then \
      npm config set cafile /ccr/ccr-ca.crt && echo "trusting sandbox proxy CA for build npm"; \
    fi

# Deps baked at `/`, deliberately (see header). `npm cache clean` is not cosmetic: the
# cache is ~179 MB of dead weight in this layer — nothing installs at runtime, so it can
# only speed up re-installing packages already baked (measured in
# experiments/container-dep-restore-bench).
WORKDIR /
COPY apps/nebula/container/app/package.json apps/nebula/container/app/package-lock.json* /
RUN npm install && npm cache clean --force

# ── Vendor the private @lumenize frontend graph ─────────────────────────────────────
# The generated app's `src/nebula.ts` imports `@lumenize/nebula/frontend` — a private
# workspace package, not on npm (its own header documents this vendoring) — so the
# build box carries the SOURCE-form graph at /node_modules where the mounted app's
# resolution walk finds it. Source-form is deliberate: the scaffold's vite config
# swc-transforms `node_modules/@lumenize/**` (rolldown emits TC39 decorators verbatim,
# so the transform is load-bearing — see container/app/vite.config.ts). The set is the
# frontend entry's closed import graph (vue's own @vue/* deps arrived with the npm
# install above); a new @lumenize package in that graph needs a COPY pair here AND a
# `!` pair in the root .dockerignore.
COPY apps/nebula/package.json /node_modules/@lumenize/nebula/package.json
COPY apps/nebula/src /node_modules/@lumenize/nebula/src
COPY packages/mesh/package.json /node_modules/@lumenize/mesh/package.json
COPY packages/mesh/src /node_modules/@lumenize/mesh/src
COPY packages/crypto/package.json /node_modules/@lumenize/crypto/package.json
COPY packages/crypto/src /node_modules/@lumenize/crypto/src
COPY packages/debug/package.json /node_modules/@lumenize/debug/package.json
COPY packages/debug/src /node_modules/@lumenize/debug/src
COPY packages/nebula-auth/package.json /node_modules/@lumenize/nebula-auth/package.json
COPY packages/nebula-auth/src /node_modules/@lumenize/nebula-auth/src
COPY packages/routing/package.json /node_modules/@lumenize/routing/package.json
COPY packages/routing/src /node_modules/@lumenize/routing/src
COPY packages/structured-clone/package.json /node_modules/@lumenize/structured-clone/package.json
COPY packages/structured-clone/src /node_modules/@lumenize/structured-clone/src

# ── The compiler (tasks/nebula-move-compilers-out-of-the-worker.md phase 4) ─────────
# The tsc-bearing surface lives HERE now — the Worker orchestrates and stores, and does
# not build. The package's distribution bundle is built IN the image, from source
# copied out of the tree: a Docker COPY layer invalidates when its source changes, so
# editing the package or a vendored fork rebundles on the next image build with no
# manual step to forget (copying the prebuilt dist/ would ship whatever was last
# bundled by hand). /build is the compiler's own root — deliberately NOT `/`, whose
# node_modules is the generated app's baked dep tree (container/app/package.json);
# the compiler toolchain must not leak into what a user app can resolve.
#
# Manifests first, so the npm-install layer caches until a manifest changes (npm
# installs `file:` directory deps as SYMLINKS, reading only the target's package.json
# — the sources land in a later layer).
WORKDIR /build
COPY apps/nebula/container/compiler/package.json /build/package.json
COPY packages/ts-runtime-parser-validator/package.json /build/packages/ts-runtime-parser-validator/package.json
COPY packages/ts-runtime-parser-validator/forks/typia/core/package.json /build/packages/ts-runtime-parser-validator/forks/typia/core/package.json
COPY packages/ts-runtime-parser-validator/forks/typia/transform/package.json /build/packages/ts-runtime-parser-validator/forks/typia/transform/package.json
COPY packages/ts-runtime-parser-validator/forks/typia/interface/package.json /build/packages/ts-runtime-parser-validator/forks/typia/interface/package.json
COPY packages/ts-runtime-parser-validator/forks/typia/utils/package.json /build/packages/ts-runtime-parser-validator/forks/typia/utils/package.json
RUN npm install && npm cache clean --force

# Sources: an edit to ANY of these invalidates from here down, which is the
# layer-invalidation property the phase's criteria assert.
COPY packages/ts-runtime-parser-validator/src /build/packages/ts-runtime-parser-validator/src
COPY packages/ts-runtime-parser-validator/scripts /build/packages/ts-runtime-parser-validator/scripts
COPY packages/ts-runtime-parser-validator/forks /build/packages/ts-runtime-parser-validator/forks
COPY apps/nebula/src/ontology-compile.ts /build/apps/nebula/src/ontology-compile.ts
COPY apps/nebula/src/sfc-contract.ts /build/apps/nebula/src/sfc-contract.ts
COPY apps/nebula/src/build-report.ts /build/apps/nebula/src/build-report.ts
COPY apps/nebula/container/compiler /build/apps/nebula/container/compiler

# One-pass deps bundle (typescript + the @typia fork) — bundle-tsc.mjs runs UNMODIFIED
# here: it resolves typescript/package.json and reads its lib/ off /build/node_modules,
# and esbuild's linux platform binary arrived with the manifest install above. Its
# header pins why one pass matters (two `typescript` instances silently break typia's
# `instanceof ts.Node`).
RUN node packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs

# The job bundle the Galaxy execs (`node /build/job.cjs` — see compiler/job.ts).
# format=cjs is the defensive pick for a bundle full of CJS deps (probed 2026-08-29:
# esm also runs for TODAY's graph, so this is preference, not necessity). The
# compiler-sfc alias dodges its CJS build's lazy requires of ~36 OPTIONAL template
# engines (pug, ejs, …) that are never installed — the esm-browser build is
# self-contained, and the SFC passes are pure text transforms with no node-builtin
# dependency.
RUN node_modules/.bin/esbuild apps/nebula/container/compiler/job.ts --bundle --platform=node --format=cjs "--alias:@vue/compiler-sfc=./node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js" --outfile=/build/job.cjs

WORKDIR /

# computerd: PID 1. It dials the companion DO back over the workspace proxy, mounts the
# VFS at MOUNT_POINT, and executes `runtime.exec` commands against it.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
