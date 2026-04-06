# Stage 1: Build
FROM node:22-slim AS build

WORKDIR /app

# Copy workspace root
COPY package.json package-lock.json ./

# Copy package manifests for dependency resolution
COPY packages/core/package.json packages/core/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source
COPY packages/core/ packages/core/

# Build
RUN npm run build --workspace=packages/core

# Prune dev dependencies
RUN npm prune --production

# Stage 2: Runtime
FROM node:22-slim AS runtime

WORKDIR /app

# Copy production node_modules and built output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/package.json ./

# Default memory root mount point
VOLUME ["/memory"]

ENV RECALL_MEMORY_ROOT=/memory

ENTRYPOINT ["node", "packages/core/dist/cli.js"]
