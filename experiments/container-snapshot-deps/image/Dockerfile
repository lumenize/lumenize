# One Dockerfile, three named images via build_vars (wrangler.jsonc):
#   plain  — app source + lockfile, NO node_modules  (what "stop pre-installing" ships)
#   plain2 — byte-identical to plain but for /image-mark (a snapshot's image-tie test)
#   baked  — plain + `npm ci` at image build           (today's Nebula shape: the baseline)
#
# node:24-trixie-slim, not Nebula's debian+nodesource+fuse3 recipe: this spike measures
# snapshots of node_modules on the container's own disk, and needs no computerd/FUSE.
FROM node:24-trixie-slim

ARG BAKE=0
ARG MARK=a

WORKDIR /app
COPY app/ /app/

# Mirrors apps/nebula/container/Dockerfile: `npm cache clean` so the baked layer carries
# node_modules only, not ~180 MB of cache.
RUN if [ "$BAKE" = "1" ]; then npm ci --include=dev && npm cache clean --force; fi

# Last, so plain and plain2 share every layer but this one.
RUN echo "$MARK" > /image-mark

# The Worker overrides this at start() with its own command server (one source of truth,
# and the managed cloudflare/debian-trixie image needs the same override). CMD, never
# ENTRYPOINT: local `wrangler dev` 4.145 delivers start()'s `entrypoint` as the container's
# CMD, so an image ENTRYPOINT of `sleep infinity` became `sleep infinity node -e …` and
# exited. node's own docker-entrypoint.sh execs whatever arrives, so either delivery works.
CMD ["sleep", "infinity"]
