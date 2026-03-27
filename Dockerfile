FROM node:22-bookworm-slim AS base

# Safely update npm to the latest version
RUN corepack enable && corepack prepare npm@latest --activate

# Update OS packages and install OpenSSL (Debian equivalent of Alpine's libc6-compat openssl)
RUN apt-get update && apt-get upgrade -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Step 1: Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Step 2: Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client
RUN npx prisma generate
# Build Next.js app
RUN npm run build

# Step 3: Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# --- USER CONFIGURATION ---
# Copy public assets and prisma schema
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# COPY PRISMA DIRECTLY FROM BUILDER TO AVOID NPM INSTALL IN PRODUCTION
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# Switch to the non-root 'node' user for runtime security
USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push bypassing npx, then start the server
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate && node server.js"]