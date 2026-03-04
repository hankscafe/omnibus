FROM node:20-alpine AS base

# Install OpenSSL for Prisma and libc-compat for Next.js
RUN apk add --no-cache libc6-compat openssl

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

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# FIX 1: Grant the nextjs user ownership of the prisma folder so it can read/write
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# FIX 2: Install Prisma globally (-g) so it doesn't corrupt Next.js's standalone files
RUN npm install -g prisma@5.10.2

USER nextjs

EXPOSE 3000
ENV PORT=3000

# FIX 3: Force the exact schema path and skip generation (since the client was already built in stage 2!)
CMD ["sh", "-c", "prisma db push --schema=./prisma/schema.prisma --skip-generate && node server.js"]