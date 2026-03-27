FROM node:22-alpine AS base

# Safely update npm to the latest version to patch picomatch & brace-expansion CVEs
RUN corepack enable && corepack prepare npm@latest --activate

# Update OS packages to patch busybox CVE, then install required Next.js/Prisma libs
RUN apk update && apk upgrade --no-cache && apk add --no-cache libc6-compat openssl

# Step 1: Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Step 2: Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# FIX: Ensure COPY . . is on a single line
COPY . .

# Generate Prisma Client
RUN npx prisma generate
# Build Next.js app
RUN npm run build

# Step 3: Production image
FROM base AS runner
WORKDIR /app

RUN apk update && apk upgrade --no-cache

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# --- USER CONFIGURATION ---
# Use existing 'node' user (UID/GID 1000) for QNAP NAS permission compatibility.
# Copy public assets and prisma schema
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Install Prisma locally in the runner stage to ensure npx finds it
RUN npm install prisma@5.10.2

# Switch to the non-root 'node' user for runtime security
USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push with an absolute path and start the server
CMD ["sh", "-c", "npx prisma db push --schema=/app/prisma/schema.prisma --skip-generate && node server.js"]