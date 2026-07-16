# syntax=docker/dockerfile:1
#
# Havemind server image — hardened, reproducible build for the sapserver pilot.
# The base image is pinned by tag AND digest so the same bytes are pulled on
# every host (see plan/07 "Anty-spec": no image without a pinned digest).
#
# Base: node:22.23.1-bookworm-slim (Node 22 LTS, satisfies engines >=22.20.0 <23).
ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

# ---------------------------------------------------------------------------
# Build stage: install workspace deps (with the toolchain better-sqlite3 needs)
# and compile the protocol package plus the server to dist/.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# better-sqlite3 is a native addon; node-gyp needs python3 + a C/C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so dependency installation is cache-friendly.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sync-core/package.json packages/sync-core/package.json
COPY apps/obsidian-plugin/package.json apps/obsidian-plugin/package.json

RUN npm ci

# Copy the sources needed to build the server and its runtime dependency graph.
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server

RUN npm run build --workspace @havemind/protocol \
  && npm run build --workspace @havemind/server

# Prune to production dependencies for the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage: no build toolchain, no source, non-root, read-only friendly.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The stock "node" user is UID/GID 1000:1000 — matches the Compose `user:` pin.
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=1000:1000 /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=1000:1000 /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=1000:1000 /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=1000:1000 /app/apps/server/healthcheck.js ./apps/server/healthcheck.js
# Operator-facing setup/diagnostics CLI. `bin/havemind.js` is a thin wrapper
# around dist/setup/cli.js, so the owner can run, inside the container:
#   docker compose exec havemind node apps/server/bin/havemind.js setup ...
#   docker compose exec havemind node apps/server/bin/havemind.js doctor
COPY --from=build --chown=1000:1000 /app/apps/server/bin ./apps/server/bin

USER 1000:1000
EXPOSE 8787

# Liveness/readiness probe used by the Compose healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "apps/server/healthcheck.js"]

CMD ["node", "apps/server/dist/index.js"]
