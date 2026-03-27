FROM node:22-alpine AS base

# 1. Safely update npm to the latest version
RUN corepack enable && corepack prepare npm@latest --activate

# 2. Update Alpine, but pull BusyBox from the 'edge' repository to get the unreleased CVE patch
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache busybox --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main && \
    apk add --no-cache libc6-compat openssl

# Step 1: Install dependencies
FROM base AS deps
WORKDIR /app
# DELIBERATELY IGNORE package-lock.json here so npm forces the overrides fresh
COPY package.json ./
RUN npm install

# Step 2: Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client & Build
RUN npx prisma generate
RUN npm run build

# Step 3: Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy public assets, prisma schema, and standalone output
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Copy Prisma directly from builder to avoid npm installs in production
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# THE ULTIMATE HAMMER: Force the secure versions into the final standalone node_modules
# This guarantees the Docker Hub scanner finds the patched versions in the final layer
RUN npm install picomatch@4.0.4 brace-expansion@5.0.5 --no-save

# Switch to the non-root 'node' user for runtime security
USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push bypassing npx, then start the server
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate && node server.js"]