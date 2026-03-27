FROM node:22-alpine AS base

# Safely update npm to the latest version
RUN corepack enable && corepack prepare npm@latest --activate

# Update OS and surgically pull the busybox CVE patch from the Alpine Edge repository
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache busybox --repository=http://dl-cdn.alpinelinux.org/alpine/edge/main && \
    apk add --no-cache libc6-compat openssl

# Step 1: Install dependencies using your stable lockfile
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Step 2: Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client & Build
RUN npx prisma generate
RUN npm run build

# ==========================================
# THE SURGICAL NPM PATCH
# ==========================================
USER root

# 1. Hunt down and physically destroy all deeply nested, vulnerable copies
RUN find /app/.next/standalone/node_modules -type d -name "picomatch" -exec rm -rf {} + || true
RUN find /app/.next/standalone/node_modules -type d -name "brace-expansion" -exec rm -rf {} + || true

# 2. Forcefully install the secure versions at the root of the standalone folder
RUN cd /app/.next/standalone && npm install picomatch@4.0.4 brace-expansion@5.0.5 --no-save

# Switch back to the non-root user
USER node
# ==========================================

# Step 3: Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# --- USER CONFIGURATION ---
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Copy the surgically patched standalone output
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Copy Prisma directly from builder
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# Switch to the non-root 'node' user for runtime security
USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push bypassing npx, then start the server
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate && node server.js"]