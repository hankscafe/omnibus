// src/lib/library-roots.ts
import { prisma } from './db';

// Library root paths for containment checks, cached briefly. The cover route fires once per grid
// card (24+ per page), and each hit was its own `library.findMany` against the SQLite file the
// engine hammers during scans (issue #183). Roots change only when an admin edits libraries; a
// 30s lag there costs at most a placeholder cover until the cache rolls.
const TTL_MS = 30_000;

let cache: { roots: string[]; at: number } | null = null;

export async function getLibraryRoots(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.roots;
  const libraries = await prisma.library.findMany({ select: { path: true } });
  cache = { roots: libraries.map(l => l.path), at: Date.now() };
  return cache.roots;
}

// Test hook — module-level cache would otherwise leak between vitest cases.
export function resetLibraryRootsCache(): void {
  cache = null;
}
