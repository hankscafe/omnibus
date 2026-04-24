# --- Stage 1: Build Environment ---
FROM node:22-alpine3.20 AS builder

# Safely update npm to the latest version for the BUILD stage only
RUN corepack enable && corepack prepare npm@latest --activate

# Cache-busting argument (Overridden by GitHub Actions to force fresh patch pull)
ARG CACHEBUST=1

# Build-time dependencies (Standard stable repo)
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache libc6-compat openssl

WORKDIR /app
COPY package.json package-lock.json ./
# ADDED: --legacy-peer-deps to ignore next-auth's request for v7 of nodemailer
RUN npm ci --legacy-peer-deps

COPY . .

# Generate Prisma Client & Build Next.js app
RUN npx prisma generate
RUN npm run build

# --- SURGICAL NPM PATCH (Application Dependencies) ---
USER root
# Destroy deeply nested vulnerable copies inside the compiled app
RUN find .next/standalone/node_modules -type d -name "picomatch" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "brace-expansion" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "nodemailer" -exec rm -rf {} + || true
# ADDED: Destroy vulnerable uuid and postcss packages
RUN find .next/standalone/node_modules -type d -name "uuid" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "postcss" -exec rm -rf {} + || true

# Force secure versions into the standalone folder
RUN cd .next/standalone && npm install picomatch@4.0.4 brace-expansion@5.0.5 nodemailer@latest uuid@latest postcss@latest --no-save --legacy-peer-deps


# --- Stage 2: Final Production Image ---
FROM node:22-alpine3.20 AS runner
WORKDIR /app

# Cache-busting argument for the final stage
ARG CACHEBUST=1

# Apply OS patches (Standard stable repo)
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache busybox libc6-compat openssl

# --- THE CLEANUP CRUSHER ---
# Omnibus runs via 'node server.js'. It does NOT need npm at runtime.
# Deleting npm and the cache removes the vulnerabilities found in /usr/local/lib/node_modules/npm
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /root/.npm \
    /root/.cache

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy standalone output and assets from builder
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Copy Prisma files needed for 'db push'
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push using the node binary directly (since npx was deleted)
# ADDED: --accept-data-loss to bypass interactive warnings when adding unique columns
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate --accept-data-loss && node server.js"]