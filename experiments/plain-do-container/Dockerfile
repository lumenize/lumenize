# Minimal container for the spike: a tiny HTTP server on :8080 so the DO can prove
# getTcpPort(8080).fetch() works via the raw ctx.container API. node:22-slim is already
# pulled by the ui-smoke lane locally, avoiding a docker.io round-trip.
FROM node:22-slim
WORKDIR /app
COPY server.mjs .
EXPOSE 8080
CMD ["node", "server.mjs"]
