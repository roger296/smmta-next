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
# The API's PUBLIC origin, needed so next/image will accept uploaded product
# photographs served from <origin>/uploads/. images.remotePatterns is read by
# `next build` and baked into the standalone output, so a value that only
# exists in the runtime environment cannot configure it.
#
# Declared without a default and WITHOUT a matching ENV on purpose. The earlier
# `ARG X=""` + `ENV X=$X` set the variable to empty for the build, which
# actively masked the value the deploy platform was providing — worse than not
# declaring it at all. next.config.js falls back to APP_BASE_URL, which is the
# same origin and is present as a platform variable wherever the build runs.
ARG SMMTA_API_PUBLIC_URL
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
