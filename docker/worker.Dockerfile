# Worker image (pg-boss dispatcher + scheduled jobs + agents). Context = repo root.
#   docker build -f docker/worker.Dockerfile -t smmta-worker .
# Shares the build with the API. Does NOT run migrations (the API image owns
# that on deploy) — the worker just consumes the schema.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/store/package.json ./apps/store/
COPY apps/store-clothes/package.json ./apps/store-clothes/
COPY apps/web/package.json ./apps/web/
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @smmta/shared-types

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
# Optional health server (set WORKER_HEALTH_PORT to enable + EXPOSE it).
CMD ["sh", "-c", "cd apps/worker && npx tsx src/index.ts"]
