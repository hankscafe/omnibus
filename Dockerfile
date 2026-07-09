# --- Stage 1: Build Environment ---
# 1. Update to the newer slim base image
FROM node:26-slim AS builder

# Safely update npm to the latest version for the BUILD stage only
RUN npm install -g npm@latest

ARG CACHEBUST=2

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

# --- Stage 2: Final Production Image ---
FROM node:26-slim AS runner
WORKDIR /app

ARG CACHEBUST=2

# 1. Grab any patches Debian DOES have available, and install OpenSSL, unar, and official unrar (non-free)
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get dist-upgrade -y && \
    apt-get install -y --no-install-recommends openssl ca-certificates unar unrar

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
# Provide a pure Node.js mock for dpkg-architecture to satisfy GNUstep.
# It is copied to local/bin as well so the restricted shell cannot miss it.
RUN printf '#!/usr/bin/env node\nconsole.log(process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu");\n' > /usr/bin/dpkg-architecture && \
    chmod +x /usr/bin/dpkg-architecture && \
    cp /usr/bin/dpkg-architecture /usr/local/bin/dpkg-architecture

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

USER node
EXPOSE 3000
ENV PORT=3000

# Dual-DB startup lives in the ENTRYPOINT (scripts/docker-entrypoint.sh) so it runs on EVERY start
# with NO command override needed — a fresh container self-applies the correct datasource. The
# entrypoint selects the provider from DATABASE_URL, runs `prisma db push`, then execs the CMD.
# NOTE for in-place image upgrades on command-freezing platforms (e.g. QNAP): see UPGRADING.md.
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]