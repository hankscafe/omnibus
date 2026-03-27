FROM node:22-alpine AS base

# Update OS packages (Note: busybox CVE will remain until Alpine officially patches it)
RUN apk update && apk upgrade --no-cache && apk add --no-cache libc6-compat openssl

# Step 1: Install dependencies using the strict lockfile
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

# Copy public assets and prisma schema
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# VITAL FIX: Copy Prisma from the secure builder stage instead of running 'npm install'
# This ensures no unpatched vulnerabilities can be downloaded into production
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# Switch to the non-root 'node' user for runtime security
USER node

EXPOSE 3000
ENV PORT=3000

# Execute database push directly via node, then start the server
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate && node server.js"]