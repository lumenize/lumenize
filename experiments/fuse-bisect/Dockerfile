# Bisect image — the PROVEN recipe, verbatim from experiments/computer-vfs-build's
# Dockerfile minus its seed/app layers (that image, freshly redeployed 2026-08-29, ran a
# real vite build through the deployed kernel FUSE mount — so this base is known-good
# today). The first bisect image was minimal (no node/git/curl) and computerd's session
# died at connect with a bare 1006 — too far from the proven shape to discriminate
# anything. Fidelity over size.

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

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
