// src/lib/utils/db-search.ts
// Provider-aware case-insensitive `contains` for user-facing text search (beta.014).
//
// - Postgres: plain `contains` compiles to case-sensitive LIKE, so lowercase queries miss
//   Title-Case rows — Prisma's `mode: 'insensitive'` (ILIKE) is required.
// - SQLite: LIKE is already case-insensitive for ASCII, and the sqlite-generated Prisma client
//   REJECTS the `mode` argument at runtime ("Unknown argument `mode`") — it must be omitted.
//   (That rejection is what broke the issues-browse search on every standard install.)
//
// The provider is sniffed from DATABASE_URL at call time — file: → SQLite, postgres(ql):// →
// Postgres — mirroring scripts/prepare-datasource.mjs's runtime provider switch. Unset/unknown
// defaults to the SQLite shape, the shipped default.
export function ciContains(q: string, urlOverride?: string): { contains: string; mode?: 'insensitive' } {
    const url = (urlOverride ?? process.env.DATABASE_URL ?? '').trim().toLowerCase();
    return url.startsWith('postgres') ? { contains: q, mode: 'insensitive' } : { contains: q };
}
