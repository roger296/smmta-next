# Auto-Stock admin SPA + iPad PWA. Build context is the REPO ROOT (Coolify:
# Base Directory "/", Dockerfile "apps/web/Dockerfile"). The API base URL is
# baked in at build time (Vite), so set it as a Coolify build argument.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Public URL of the API, e.g. https://stock-api.thebigbakes.com/api/v1
ARG VITE_API_BASE_URL=https://stock-api.thebigbakes.com/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .
RUN npm ci --include=dev
# shared-types first (dist consumed by the web build), then the SPA.
RUN npm run build -w @smmta/shared-types \
  && npm run build -w @smmta/web

# ---- static runtime ----
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
