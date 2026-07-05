# Admin SPA image (Vite/React static, served by nginx). Context = repo root.
#   docker build -f docker/web.Dockerfile -t smmta-web .
# The API base URL is baked at build time via VITE_API_BASE_URL (Vite inlines
# VITE_* at build). nginx serves the SPA and can proxy /api to the API service.
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
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @smmta/shared-types \
  && npm run build -w @smmta/web

FROM nginx:1.27-alpine AS runtime
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
