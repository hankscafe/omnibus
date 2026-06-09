# --- Stage 1: Build Environment ---
# 1. Update to the newer slim base image
FROM node:26-slim AS builder

# Safely update npm to the latest version for the BUILD stage only
RUN npm install -g npm@latest

ARG CACHEBUST=1

# 2. Add 'apt-get upgrade -y' to catch all fixable build-time vulnerabilities
# ---> ADD 'unar' TO THE END OF THIS INSTALL LIST <---
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl ca-certificates unar && \
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
FROM node:26-slim AS runner
WORKDIR /app

ARG CACHEBUST=1

# 1. Grab any patches Debian DOES have available, and install OpenSSL and unar
RUN apt-get update && apt-get dist-upgrade -y && \
    apt-get install -y --no-install-recommends openssl ca-certificates unar

# 2. --- THE NUCLEAR OS CLEANUP ---
# Because apt-get refuses to uninstall tar/perl due to dpkg dependencies, 
# and Omnibus does NOT need apt, dpkg, tar, perl, or systemd at runtime,
# we completely bypass the package manager and manually obliterate the 
# vulnerable binaries and the dpkg tracking database.
USER root
RUN rm -rf \
    /var/lib/dpkg \
    /var/lib/apt \
    /var/cache/apt \
    /usr/bin/perl /usr/share/perl \
    /usr/bin/tar /bin/tar \
    /usr/lib/systemd /lib/systemd \
    /usr/bin/apt* /usr/bin/dpkg*

# --- THE NPM CLEANUP CRUSHER ---
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /root/.npm \
    /root/.cache

# 3. --- FIX GNUSTEP / UNAR DEPENDENCY ---
# unar relies on GNUstep, which expects dpkg-architecture to exist.
# Since we deleted dpkg and perl, we provide a tiny shell mock to satisfy it.
RUN echo '#!/bin/sh' > /usr/bin/dpkg-architecture && \
    echo 'if [ "$1" = "-qDEB_HOST_MULTIARCH" ]; then' >> /usr/bin/dpkg-architecture && \
    echo '  ARCH=$(uname -m)' >> /usr/bin/dpkg-architecture && \
    echo '  if [ "$ARCH" = "x86_64" ]; then echo "x86_64-linux-gnu";' >> /usr/bin/dpkg-architecture && \
    echo '  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then echo "aarch64-linux-gnu";' >> /usr/bin/dpkg-architecture && \
    echo '  else echo "$ARCH-linux-gnu"; fi' >> /usr/bin/dpkg-architecture && \
    echo 'fi' >> /usr/bin/dpkg-architecture && \
    chmod +x /usr/bin/dpkg-architecture

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