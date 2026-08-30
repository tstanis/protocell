# PROTOCELL — one container serving both the simulation and the client. SPEC.md §15.10.
#
# Multi-stage so the runtime image carries no build toolchain and no dev dependencies.

FROM node:22-slim AS build
WORKDIR /app

# Manifests first: this layer only invalidates when a dependency actually changes, so the
# (slow) install is cached across ordinary source edits.
COPY package.json package-lock.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci

COPY . .
RUN npx tsc --build \
 && npm run build --workspace @protocell/client

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
# `tsx` is a devDependency and the server is run from TypeScript source, so dev deps are
# needed at runtime. Kept deliberate rather than accidental: the alternative is emitting
# JS for the server too, which buys a smaller image and costs a build step that can drift
# from what the tests actually run.
RUN npm ci && npm cache clean --force

COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/client/dist ./apps/client/dist

# Cloud Run injects PORT (8080). The server already reads it; this is the local default.
ENV PORT=8080
EXPOSE 8080

# Run as a non-root user. The base image ships one.
USER node

CMD ["npx", "tsx", "apps/server/src/main.ts"]
