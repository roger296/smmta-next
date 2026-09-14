# Clothes Shop storefront image (Next.js 15, output: 'standalone'). Context = repo root.
#   docker build -f docker/store-clothes.Dockerfile -t smmta-store-clothes .
# Same shape as docker/store.Dockerfile: the standalone build bundles a minimal
# server, and static + public are copied into place because next build does not.
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
# The API's PUBLIC origin, so next/image accepts product photographs uploaded
# to <origin>/uploads/. Read by `next build` and baked into the output; see the
# note in docker/store.Dockerfile on why there is no default and no ENV.
ARG SMMTA_API_PUBLIC_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @smmta/shared-types \
  && npm run build -w @smmta/store-clothes

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/store-clothes/.next/standalone ./
COPY --from=build /app/apps/store-clothes/.next/static ./apps/store-clothes/.next/static
COPY --from=build /app/apps/store-clothes/public ./apps/store-clothes/public
EXPOSE 3000
CMD ["node", "apps/store-clothes/server.js"]
