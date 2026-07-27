# Stock-take-lite: the standalone iPad counting PWA (P26) the venues used for
# the June quarter count. Build context is the REPO ROOT (Coolify: Base
# Directory "/", Dockerfile "apps/stocktake/Dockerfile").
#
# Its API half already lives in the deployed stock-api service
# (/api/v1/stocktake-lite/*), so this image is static assets only. The API
# origin is baked in at build time by Vite, so it must be a build argument --
# changing it later needs a rebuild, not just a restart.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Origin of the Auto-Stock API. NOTE: no /api/v1 suffix -- src/lib/api.ts
# appends `/api/v1/stocktake-lite` itself. Empty would mean same-origin, which
# only works if something proxies /api to the API from this host.
ARG VITE_API_BASE=https://stock-api.thebigbakes.com
ENV VITE_API_BASE=$VITE_API_BASE

COPY . .
RUN npm ci --include=dev
RUN npm run build -w @smmta/stocktake

# ---- static runtime ----
FROM nginx:1.27-alpine
COPY apps/stocktake/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/stocktake/dist /usr/share/nginx/html
EXPOSE 80
