# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
# Pin the exact version — the `pnpm@11` tag once pointed to a broken release (11.12.0) and broke the build.
RUN npm install -g pnpm@11.25.0
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Dependency patches (pnpm-workspace.yaml patchedDependencies) — must exist before install to apply.
COPY patches ./patches
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
# Build id baked into the web bundle and dist/build.json (docs/adr/0990-*), e.g.
# `docker build --build-arg INKLING_BUILD=$(git rev-parse --short HEAD) .`. Empty (default) →
# vite.config.ts derives one from the build time; the server reads it back from build.json, so
# the two always agree without git inside the image.
ARG INKLING_BUILD=
RUN INKLING_BUILD="$INKLING_BUILD" pnpm --filter @inkling/web build && pnpm --filter @inkling/server build
# Extract only the server runtime deps into /out (add the --legacy flag on pnpm versions where deploy fails)
RUN pnpm --filter @inkling/server deploy --legacy --prod /out

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST=/app/web-dist \
    DRIZZLE_DIR=/app/drizzle

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web-dist

EXPOSE 3000
VOLUME /data
CMD ["node", "dist/index.js"]
