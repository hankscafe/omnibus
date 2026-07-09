#!/bin/sh
# Omnibus web container entrypoint (dual-DB build).
#
# The datasource setup runs here, in the ENTRYPOINT, so it happens on EVERY start regardless of the
# container command. A fresh deployment therefore needs NO command override — the image self-heals:
# it selects the provider, applies the schema, then hands off to the default command (node server.js).
#
# CAVEAT for in-place image upgrades on platforms that FREEZE a container's command/entrypoint at
# creation (e.g. QNAP Container Station): updating the image keeps the frozen startup from the OLD
# image, so this entrypoint may not run. See UPGRADING.md — recreate the container, or add the
# provider-select step to the command override.
set -e
cd /app

# 1. Select the datasource provider from DATABASE_URL. SQLite (default) is baked at build time; a
#    postgres:// URL rewrites the Prisma datasource + regenerates the client (scripts/prepare-datasource.mjs).
node /app/scripts/prepare-datasource.mjs

# 2. Apply the schema. Provider-agnostic (no migration files); --skip-generate because
#    prepare-datasource already regenerated the correct client when the provider changed.
node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --skip-generate --accept-data-loss

# 3. Hand off to the container command (default: node server.js).
exec "$@"
