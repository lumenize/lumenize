# Minimal egress probe image: a tiny command-server (8080) + the tools we egress with
# (git, curl) and the machinery to install a CA at runtime (ca-certificates →
# update-ca-certificates). No vite, no npm install — egress is the only variable here.
#
# The CF container interception CA is EPHEMERAL and only appears at runtime at
# /etc/cloudflare/certs/cloudflare-containers-ca.crt — it CANNOT be baked into the image.
# So we do NOT install it in a build layer; the /probe route installs it at runtime via
# `update-ca-certificates` and re-tests, isolating the before/after CA-trust difference.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY command-server.mjs /workspace/command-server.mjs

EXPOSE 8080
CMD ["node", "/workspace/command-server.mjs"]
