# Auto-Stock API — Fastify + Drizzle + MCP.
# Build context is the REPO ROOT (Coolify: Base Directory "/", Dockerfile
# "apps/api/Dockerfile"). Single stage: the runtime keeps drizzle-kit so the
# container can apply migrations on boot. Xero stays dry-run via env defaults.
FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# Install the whole workspace (dev deps included — drizzle-kit is needed at
# runtime for migrations, tsc/turbo for the build).
COPY . .
RUN npm ci --include=dev

# Build the shared types first (consumers import its dist), then the API.
RUN npm run build -w @smmta/shared-types \
  && npm run build -w @smmta/api

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# tini for clean signal handling; apply DB migrations, then start the server.
# (Health check: GET /health — configure the path in Coolify.)
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-lc", "npm run db:migrate -w @smmta/api && node apps/api/dist/server.js"]
