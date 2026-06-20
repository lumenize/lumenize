# Minimal container for Stage 2 (cross-DO pull transport). node + the command-server only —
# no vite/git here (HMR is proven elsewhere; the target image adds git for the Artifacts pull).
FROM node:22-slim
WORKDIR /workspace
COPY command-server.mjs /workspace/command-server.mjs
RUN mkdir -p /workspace/app
EXPOSE 8080
CMD ["node", "/workspace/command-server.mjs"]
