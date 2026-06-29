# Dev-only vite container for the Studio spike.
# Bakes deps at build time so cold start = node+vite boot, not npm install (Q1).
FROM node:22-slim

WORKDIR /workspace

# Install deps first for layer caching (the app's package.json rarely changes vs. source).
COPY app/package.json app/package-lock.json* ./
RUN npm install

# App source (the vite project the agent will edit — Q5).
COPY app/ ./

EXPOSE 5173

# vite dev server, bound so the wrapping DO can reach it on defaultPort.
CMD ["npm", "run", "dev"]
