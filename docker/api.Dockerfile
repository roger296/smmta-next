# API image (Fastify + Drizzle). Build context = repo root.
#   docker build -f docker/api.Dockerfile -t smmta-api .
# Runs drizzle migrations on start, then the API via tsx (matches the VPS
# systemd model). Single-tenant; all config comes from the environment.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Copy the workspace manifests first for a cached install layer. npm workspaces
# needs every workspace package.json present, so copy them all.
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
# shared-types must be built before the API can typecheck/run.
RUN npm run build -w @smmta/shared-types

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
EXPOSE 3000
# Ensure smmta_store exists, migrate both DBs, then boot. HOST is forced to
# 0.0.0.0 so the container is reachable; it stays behind Coolify's proxy.
# Invoked via `sh` (not the exec bit) so a Windows-authored script still runs.
CMD ["sh", "/app/docker/api-entrypoint.sh"]
