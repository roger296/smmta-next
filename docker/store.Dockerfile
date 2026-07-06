# Storefront image (Next.js 15, output: 'standalone'). Context = repo root.
#   docker build -f docker/store.Dockerfile -t smmta-store .
# The standalone build bundles a minimal server; static + public are copied into
# place (next build does not copy them — the well-known monorepo gotcha).
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
ENV NODE_ENV=production
# Cap Node's heap so the Next build stays under memory pressure on small hosts.
ENV NODE_OPTIONS=--max-old-space-size=2048
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @smmta/shared-types \
  && npm run build -w @smmta/store

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/store/.next/standalone ./
COPY --from=build /app/apps/store/.next/static ./apps/store/.next/static
COPY --from=build /app/apps/store/public ./apps/store/public
EXPOSE 3000
CMD ["node", "apps/store/server.js"]
