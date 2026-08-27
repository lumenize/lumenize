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

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd

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
COPY app/package.json ccr-ca.crt* /ccr/
RUN if [ -f /ccr/ccr-ca.crt ]; then \
      npm config set cafile /ccr/ccr-ca.crt && echo "trusting sandbox proxy CA for build npm"; \
    fi

# Deps baked at `/`, deliberately (see header). `npm cache clean` is not cosmetic: the
# cache is ~179 MB of dead weight in this layer — nothing installs at runtime, so it can
# only speed up re-installing packages already baked (measured in
# experiments/container-dep-restore-bench).
WORKDIR /
COPY app/package.json app/package-lock.json* /
RUN npm install && npm cache clean --force

# computerd: PID 1. It dials the companion DO back over the workspace proxy, mounts the
# VFS at MOUNT_POINT, and executes `runtime.exec` commands against it.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
