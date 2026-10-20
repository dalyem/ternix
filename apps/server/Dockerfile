# syntax=docker/dockerfile:1
# Build context is the repository root:
#   docker build -f apps/server/Dockerfile -t ternix-server .

FROM node:22-bookworm-slim AS build
# better-sqlite3 ships prebuilt binaries; skipping lifecycle scripts keeps pnpm from
# trying to compile it from source (the slim image has no compiler).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_ignore_scripts=true \
    CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN corepack pnpm install --frozen-lockfile --filter "@ternix/server..."
RUN corepack pnpm --filter @ternix/core build \
 && corepack pnpm --filter @ternix/server build
# Production dependencies plus the built core and server, nothing else.
RUN corepack pnpm --filter @ternix/server deploy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TERNIX_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build /out/ ./
# The `node` user (uid 1000) ships with the image. /data is created before VOLUME so a
# fresh named volume inherits its ownership.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/server').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
