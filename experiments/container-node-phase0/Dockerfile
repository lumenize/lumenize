# Minimal image for the Phase-0 kill-fast deploy gate. The DO never starts this
# container (the smoke constructs the DO + drives one mesh call + reads storage);
# it exists only so the `containers` block is valid and the CI image build+push
# path is exercised. See tasks/nebula-container-dev-loop.md Phase 0.
FROM node:22-slim
WORKDIR /workspace
COPY server.mjs ./
EXPOSE 8080
CMD ["node", "/workspace/server.mjs"]
