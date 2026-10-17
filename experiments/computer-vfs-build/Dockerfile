# Spike image: computerd (FUSE-mounted VFS) + the REAL Nebula app scaffold's baked deps.
#
# Base recipe is lifted verbatim from cloudflare/computer's examples/container Dockerfile
# (debian:stable-slim + nodesource node 24 + fuse3), because that combination is the one
# proven to mount computerd's FUSE backend. The official `node:*-slim` image was NOT used:
# it is bookworm-based and wants `libfuse2`, while the t64 transition renamed it
# `libfuse2t64` on trixie — the example's base is what the daemon is actually tested
# against. That reason is about the DEBIAN RELEASE, not the Node major, so it survives the
# 22→24 bump unchanged: `node:24-slim` is still bookworm (verified 2026-08-03), so swapping
# to the official image would reintroduce exactly the libfuse mismatch this base avoids.
#
# FUSE_MOUNT=auto: Cloudflare Containers expose /dev/fuse so the real kernel backend mounts;
# `wrangler dev` does NOT, and it falls back to a userspace shim. That divergence is the
# whole reason this spike must be measured DEPLOYED — a local number measures the shim.

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

# Deps baked at the FILESYSTEM ROOT, deliberately. Node resolution from /workspace/app
# walks /workspace/app/node_modules -> /workspace/node_modules -> /node_modules, so an app
# sitting anywhere resolves the same baked tree. That keeps node_modules OUT of the VFS —
# which is the realistic production shape (Nebula bakes deps; only source is durable) and
# also avoids pushing ~111 MB through FUSE and into the DO's SQLite on every build.
WORKDIR /
COPY seed/app/package.json /package.json
RUN npm install && npm cache clean --force

# Arm B's source, on the container's own ext4 disk. Identical bytes to what the DO writes
# into the VFS for arm A, so the ONLY difference between the arms is which filesystem the
# source and the build output live on.
COPY seed/app /seed/app

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
