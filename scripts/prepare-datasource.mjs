// Runtime datasource selector for the unified (dual-DB) build.
//
// Omnibus ships a single Prisma schema kept to the SQLite-compatible subset, so the SAME schema is
// valid for both providers — only the datasource `provider` line differs. The image is BUILT with
// the SQLite client (the zero-config default), so:
//   - DATABASE_URL is SQLite  → nothing to do; the baked client already matches (fast path).
//   - DATABASE_URL is Postgres → rewrite `provider` to "postgresql" and regenerate the client so
//     `server.js` loads a Postgres-dialect client from node_modules/.prisma/client.
//
// Runs at container start, BEFORE `prisma db push`. Uses only Node built-ins (the runtime image has
// no npm/npx). Fails LOUD and non-zero on a regenerate error so we never boot with a client whose
// dialect disagrees with the database.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SCHEMA = process.env.PRISMA_SCHEMA || '/app/prisma/schema.prisma';
const PRISMA_CLI = './node_modules/prisma/build/index.js';

const url = (process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('[prepare-datasource] DATABASE_URL is not set. Refusing to start.');
  process.exit(1);
}

const wantPostgres = /^postgres(ql)?:\/\//i.test(url);
const provider = wantPostgres ? 'postgresql' : 'sqlite';

let schema = readFileSync(SCHEMA, 'utf8');
const current = (schema.match(/provider\s*=\s*"(sqlite|postgresql)"/) || [])[1];

if (current === provider) {
  console.log(`[prepare-datasource] provider already "${provider}"; using the baked client.`);
  process.exit(0);
}

// Swap ONLY the datasource provider. The alternation can't match the generator's
// `provider = "prisma-client-js"`, and the datasource block appears first, so a single
// (non-global) replace targets exactly the datasource line.
schema = schema.replace(/provider\s*=\s*"(sqlite|postgresql)"/, `provider = "${provider}"`);
writeFileSync(SCHEMA, schema);
console.log(`[prepare-datasource] provider "${current}" -> "${provider}"; regenerating Prisma client...`);

try {
  execFileSync('node', [PRISMA_CLI, 'generate', `--schema=${SCHEMA}`], { stdio: 'inherit' });
  console.log('[prepare-datasource] client regenerated for postgresql.');
} catch (e) {
  console.error(`[prepare-datasource] prisma generate failed: ${e?.message ?? e}`);
  process.exit(1);
}
