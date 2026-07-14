# Food Assistant service image.
# Multi-stage: build TypeScript (and compile the better-sqlite3 native addon) in
# a stage with build tools, then ship a lean runtime with the compiled output.

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Build tools for the better-sqlite3 native addon.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Emit dist/, then drop dev dependencies (tsx/typescript) — the compiled
# better-sqlite3 binary stays in node_modules.
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/food-assistant.sqlite
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Runtime-read assets (resolved relative to dist/..).
COPY prompts ./prompts
COPY public ./public
COPY data ./data
# Durable data (the SQLite DB) lives on a mounted volume, separate from the
# image's read-only data/ (mock offers, example baskets).
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/server.js"]
