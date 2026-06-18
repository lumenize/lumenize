# Phase-1 DevContainer image: vite (5173) + a command-server (9000), reusing the
# agent-channel spike's proven setup. The command-server is PID 1 / supervisor —
# it spawns vite as a child so the agent can start/stop/restart the dev server.
# Deps baked at build so cold start = boot, not npm install.
FROM node:22-slim

# node:22-slim ships no git; the agent needs it (container-vite spike finding).
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/app

# Install app deps first for layer caching (package.json changes rarely vs. source).
COPY app/package.json app/package-lock.json* ./
RUN npm install

# App source (the vite project the agent edits) + the command-server.
COPY app/ ./
COPY command-server.mjs /workspace/command-server.mjs

# 5173 = vite (public preview proxy); 9000 = command-server (DO-only, server-side).
EXPOSE 5173 9000

WORKDIR /workspace
# The command-server boots, listens on 9000, then spawns vite (5173) itself.
CMD ["node", "/workspace/command-server.mjs"]
