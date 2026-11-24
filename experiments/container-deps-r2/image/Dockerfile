# One Dockerfile, three named images via build_vars (wrangler.jsonc):
#   plain — the tools and the app's source + lockfile, NO node_modules. The "fixed image for
#           every Galaxy" shape: a snapshot, an R2 archive or a FUSE mount supplies the tree.
#   baked — plain + the whole tree from `npm ci`. Today's Nebula shape, and the control.
#   base  — baked minus the app's extras (echarts, zrender, three, date-fns, lodash-es): the
#           scaffold baked into the image, with a Galaxy's extras arriving from R2.
#
# node:24-trixie-slim, not Nebula's debian + nodesource + fuse3 + computerd recipe: this spike
# measures where node_modules comes from, and needs no computerd.
FROM node:24-trixie-slim

# First, so all three images share the layer. curl + zstd carry the R2 archive; s3fs + fuse3
# are the FUSE arm, the adapter Sandbox SDK 1.0's S3Mount drives.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd s3fs fuse3 \
 && rm -rf /var/lib/apt/lists/*

ARG VARIANT=plain

WORKDIR /app
COPY app/ /app/

# `npm cache clean`, as Nebula's own Dockerfile does, so the layer carries node_modules only.
RUN if [ "$VARIANT" != "plain" ]; then npm ci --include=dev --no-audit --no-fund && npm cache clean --force; fi
RUN if [ "$VARIANT" = "base" ]; then \
      rm -rf node_modules/echarts node_modules/zrender node_modules/three node_modules/date-fns node_modules/lodash-es; \
    fi

RUN echo "$VARIANT" > /image-mark

# The Worker overrides this at start() with its own command server. CMD, never ENTRYPOINT:
# experiments/container-snapshot-deps found local `wrangler dev` delivers start()'s
# `entrypoint` as CMD, and node's docker-entrypoint.sh execs whatever arrives.
CMD ["sleep", "infinity"]
