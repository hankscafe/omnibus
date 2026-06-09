# --- Stage 1: Build Environment ---
# 1. Update to the newer slim base image
FROM node:26-slim AS builder

# Safely update npm to the latest version for the BUILD stage only
RUN npm install -g npm@latest

ARG CACHEBUST=1

# 2. Add 'apt-get upgrade -y' to catch all fixable build-time vulnerabilities
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .

RUN npx prisma generate
RUN npm run build

USER root
# Destroy deeply nested vulnerable copies inside the compiled app
RUN find .next/standalone/node_modules -type d -name "picomatch" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "brace-expansion" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "nodemailer" -exec rm -rf {} + || true
RUN find .next/standalone/node_modules -type d -name "uuid" -exec rm -rf {} + || true

RUN cd .next/standalone && npm install picomatch@4.0.4 brace-expansion@5.0.6 nodemailer@latest uuid@11.1.1 --no-save --legacy-peer-deps --force
RUN cp -r node_modules/node-unar .next/standalone/node_modules/

# --- Stage 2: Final Production Image ---
# 1. Update to the newer slim base image
FROM node:26-slim AS runner
WORKDIR /app

ARG CACHEBUST=1

# 2. Upgrade OS and explicitly force perl-base to patch High Severity CVEs
RUN apt-get update && \
    apt-get install -y --only-upgrade perl-base && \
    apt-get dist-upgrade -y && \
    apt-get install -y --no-install-recommends openssl ca-certificates

# 3. --- OS CACHE CLEANUP ---
RUN apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# --- THE NPM CLEANUP CRUSHER ---
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /root/.npm \
    /root/.cache

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

USER node
EXPOSE 3000
ENV PORT=3000

CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate --accept-data-loss && node server.js"]